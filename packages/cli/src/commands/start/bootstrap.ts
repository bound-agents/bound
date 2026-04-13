/**
 * Bootstrap phase: config loading, PID lockfile, AppContext creation,
 * Ed25519 keypair, user seeding, host registration, and crash recovery.
 */

import type { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { seedSkillAuthoring } from "@bound/agent";
import type { AppContext } from "@bound/core";
import {
	createAppContext,
	insertRow,
	resetProcessing,
	updateRow,
	withChangeLog,
} from "@bound/core";
import { BOUND_NAMESPACE, deterministicUUID, formatError } from "@bound/shared";
import { ensureKeypair } from "@bound/sync";

// Build metadata (generated at compile time)
let COMMIT_HASH = "dev";
let BUILD_TIME = "unknown";
try {
	const buildInfo = await import("../../build-info.js");
	COMMIT_HASH = buildInfo.COMMIT_HASH;
	BUILD_TIME = buildInfo.BUILD_TIME;
} catch {
	// Running from source without build — use dev values
}

export interface StartArgs {
	configDir?: string;
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

	console.log(`Starting Bound orchestrator (commit ${COMMIT_HASH}, built ${BUILD_TIME})...`);

	// 1. Load and validate all config files
	console.log("Loading configuration...");
	mkdirSync("data", { recursive: true });

	// PID lockfile: prevent multiple bound processes from sharing the same data dir.
	// Two processes on the same DB + Discord bot token causes duplicate messages.
	const pidFile = resolve("data", "bound.pid");
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
				console.error(
					`Another bound process is already running (PID ${existingPid}).\n` +
						`If this is stale, remove ${pidFile} and try again.`,
				);
				process.exit(1);
			}
			console.warn(`Cleaning up stale PID lockfile (previous PID ${existingPid}).`);
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

	const dbPath = resolve("data", "bound.db");

	let appContext: AppContext;
	try {
		appContext = createAppContext(resolve(configDir), dbPath);
	} catch (error) {
		// Print a friendly message for the CLI path, then rethrow so callers
		// (including tests) can observe the failure. The CLI entrypoint catches
		// this and exits with code 1.
		console.error("Configuration error:", formatError(error));
		throw error;
	}

	// 2. Ensure Ed25519 keypair via @bound/sync
	appContext.logger.info("Initializing cryptography...");
	const keypair = await ensureKeypair(resolve("data"));
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
					"UPDATE hosts SET host_name = ?, online_at = ?, modified_at = ? WHERE site_id = ?",
					[appContext.hostName, now, now, appContext.siteId],
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
				online_at: now,
				modified_at: now,
				deleted: 0,
			};
			withChangeLog(appContext.db, appContext.siteId, () => {
				appContext.db.run(
					"INSERT INTO hosts (site_id, host_name, online_at, modified_at, deleted) VALUES (?, ?, ?, ?, 0)",
					[appContext.siteId, appContext.hostName, now, now],
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
				   AND (heartbeat_at IS NULL OR heartbeat_at < ?)`,
			)
			.all(staleThreshold) as Array<{ id: string }>;

		if (staleRunning.length > 0) {
			appContext.db
				.query(
					`UPDATE tasks SET status = 'pending', lease_id = NULL, claimed_by = NULL, claimed_at = NULL
					 WHERE status = 'running'
					   AND (heartbeat_at IS NULL OR heartbeat_at < ?)`,
				)
				.run(staleThreshold);
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

		// Scan for interrupted tool-use per R-E13
		const interruptedThreads = appContext.db
			.query(
				`SELECT DISTINCT m.thread_id FROM messages m
				 WHERE m.role IN ('tool_call', 'tool_result')
				 AND NOT EXISTS (
					SELECT 1 FROM messages m2
					WHERE m2.thread_id = m.thread_id
					AND m2.created_at > m.created_at
					AND (m2.role = 'assistant'
					  OR (m2.role = 'system' AND (m2.content LIKE '%interrupted%' OR m2.content LIKE '%cancelled%')))
				 )`,
			)
			.all() as Array<{ thread_id: string }>;

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
							role: "system",
							content: `Agent response was interrupted on host ${appContext.hostName}. The previous tool interaction may be incomplete.`,
							model_id: null,
							tool_name: null,
							created_at: now,
							modified_at: now,
							host_origin: appContext.hostName,
							deleted: 0,
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
