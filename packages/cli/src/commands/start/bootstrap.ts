/**
 * Bootstrap phase: config loading, PID lockfile, AppContext creation,
 * Ed25519 keypair, user seeding, host registration, and crash recovery.
 */

import type { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import {
	copyFileSync,
	existsSync,
	mkdirSync,
	readFileSync,
	rmSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { seedSkillAuthoring } from "@bound/agent";
import type { AppContext } from "@bound/core";
import {
	createAppContext,
	insertRow,
	normalizeEdgeRelations,
	resetProcessing,
	updateRow,
	withChangeLog,
} from "@bound/core";
import { installAiSdkWarningHook } from "@bound/llm";
import {
	BOUND_NAMESPACE,
	createLogger,
	deterministicUUID,
	formatError,
	getBuildInfo,
	loadBuildInfo,
} from "@bound/shared";
import { clearColumnCache, ensureKeypair } from "@bound/sync";

// Build metadata (generated at compile time, gitignored). The shared loader
// idempotently dynamically-imports the generated file with a "dev"/"unknown"
// fallback when running from source.
await loadBuildInfo();
const { commitHash: COMMIT_HASH, buildTime: BUILD_TIME } = getBuildInfo();

const bootstrapLogger = createLogger("@bound/cli", "start-bootstrap");

/**
 * SQL run during crash recovery to release tasks the previous process left in
 * `status = 'running'` with a stale or missing heartbeat. Exported so tests can
 * prepare the exact same statement the bootstrap path uses — keeping production
 * and test in lockstep prevents the divergence that previously hid a syntax
 * error in this string.
 *
 * Kept on a single source line on purpose: the outbox-invariant validator
 * (`scripts/validate-outbox-invariant.ts`) only exempts the line containing the
 * `// outbox-exempt` marker, so the marker must sit on the same line as the
 * `UPDATE tasks` keyword. Splitting across lines via a template literal would
 * either leak `//` into the SQL string (the bug this constant was extracted to
 * prevent) or move the keyword onto an unmarked line that re-trips the validator.
 */
export const STALE_TASK_RESET_SQL =
	"UPDATE tasks SET status = 'pending', lease_id = NULL, claimed_by = NULL, claimed_at = NULL WHERE status = 'running' AND claimed_by = ? AND (heartbeat_at IS NULL OR heartbeat_at < ?)"; // outbox-exempt: crash recovery, scoped to booting host (R-LR10)

/**
 * Crash-recovery scan for threads whose last meaningful message is a tool_call
 * or tool_result with no following assistant turn or interrupt notice. Runs on
 * every daemon boot.
 *
 * Thread-centric form: one GROUP BY scan over `idx_messages_thread`, ~1k thread
 * groups on a typical deployment. The semantically-equivalent per-tool-message
 * form (DISTINCT m.thread_id with correlated NOT EXISTS) plans to ~150k indexed
 * lookups on a 185k-row messages table and runs in ~4s warm — historically a
 * meaningful chunk of bootstrap latency on slow disks. Profiled rewrite runs in
 * ~100ms.
 *
 * Equivalence: a tool message with no later assistant/interrupt notice is
 * exactly equivalent to "the last assistant/interrupt timestamp in the thread
 * is earlier than the last tool timestamp" (or absent). Verified against the
 * live DB and synthetic fixtures in startup-wiring.test.ts.
 *
 * Excludes threads with a pending `client_tool_call` in `dispatch_queue` —
 * those are waiting for client execution, not crashed server tools.
 */
export const INTERRUPTED_TOOL_USE_SCAN_SQL = `WITH thread_summary AS (
	SELECT thread_id,
		MAX(CASE WHEN role IN ('tool_call', 'tool_result') THEN created_at END) AS last_tool_at,
		MAX(CASE WHEN role = 'assistant' THEN created_at END) AS last_assistant_at,
		MAX(CASE
			WHEN role IN ('system', 'developer')
			 AND (content LIKE '%interrupted%' OR content LIKE '%cancelled%')
			THEN created_at
		END) AS last_interrupt_at
	FROM messages
	GROUP BY thread_id
)
SELECT ts.thread_id FROM thread_summary ts
WHERE ts.last_tool_at IS NOT NULL
  AND (ts.last_assistant_at IS NULL OR ts.last_assistant_at < ts.last_tool_at)
  AND (ts.last_interrupt_at IS NULL OR ts.last_interrupt_at < ts.last_tool_at)
  AND NOT EXISTS (
	SELECT 1 FROM dispatch_queue dq
	WHERE dq.thread_id = ts.thread_id
	  AND dq.event_type = 'client_tool_call'
	  AND dq.status IN ('pending', 'processing')
  )`;

export interface StartArgs {
	configDir?: string;
	/** If true, wipes the local DB and requests a full reseed from the hub. */
	reseed?: boolean;
}

export interface BootstrapResult {
	appContext: AppContext;
	keypair: Awaited<ReturnType<typeof ensureKeypair>>;
	configDir: string;
}

/**
 * Provision the mcp system user idempotently at startup.
 */
export function ensureMcpUser(db: Database, siteId: string): void {
	const now = new Date().toISOString();
	const mcpUserId = deterministicUUID(BOUND_NAMESPACE, "mcp");
	const existingMcpUser = db.query("SELECT id FROM users WHERE id = ?").get(mcpUserId) as {
		id: string;
	} | null;
	if (!existingMcpUser) {
		insertRow(
			db,
			"users",
			{
				id: mcpUserId,
				display_name: "mcp",
				platform_ids: null,
				first_seen_at: now,
				modified_at: now,
				deleted: 0,
			},
			siteId,
		);
	}
}

export async function initBootstrap(args: StartArgs): Promise<BootstrapResult> {
	const configDir = args.configDir || "config";
	// Data directory is assumed to be a sibling of the config directory, matching
	// the layout produced by `bound init` and the convention used by other
	// `boundctl` commands (drain, set-hub, sync-status, ...). When configDir is
	// the default "config", this resolves to `<cwd>/data` — identical to the
	// previous hard-coded behavior. When tests pass a temp-dir configDir, this
	// keeps the data/PID lockfile/keypair next to it instead of polluting cwd.
	const dataDir = join(dirname(resolve(configDir)), "data");

	bootstrapLogger.info("Starting Bound orchestrator", {
		commit: COMMIT_HASH,
		buildTime: BUILD_TIME,
	});

	// 0. If --reseed is set, back up the local database before wiping it.
	// The keypair (host.key / host.pub) is preserved — only bound.db goes.
	if (args.reseed) {
		const dbPath = join(dataDir, "bound.db");
		const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
		const backupPath = `${dbPath}.backup.${timestamp}`;

		// Back up the existing DB if present.
		if (existsSync(dbPath)) {
			// Warn if a previous .backup file already exists (old flat name) so
			// operators know they may have already lost an earlier backup.
			const oldFlatBackup = `${dbPath}.backup`;
			if (existsSync(oldFlatBackup)) {
				bootstrapLogger.warn(
					"--reseed: an older bound.db.backup already exists; previous backup may be overwritten if you run --reseed again with the old code",
				);
			}

			try {
				copyFileSync(dbPath, backupPath);
				bootstrapLogger.info(`--reseed: backed up local database to ${backupPath}`);
			} catch (err) {
				bootstrapLogger.warn("--reseed: failed to back up database, proceeding with wipe", {
					error: err instanceof Error ? err.message : String(err),
				});
			}
		}

		const walPath = `${dbPath}-wal`;
		const shmPath = `${dbPath}-shm`;
		for (const p of [dbPath, walPath, shmPath]) {
			try {
				unlinkSync(p);
			} catch {
				// File doesn't exist — not an error.
			}
		}
		bootstrapLogger.info("--reseed: wiped local database, will request full hub snapshot");
	}

	// 1. Load and validate all config files
	bootstrapLogger.info("Loading configuration");
	mkdirSync(dataDir, { recursive: true });

	// PID lockfile: prevent multiple bound processes from sharing the same data dir.
	// Two processes on the same DB + Discord bot token causes duplicate messages.
	const pidFile = join(dataDir, "bound.pid");
	if (existsSync(pidFile)) {
		const existingPid = Number.parseInt(readFileSync(pidFile, "utf-8").trim(), 10);
		if (!Number.isNaN(existingPid) && existingPid !== process.pid) {
			let alive = false;
			try {
				// signal 0 tests existence without killing
				process.kill(existingPid, 0);
				alive = true;
			} catch {
				// Process doesn't exist — stale lockfile
			}
			if (alive) {
				bootstrapLogger.error("Another bound process is already running", {
					existingPid,
					pidFile,
					hint: `If this is stale, remove ${pidFile} and try again.`,
				});
				process.exit(1);
			}
			bootstrapLogger.warn("Cleaning up stale PID lockfile", { existingPid });
		}
	}
	writeFileSync(pidFile, String(process.pid), "utf-8");

	// Remove lockfile on clean shutdown
	const removePidFile = () => {
		try {
			// Only remove if it's still our PID (guard against race with a new process)
			if (existsSync(pidFile) && readFileSync(pidFile, "utf-8").trim() === String(process.pid)) {
				rmSync(pidFile);
			}
		} catch {
			// Best-effort cleanup
		}
	};
	process.on("exit", removePidFile);
	process.on("SIGINT", () => {
		removePidFile();
		process.exit(0);
	});
	process.on("SIGTERM", () => {
		removePidFile();
		process.exit(0);
	});

	const dbPath = join(dataDir, "bound.db");

	let appContext: AppContext;
	try {
		appContext = createAppContext(resolve(configDir), dbPath);
		// Clear the column cache after applySchema has run, so long-running
		// agent processes pick up the new memory_edges.context column without restart.
		clearColumnCache();
		// Route AI SDK warnings (previously spilled straight to stderr via
		// console.warn) through the pino logger so they land in logs/bound.log.
		// Companion: `createLoggingFetch` in @bound/llm routes raw AI SDK
		// request bodies through pino at LOG_LEVEL=debug (see inference.ts).
		installAiSdkWarningHook(createLogger("@bound/llm", "ai-sdk"));
	} catch (error) {
		// Print a friendly message for the CLI path, then rethrow so callers
		// (including tests) can observe the failure. The CLI entrypoint catches
		// this and exits with code 1.
		bootstrapLogger.error("Configuration error", { error: formatError(error) });
		throw error;
	}

	// 2. Ensure Ed25519 keypair via @bound/sync
	appContext.logger.info("Initializing cryptography...");
	const keypair = await ensureKeypair(dataDir);
	// Update site_id in host_meta to the value derived from the Ed25519 public key.
	// On first startup, createAppContext generated a randomUUID placeholder because
	// the keypair did not yet exist. Now that the keypair is available, replace it.
	if (appContext.siteId !== keypair.siteId) {
		appContext.db.run("UPDATE host_meta SET value = ? WHERE key = 'site_id'", [keypair.siteId]);
		appContext.siteId = keypair.siteId;
		appContext.logger.info("Updated site_id from Ed25519 public key", {
			siteId: keypair.siteId,
		});
	}

	// 3-4. Database and DI container (initialized by createAppContext above)
	appContext.logger.info("Initializing database...");
	appContext.logger.info("Setting up services...");

	// 5. User seeding
	appContext.logger.info("Seeding users from allowlist...");
	{
		const now = new Date().toISOString();
		for (const [username, entry] of Object.entries(appContext.config.allowlist.users)) {
			const userId = deterministicUUID(BOUND_NAMESPACE, username);
			const existingUser = appContext.db.query("SELECT id FROM users WHERE id = ?").get(userId) as {
				id: string;
			} | null;

			if (!existingUser) {
				insertRow(
					appContext.db,
					"users",
					{
						id: userId,
						display_name: entry.display_name,
						platform_ids: entry.platforms ? JSON.stringify(entry.platforms) : null,
						first_seen_at: now,
						modified_at: now,
						deleted: 0,
					},
					appContext.siteId,
				);
			} else {
				// Update display_name and platforms if changed in allowlist
				updateRow(
					appContext.db,
					"users",
					userId,
					{
						display_name: entry.display_name,
						platform_ids: entry.platforms ? JSON.stringify(entry.platforms) : null,
						modified_at: now,
					},
					appContext.siteId,
				);
			}
		}
	}

	// 5.1 Provision mcp system user (idempotent)
	ensureMcpUser(appContext.db, appContext.siteId);

	// 5.5. Skill-authoring seeding
	try {
		seedSkillAuthoring(appContext.db, appContext.siteId);
	} catch (error) {
		appContext.logger.warn("[skills] Failed to seed skill-authoring skill", {
			error: String(error),
		});
	}

	// 5.6. Edge graph normalization (idempotent — no-op after first run)
	try {
		const normSummary = normalizeEdgeRelations(appContext.db, appContext.siteId);
		appContext.logger.info(
			"[edges] Normalized edge relations",
			normSummary as unknown as Record<string, unknown>,
		);
	} catch (error) {
		appContext.logger.warn("[edges] Failed to normalize edge relations", {
			error: error instanceof Error ? error.message : String(error),
		});
	}

	// 6. Host registration (via outbox for sync compliance)
	appContext.logger.info("Registering host...");
	{
		const now = new Date().toISOString();
		const existingHost = appContext.db
			.query("SELECT site_id FROM hosts WHERE site_id = ?")
			.get(appContext.siteId) as { site_id: string } | null;

		if (existingHost) {
			withChangeLog(appContext.db, appContext.siteId, () => {
				appContext.db.run(
					"UPDATE hosts SET host_name = ?, commit_hash = ?, online_at = ?, modified_at = ? WHERE site_id = ?", // outbox-routed: withChangeLog(db, siteId, callback) emits the changelog entry
					[appContext.hostName, COMMIT_HASH, now, now, appContext.siteId],
				);
				const updatedRow = appContext.db
					.query("SELECT * FROM hosts WHERE site_id = ?")
					.get(appContext.siteId) as Record<string, unknown>;
				return {
					tableName: "hosts" as const,
					rowId: appContext.siteId,
					rowData: updatedRow,
					result: undefined,
				};
			});
		} else {
			const hostRow = {
				site_id: appContext.siteId,
				host_name: appContext.hostName,
				commit_hash: COMMIT_HASH,
				online_at: now,
				modified_at: now,
				deleted: 0,
			};
			withChangeLog(appContext.db, appContext.siteId, () => {
				appContext.db.run(
					"INSERT INTO hosts (site_id, host_name, commit_hash, online_at, modified_at, deleted) VALUES (?, ?, ?, ?, ?, 0)", // outbox-routed: withChangeLog(db, siteId, callback) emits the changelog entry
					[appContext.siteId, appContext.hostName, COMMIT_HASH, now, now],
				);
				return {
					tableName: "hosts" as const,
					rowId: appContext.siteId,
					rowData: hostRow,
					result: undefined,
				};
			});
		}
	}

	// 7. Crash recovery scan
	appContext.logger.info("Scanning for crash recovery...");
	{
		const staleThreshold = new Date(Date.now() - 10 * 60 * 1000).toISOString();
		const staleRunning = appContext.db
			.query(
				`SELECT id FROM tasks
				 WHERE status = 'running'
				   AND claimed_by = ?
				   AND (heartbeat_at IS NULL OR heartbeat_at < ?)`,
			)
			.all(appContext.siteId, staleThreshold) as Array<{ id: string }>;

		if (staleRunning.length > 0) {
			appContext.db.query(STALE_TASK_RESET_SQL).run(appContext.siteId, staleThreshold);
			appContext.logger.info(
				`[recovery] Reset ${staleRunning.length} stale running task(s) to pending`,
			);
		} else {
			appContext.logger.info("[recovery] No crashed tasks found");
		}

		// Reset dispatch_queue entries left in 'processing' by a crashed inference
		const dispatchReset = resetProcessing(appContext.db);
		if (dispatchReset > 0) {
			appContext.logger.info(`[recovery] Reset ${dispatchReset} in-flight dispatch(es) to pending`);
		}

		// Recovery for client_tool_call entries: reset to pending with claimed_by = NULL
		// so reconnecting clients can be re-assigned on next connection
		const clientToolCallReset = (() => {
			const now = new Date().toISOString();
			appContext.db
				.prepare(
					`UPDATE dispatch_queue
				 SET status = 'pending', claimed_by = NULL, modified_at = ?
				 WHERE event_type = 'client_tool_call' AND status = 'processing'`,
				)
				.run(now);
			const row = appContext.db.query("SELECT changes() as c").get() as { c: number } | null;
			return row?.c ?? 0;
		})();
		if (clientToolCallReset > 0) {
			appContext.logger.info(
				`[recovery] Reset ${clientToolCallReset} orphaned client tool call(s) to pending`,
			);
		}

		// Log pending client tool calls found during bootstrap
		const clientToolCallThreads = appContext.db
			.prepare(
				`SELECT DISTINCT thread_id FROM dispatch_queue
				 WHERE event_type = 'client_tool_call' AND status IN ('pending', 'processing')`,
			)
			.all() as Array<{ thread_id: string }>;
		if (clientToolCallThreads.length > 0) {
			appContext.logger.info(
				`[recovery] Found pending client tool calls across ${clientToolCallThreads.length} thread(s) from prior server lifetime — will re-deliver on client reconnect`,
			);
		}

		// Scan for interrupted tool-use per R-E13. SQL is exported as
		// INTERRUPTED_TOOL_USE_SCAN_SQL so the regression tests can pin the same
		// query the daemon actually runs.
		const interruptedThreads = appContext.db.query(INTERRUPTED_TOOL_USE_SCAN_SQL).all() as Array<{
			thread_id: string;
		}>;

		if (interruptedThreads.length > 0) {
			const now = new Date().toISOString();
			for (const { thread_id } of interruptedThreads) {
				try {
					insertRow(
						appContext.db,
						"messages",
						{
							id: randomUUID(),
							thread_id: thread_id,
							role: "developer",
							content: `Agent response was interrupted on host ${appContext.hostName}. The previous tool interaction may be incomplete.`,
							model_id: null,
							tool_name: null,
							created_at: now,
							modified_at: now,
							host_origin: appContext.hostName,
							deleted: 0,
							exit_code: null,
							metadata: null,
						},
						appContext.siteId,
					);
				} catch (error) {
					appContext.logger.warn(
						`[recovery] Failed to insert interrupted tool message for thread ${thread_id}`,
						{ error: formatError(error) },
					);
				}
			}
			appContext.logger.info(
				`[recovery] Inserted interruption notices for ${interruptedThreads.length} thread(s)`,
			);
		}
	}

	return { appContext, keypair, configDir };
}
