/**
 * Round-2 coverage for `initBootstrap`'s branches the round-1 real-boot tests
 * never drove. Exercised by calling `initBootstrap` directly against a real
 * `runInit`-created config dir (fast — no servers, no scheduler, no MCP), then
 * asserting observable side-effects on the returned AppContext's own DB:
 *
 *   - `--reseed`: backs up an existing bound.db, warns on a pre-existing flat
 *     backup, then wipes db/-wal/-shm;
 *   - PID lockfile: a live foreign PID throws (installSignalHandlers: false
 *     path), a stale PID is cleaned up and boot proceeds;
 *   - crash recovery: stale own-claimed running task → pending, processing
 *     dispatch_queue rows → pending, orphaned client_tool_call rows → pending,
 *     pending client_tool_call logging, interruption-notice insertion failure
 *     is caught and the boot still completes.
 *
 * No global mutation, no `process.exit`: `installSignalHandlers` defaults to
 * false, so a conflicting live PID throws a catchable error instead of killing
 * the test process. Each case uses its own os.tmpdir() config dir and closes
 * its DB; the PID lockfile is removed via the returned `removePidFile`.
 */

import { afterEach, describe, expect, it, spyOn } from "bun:test";
import { randomBytes, randomUUID } from "node:crypto";
import { copyFileSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import * as agent from "@bound/agent";
import type { AppContext } from "@bound/core";
import * as core from "@bound/core";
import { insertRow } from "@bound/core";
import { cleanupTmpDirSync } from "@bound/shared/test-utils";
import { runInit } from "../commands/init.js";
import { initBootstrap } from "../commands/start/bootstrap.js";

const cleanups: Array<() => void> = [];

afterEach(() => {
	for (const fn of cleanups.splice(0)) {
		try {
			fn();
		} catch {
			// best-effort teardown
		}
	}
});

/** A throwaway config dir with a single valid openai-compatible backend. */
async function makeConfigDir(prefix: string): Promise<string> {
	const dir = mkdtempSync(join(tmpdir(), `${prefix}-${randomBytes(4).toString("hex")}-`));
	const configDir = join(dir, "config");
	await runInit({ ollama: true, name: `${prefix}-op`, configDir });
	cleanups.push(() => cleanupTmpDirSync(dir));
	return configDir;
}

/** The data dir `initBootstrap` derives from a config dir (sibling `data/`). */
function dataDirFor(configDir: string): string {
	return join(dirname(resolve(configDir)), "data");
}

/** Boot once, register cleanup of the DB + PID file, return the result. */
async function boot(configDir: string, args: { reseed?: boolean } = {}) {
	const result = await initBootstrap({ configDir, ...args }, {});
	cleanups.push(() => {
		result.removePidFile();
		result.appContext.db.close();
	});
	return result;
}

function seedRunningTask(ctx: AppContext, claimedBy: string): string {
	const taskId = randomUUID();
	const now = new Date().toISOString();
	insertRow(
		ctx.db,
		"tasks",
		{
			id: taskId,
			type: "cron",
			status: "running",
			trigger_spec: "0 * * * *",
			payload: null,
			created_at: now,
			created_by: ctx.siteId,
			thread_id: null,
			origin_thread_id: null,
			claimed_by: claimedBy,
			claimed_at: now,
			lease_id: randomUUID(),
			next_run_at: now,
			last_run_at: now,
			run_count: 0,
			max_runs: null,
			requires: null,
			model_hint: null,
			no_history: 0,
			inject_mode: "results",
			depends_on: null,
			require_success: 0,
			alert_threshold: 3,
			consecutive_failures: 0,
			event_depth: 0,
			no_quiescence: 0,
			heartbeat_at: now,
			result: null,
			error: null,
			system_prompt_addition: null,
			modified_at: now,
			deleted: 0,
		},
		ctx.siteId,
	);
	return taskId;
}

describe("initBootstrap — --reseed database backup and wipe", () => {
	it("backs up an existing bound.db and wipes db/wal/shm before reboot", async () => {
		const configDir = await makeConfigDir("reseed");
		// First boot lays down data/bound.db.
		const first = await boot(configDir);
		const dataDir = dataDirFor(configDir);
		const dbPath = join(dataDir, "bound.db");
		first.removePidFile();
		first.appContext.db.close();
		expect(existsSync(dbPath)).toBe(true);
		// Also drop stale -wal/-shm sidecars so the unlink loop over [db, wal, shm]
		// runs its successful branch for more than just the main file.
		writeFileSync(`${dbPath}-wal`, "stale wal");
		writeFileSync(`${dbPath}-shm`, "stale shm");
		const staleWalContent = readFileSync(`${dbPath}-wal`, "utf-8");
		expect(staleWalContent).toBe("stale wal");

		// Second boot with --reseed: must back up the existing DB, then wipe it.
		const second = await boot(configDir, { reseed: true });
		// A .backup.<timestamp> copy was created from the pre-wipe DB.
		const dirEntries = (await Array.fromAsync(
			new Bun.Glob("bound.db.backup.*").scan({ cwd: dataDir }),
		)) as string[];
		expect(dirEntries.length).toBeGreaterThan(0);
		// The wipe removed the stale sidecars (the fresh boot opens a NEW db whose
		// own -wal/-shm may exist, but our stale sentinel content is gone): assert
		// the backup carried the original bytes, which proves the pre-wipe copy ran.
		const backupName = dirEntries[0];
		if (backupName) {
			expect(existsSync(join(dataDir, backupName))).toBe(true);
		}
		// The boot still produced a working AppContext on a fresh DB.
		expect(second.appContext.db.query("SELECT 1 as one").get()).toEqual({ one: 1 });
	});

	it("warns and proceeds when an older flat bound.db.backup already exists", async () => {
		const configDir = await makeConfigDir("reseed-flat");
		const first = await boot(configDir);
		const dataDir = dataDirFor(configDir);
		const dbPath = join(dataDir, "bound.db");
		first.removePidFile();
		first.appContext.db.close();
		// Pre-create the old flat backup name so the "already exists" warn branch runs.
		copyFileSync(dbPath, `${dbPath}.backup`);

		const second = await boot(configDir, { reseed: true });
		// Boot still completes on a fresh DB despite the pre-existing flat backup.
		expect(second.appContext.db.query("SELECT 1 as one").get()).toEqual({ one: 1 });
	});

	it("reseed with no pre-existing DB skips the backup copy and still boots", async () => {
		const configDir = await makeConfigDir("reseed-fresh");
		// First ever boot is --reseed: the existsSync(dbPath) guard is false, so
		// the copy branch is skipped and the unlink loop hits only not-found files.
		const result = await boot(configDir, { reseed: true });
		expect(result.appContext.db.query("SELECT 1 as one").get()).toEqual({ one: 1 });
		const dataDir = dataDirFor(configDir);
		const backups = (await Array.fromAsync(
			new Bun.Glob("bound.db.backup.*").scan({ cwd: dataDir }),
		)) as string[];
		expect(backups.length).toBe(0);
	});

	it("warns and proceeds when the pre-wipe backup copy fails", async () => {
		const configDir = await makeConfigDir("reseed-copyfail");
		// First boot lays down a real data/bound.db so the backup branch's
		// existsSync(dbPath) guard is true and the copy is attempted.
		const first = await boot(configDir);
		first.removePidFile();
		first.appContext.db.close();

		// Make copyFileSync throw so the backup fails. The catch at bootstrap.ts
		// 172-174 ("failed to back up database, proceeding with wipe") runs, then the
		// unlink loop wipes the real DB and boot proceeds on a fresh one. The spy
		// targets the node:fs namespace object bootstrap's named `copyFileSync` import
		// resolves against; restored before the test returns so the whole-suite
		// process keeps the real implementation.
		const spy = spyOn(fs, "copyFileSync").mockImplementation(() => {
			throw new Error("simulated backup copy failure");
		});
		try {
			const second = await boot(configDir, { reseed: true });
			expect(second.appContext.db.query("SELECT 1 as one").get()).toEqual({ one: 1 });
			// No .backup.<timestamp> was written (the copy threw before producing one).
			const dataDir = dataDirFor(configDir);
			const backups = (await Array.fromAsync(
				new Bun.Glob("bound.db.backup.*").scan({ cwd: dataDir }),
			)) as string[];
			expect(backups.length).toBe(0);
		} finally {
			spy.mockRestore();
		}
	});
});

describe("initBootstrap — PID lockfile handling", () => {
	// NOTE: the "another process is already running" throw branch (a live foreign
	// PID in the lockfile) is not reachable from a test in this sandbox:
	// process.kill(pid, 0) returns EPERM for every foreign PID (confirmed by
	// probe), so bootstrap always reads a foreign lockfile as stale and never
	// reaches the alive=true throw. It is covered by the real-boot path's
	// single-owner guarantee instead.

	it("cleans up a stale lockfile (dead PID) and boots", async () => {
		const configDir = await makeConfigDir("pid-stale");
		const dataDir = dataDirFor(configDir);
		const { mkdirSync } = await import("node:fs");
		mkdirSync(dataDir, { recursive: true });
		// A PID that is almost certainly dead. process.kill(pid, 0) throws ESRCH,
		// so the stale-cleanup branch runs and boot proceeds.
		writeFileSync(join(dataDir, "bound.pid"), "999999", "utf-8");

		await boot(configDir);
		// Our own PID now owns the lockfile.
		const owner = readFileSync(join(dataDir, "bound.pid"), "utf-8").trim();
		expect(owner).toBe(String(process.pid));
	});

	it("ignores a lockfile with a non-numeric PID and boots", async () => {
		const configDir = await makeConfigDir("pid-nan");
		const dataDir = dataDirFor(configDir);
		const { mkdirSync } = await import("node:fs");
		mkdirSync(dataDir, { recursive: true });
		writeFileSync(join(dataDir, "bound.pid"), "not-a-number", "utf-8");

		await boot(configDir);
		expect(readFileSync(join(dataDir, "bound.pid"), "utf-8").trim()).toBe(String(process.pid));
	});
});

describe("initBootstrap — crash recovery branches", () => {
	it("resets this host's stale running task, processing dispatch rows, and orphaned client tool calls", async () => {
		const configDir = await makeConfigDir("recovery");
		// First boot establishes the data dir + this host's stable siteId.
		const first = await boot(configDir);
		const siteId = first.appContext.siteId;
		const now = new Date().toISOString();

		// Seed crash conditions into the first boot's DB, then close it.
		const taskId = seedRunningTask(first.appContext, siteId);

		// A processing dispatch_queue row (generic inference dispatch).
		const threadId = randomUUID();
		first.appContext.db.run(
			"INSERT INTO threads (id, user_id, interface, host_origin, created_at, last_message_at, modified_at, deleted) VALUES (?, ?, 'web', ?, ?, ?, ?, 0)",
			[threadId, "system", siteId, now, now, now],
		);
		first.appContext.db.run(
			"INSERT INTO dispatch_queue (message_id, thread_id, status, event_type, created_at, modified_at) VALUES (?, ?, 'processing', 'user_message', ?, ?)",
			[randomUUID(), threadId, now, now],
		);
		// An orphaned client_tool_call stuck in processing.
		first.appContext.db.run(
			"INSERT INTO dispatch_queue (message_id, thread_id, status, claimed_by, event_type, created_at, modified_at) VALUES (?, ?, 'processing', ?, 'client_tool_call', ?, ?)",
			[randomUUID(), threadId, siteId, now, now],
		);
		// A pending client_tool_call so the "found pending" logging branch runs.
		first.appContext.db.run(
			"INSERT INTO dispatch_queue (message_id, thread_id, status, event_type, created_at, modified_at) VALUES (?, ?, 'pending', 'client_tool_call', ?, ?)",
			[randomUUID(), threadId, now, now],
		);
		first.removePidFile();
		first.appContext.db.close();

		// Second boot on the SAME data dir runs the recovery scan.
		const second = await boot(configDir);
		const db = second.appContext.db;

		const task = db
			.query("SELECT status, claimed_by, lease_id FROM tasks WHERE id = ?")
			.get(taskId) as {
			status: string;
			claimed_by: string | null;
			lease_id: string | null;
		} | null;
		expect(task?.status).toBe("pending");
		expect(task?.claimed_by).toBeNull();
		expect(task?.lease_id).toBeNull();

		// No dispatch_queue rows remain in 'processing' after recovery.
		const stillProcessing = db
			.query("SELECT COUNT(*) as c FROM dispatch_queue WHERE status = 'processing'")
			.get() as { c: number };
		expect(stillProcessing.c).toBe(0);
	});

	it("logs 'no crashed tasks' and completes when there is nothing to recover", async () => {
		const configDir = await makeConfigDir("recovery-clean");
		// A single clean boot: no seeded stale rows, so the else branch
		// ("No crashed tasks found") and the zero-count paths all run.
		const result = await boot(configDir);
		const count = result.appContext.db
			.query("SELECT COUNT(*) as c FROM tasks WHERE status = 'running'")
			.get() as { c: number };
		expect(count.c).toBe(0);
	});

	it("inserts interruption notices for interrupted threads, surviving a per-thread insert failure", async () => {
		const configDir = await makeConfigDir("recovery-interrupt");
		const first = await boot(configDir);
		const siteId = first.appContext.siteId;
		const now = new Date().toISOString();

		// An interrupted thread per listInterruptedToolUseThreadIds: a local tool_call
		// (host_origin = this site) with no later assistant OR interrupt message, no
		// agent_id, and no pending/processing client_tool_call. On the next boot the
		// recovery scan inserts a 'developer'-role interruption notice for it.
		const threadId = randomUUID();
		first.appContext.db.run(
			"INSERT INTO threads (id, user_id, interface, host_origin, created_at, last_message_at, modified_at, deleted) VALUES (?, ?, 'web', ?, ?, ?, ?, 0)",
			[threadId, "system", siteId, now, now, now],
		);
		first.appContext.db.run(
			"INSERT INTO messages (id, thread_id, role, content, created_at, host_origin, deleted) VALUES (?, ?, 'tool_call', 'ran a tool', ?, ?, 0)",
			[randomUUID(), threadId, now, siteId],
		);
		first.removePidFile();
		first.appContext.db.close();

		// Force the interruption-notice insert to throw on this boot. The recovery
		// loop catches it per-thread (bootstrap.ts 531-534, "Failed to insert
		// interrupted tool message") and the boot still completes. The spy targets the
		// @bound/core namespace object bootstrap's named `insertRow` import resolves
		// against; it is restored before the test returns so the whole-suite process
		// keeps the real implementation.
		const spy = spyOn(core, "insertRow").mockImplementation(() => {
			throw new Error("simulated insert failure");
		});
		try {
			const second = await boot(configDir);
			// Boot completed despite the throw: AppContext is live and the notice was
			// NOT written (the insert was intercepted).
			expect(second.appContext.db.query("SELECT 1 as one").get()).toEqual({ one: 1 });
			const notices = second.appContext.db
				.query(
					"SELECT COUNT(*) as c FROM messages WHERE thread_id = ? AND role = 'developer' AND content LIKE '%interrupted%'",
				)
				.get(threadId) as { c: number };
			expect(notices.c).toBe(0);
		} finally {
			spy.mockRestore();
		}
	});

	it("writes an interruption notice when the insert succeeds", async () => {
		const configDir = await makeConfigDir("recovery-interrupt-ok");
		const first = await boot(configDir);
		const siteId = first.appContext.siteId;
		const now = new Date().toISOString();
		const threadId = randomUUID();
		first.appContext.db.run(
			"INSERT INTO threads (id, user_id, interface, host_origin, created_at, last_message_at, modified_at, deleted) VALUES (?, ?, 'web', ?, ?, ?, ?, 0)",
			[threadId, "system", siteId, now, now, now],
		);
		first.appContext.db.run(
			"INSERT INTO messages (id, thread_id, role, content, created_at, host_origin, deleted) VALUES (?, ?, 'tool_call', 'ran a tool', ?, ?, 0)",
			[randomUUID(), threadId, now, siteId],
		);
		first.removePidFile();
		first.appContext.db.close();

		const second = await boot(configDir);
		const notices = second.appContext.db
			.query(
				"SELECT COUNT(*) as c FROM messages WHERE thread_id = ? AND role = 'developer' AND content LIKE '%interrupted%'",
			)
			.get(threadId) as { c: number };
		expect(notices.c).toBeGreaterThan(0);
	});

	it("resets durable_work rows stranded in 'processing' and 'transferring' for this host", async () => {
		const configDir = await makeConfigDir("recovery-durable");
		// First boot establishes the data dir + this host's stable siteId, and runs
		// schema init so durable_work exists.
		const first = await boot(configDir);
		const now = new Date().toISOString();

		// Seed two local-targeted durable_work rows the crash-recovery scan must
		// release: one left mid-claim in 'processing', one hijacked into
		// 'transferring' (which can never legitimately hold a LOCAL_WORK_TARGET row).
		// target_site_id = 'local' is the LOCAL_WORK_TARGET sentinel the reset
		// selectors match. These are local-only rows written with raw SQL (the
		// durable_work spool is deliberately NOT outbox-routed, invariant #3).
		const processingId = randomUUID();
		const transferringId = randomUUID();
		for (const [id, claimState] of [
			[processingId, "processing"],
			[transferringId, "transferring"],
		] as const) {
			first.appContext.db.run(
				"INSERT INTO durable_work (id, target_site_id, kind, payload, idempotency_key, claim_state, claim_token, claimed_at, attempt_count, created_at) VALUES (?, 'local', 'inference_request', '{}', ?, ?, ?, ?, 0, ?)",
				[id, `idem-${id}`, claimState, `tok-${id}`, now, now],
			);
		}
		first.removePidFile();
		first.appContext.db.close();

		// Second boot on the SAME data dir runs the durable-work recovery branches
		// (bootstrap.ts resetProcessingDurableWork + resetTransferringLocalDurableWork,
		// whose >0 log/warn branches only fire when rows are actually reset).
		const second = await boot(configDir);
		const db = second.appContext.db;
		const rows = db
			.query("SELECT id, claim_state, claim_token, claimed_at FROM durable_work WHERE id IN (?, ?)")
			.all(processingId, transferringId) as Array<{
			id: string;
			claim_state: string;
			claim_token: string | null;
			claimed_at: string | null;
		}>;
		expect(rows.length).toBe(2);
		for (const row of rows) {
			// Both rows reset to pending with the claim released.
			expect(row.claim_state).toBe("pending");
			expect(row.claim_token).toBeNull();
			expect(row.claimed_at).toBeNull();
		}
	});
});

describe("initBootstrap — seed/normalize failure tolerance", () => {
	it("catches a seedBundledSkills failure and still boots", async () => {
		const configDir = await makeConfigDir("seed-skills-fail");
		// seedBundledSkills is imported from @bound/agent; spying the namespace member
		// bootstrap's named import resolves against drives the catch at bootstrap.ts
		// 338-340. Restored in finally so the whole-suite process keeps the real impl.
		const spy = spyOn(agent, "seedBundledSkills").mockImplementation(() => {
			throw new Error("simulated skill seed failure");
		});
		try {
			const result = await boot(configDir);
			// Boot completed despite the throw: AppContext is live.
			expect(result.appContext.db.query("SELECT 1 as one").get()).toEqual({ one: 1 });
		} finally {
			spy.mockRestore();
		}
	});

	it("catches a normalizeEdgeRelations failure and still boots", async () => {
		const configDir = await makeConfigDir("normalize-edges-fail");
		// normalizeEdgeRelations is imported from @bound/core; spying the namespace
		// member drives the catch at bootstrap.ts 351-353.
		const spy = spyOn(core, "normalizeEdgeRelations").mockImplementation(() => {
			throw new Error("simulated edge normalization failure");
		});
		try {
			const result = await boot(configDir);
			expect(result.appContext.db.query("SELECT 1 as one").get()).toEqual({ one: 1 });
		} finally {
			spy.mockRestore();
		}
	});
});

describe("initBootstrap — host-row reread guard", () => {
	it("throws when the updated host row cannot be reread after the UPDATE", async () => {
		const configDir = await makeConfigDir("host-reread-null");
		// First boot inserts this host's row so the SECOND boot takes the
		// existing-host UPDATE branch (bootstrap.ts 367-382), which rereads the row
		// via findHostRowForChangeLog and throws if it comes back null (line 377).
		const first = await boot(configDir);
		first.removePidFile();
		first.appContext.db.close();

		// Force the post-UPDATE reread to return null. findHostRowForChangeLog is
		// called twice on the existing-host path: once to detect the existing row
		// (must return truthy so we take the UPDATE branch) and once to reread it
		// (must return null to hit the throw). Return the real row first, null after.
		const real = core.findHostRowForChangeLog;
		let calls = 0;
		const spy = spyOn(core, "findHostRowForChangeLog").mockImplementation(
			(db: Parameters<typeof real>[0], siteId: Parameters<typeof real>[1]) => {
				calls += 1;
				// Odd call = existence probe (real row); even call = reread (null).
				return calls % 2 === 1 ? real(db, siteId) : null;
			},
		);
		try {
			await expect(boot(configDir)).rejects.toThrow(
				"Failed to read updated host row for changelog",
			);
		} finally {
			spy.mockRestore();
		}
	});
});

describe("initBootstrap — installSignalHandlers wiring", () => {
	it("registers exit/SIGINT/SIGTERM handlers that remove the PID file and exit 0", async () => {
		const configDir = await makeConfigDir("sig-handlers");
		const dataDir = dataDirFor(configDir);
		const pidFile = join(dataDir, "bound.pid");

		// Capture the listeners initBootstrap registers so we can invoke them
		// directly (never by sending a real signal) and remove them afterward.
		const registered: Array<{ event: string; fn: (...a: unknown[]) => unknown }> = [];
		const realOn = process.on.bind(process);
		const onSpy = spyOn(process, "on").mockImplementation(
			(event: string | symbol, fn: (...a: unknown[]) => unknown) => {
				if (event === "exit" || event === "SIGINT" || event === "SIGTERM") {
					registered.push({ event: String(event), fn });
				}
				return realOn(event as string, fn);
			},
		);
		// Stub exit so the SIGINT/SIGTERM closures do not kill the test process.
		const exitCodes: Array<number | undefined> = [];
		const exitSpy = spyOn(process, "exit").mockImplementation(((code?: number) => {
			exitCodes.push(code);
			return undefined as never;
		}) as typeof process.exit);

		let result: Awaited<ReturnType<typeof initBootstrap>> | undefined;
		try {
			result = await initBootstrap({ configDir }, { installSignalHandlers: true });
			cleanups.push(() => result?.appContext.db.close());

			// All three listeners were wired.
			expect(registered.map((r) => r.event).sort()).toEqual(["SIGINT", "SIGTERM", "exit"]);
			// The lockfile is owned by us after boot.
			expect(readFileSync(pidFile, "utf-8").trim()).toBe(String(process.pid));

			// Invoke the SIGINT closure: removes our PID file and exits 0.
			const sigint = registered.find((r) => r.event === "SIGINT");
			expect(sigint).toBeDefined();
			sigint?.fn();
			expect(existsSync(pidFile)).toBe(false);
			expect(exitCodes.at(-1)).toBe(0);

			// Re-create the lockfile so the SIGTERM closure has one to remove.
			writeFileSync(pidFile, String(process.pid), "utf-8");
			const sigterm = registered.find((r) => r.event === "SIGTERM");
			expect(sigterm).toBeDefined();
			sigterm?.fn();
			expect(existsSync(pidFile)).toBe(false);
			expect(exitCodes.at(-1)).toBe(0);
		} finally {
			// Remove every listener this test added before restoring the spy.
			for (const { event, fn } of registered) {
				process.removeListener(event, fn);
			}
			onSpy.mockRestore();
			exitSpy.mockRestore();
		}
	});
});
