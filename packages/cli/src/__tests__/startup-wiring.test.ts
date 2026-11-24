/**
 * Startup wiring integration tests — exercised against a REAL in-process boot.
 *
 * The previous incarnation of this file replicated the bootstrap logic
 * (host registration, crash recovery, user seeding, stale-task reset) against a
 * hand-rolled database and asserted on the copy — the header openly admitted it
 * "cannot easily spy on it directly" so it "replicate[d] the key bootstrap
 * logic". That meant the assertions proved the *copy* worked, not the daemon.
 *
 * Now `bound start` is bootable in-process via `startNode(args, options) ->
 * NodeHandle`, so these tests boot the actual node (via `startNode`) and assert
 * bootstrap's observable side-effects on the node's own DB:
 *
 *   - host registration writes a `hosts` row AND a `change_log` entry (outbox),
 *   - user seeding inserts the allowlist operator via the outbox,
 *   - crash recovery resets this host's stale `running` tasks to `pending`,
 *   - crash recovery inserts an interruption notice for a thread whose last
 *     message is an unanswered tool turn owned by this host.
 *
 * Crash-recovery is observed by seeding the conditions into a booted node's DB,
 * stopping it, then booting a SECOND node on the SAME data dir — the second
 * boot's `initBootstrap` runs the recovery scan against the seeded rows, which
 * is exactly the production path. One keyring-less boot per condition keeps the
 * (slow) boot count modest; the host-registration/user-seeding facts share a
 * single boot.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { calculateTurnCost } from "@bound/agent";
import { insertRow } from "@bound/core";
import { cleanupTmpDir } from "@bound/shared/test-utils";
import { runInit } from "../commands/init.js";
import {
	INTERRUPTED_TOOL_USE_SCAN_SQL,
	STALE_TASK_RESET_SQL,
} from "../commands/start/bootstrap.js";
import { type NodeHandle, startNode } from "../commands/start/index.js";

/** Minimal OpenAI-compatible server on port 0 — never actually driven here. */
function startFakeOpenAiServer() {
	const server = Bun.serve({
		port: 0,
		hostname: "localhost",
		fetch() {
			return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
		},
	});
	return { baseUrl: `http://localhost:${server.port}/v1`, stop: () => server.stop(true) };
}

/** Lay down a real config dir pointing its single backend at `baseUrl`. */
async function writeConfig(configDir: string, baseUrl: string, operator: string): Promise<void> {
	await runInit({ ollama: true, name: operator, configDir });
	writeFileSync(
		join(configDir, "model_backends.js"),
		`export default ${JSON.stringify(
			{
				backends: [
					{
						id: "fake",
						provider: "openai-compatible",
						model: "fake-model",
						context_window: 8192,
						base_url: baseUrl,
						api_key: "test-key",
					},
				],
				default: "fake",
			},
			null,
			2,
		)};\n`,
	);
}

describe("Startup Wiring — real boot", () => {
	let tmpDir: string;
	let configDir: string;
	let fake: ReturnType<typeof startFakeOpenAiServer>;
	let node: NodeHandle;
	let siteId: string;
	let operatorName: string;

	beforeAll(async () => {
		tmpDir = mkdtempSync(join(tmpdir(), `startup-wiring-${randomBytes(4).toString("hex")}-`));
		configDir = join(tmpDir, "config");
		operatorName = "wiring-operator";
		fake = startFakeOpenAiServer();
		await writeConfig(configDir, fake.baseUrl, operatorName);

		node = await startNode(
			{ configDir },
			{ webPort: 0, syncPort: 0, webHost: "localhost", syncHost: "localhost" },
		);
		siteId = node.appContext.siteId;
	}, 60_000);

	afterAll(async () => {
		await node?.stop();
		fake?.stop();
		await cleanupTmpDir(tmpDir);
	});

	// -----------------------------------------------------------------------
	// Host registration (outbox pattern)
	// -----------------------------------------------------------------------
	describe("host registration", () => {
		it("writes a hosts row for this site after a real boot", () => {
			const host = node.appContext.db
				.query("SELECT site_id, host_name, work_spool_capable FROM hosts WHERE site_id = ?")
				.get(siteId) as { site_id: string; host_name: string; work_spool_capable: number } | null;
			expect(host?.site_id).toBe(siteId);
			// Bootstrap registers the host as work-spool capable (R-DW14 advertisement).
			expect(host?.work_spool_capable).toBe(1);
		});

		it("emits a change_log entry for the hosts row (outbox, not raw SQL)", () => {
			// Host registration goes through withChangeLog, so a change_log row for
			// the hosts table keyed on this site must exist — proof the write took
			// the synced outbox path rather than a raw INSERT.
			const entry = node.appContext.db
				.query(
					"SELECT table_name, row_id FROM change_log WHERE table_name = 'hosts' AND row_id = ? LIMIT 1",
				)
				.get(siteId) as { table_name: string; row_id: string } | null;
			expect(entry?.table_name).toBe("hosts");
			expect(entry?.row_id).toBe(siteId);
		});
	});

	// -----------------------------------------------------------------------
	// User seeding (outbox pattern)
	// -----------------------------------------------------------------------
	describe("user seeding", () => {
		it("seeds the allowlist operator as a users row via the outbox", () => {
			// init wrote an allowlist whose default_web_user is the operator name;
			// bootstrap seeds it into users. A change_log entry must accompany it.
			const user = node.appContext.db
				.query("SELECT id, display_name FROM users WHERE display_name = ?")
				.get(operatorName) as { id: string; display_name: string } | null;
			expect(user?.display_name).toBe(operatorName);

			const entry = node.appContext.db
				.query("SELECT row_id FROM change_log WHERE table_name = 'users' AND row_id = ? LIMIT 1")
				.get(user?.id ?? "") as { row_id: string } | null;
			expect(entry?.row_id).toBe(user?.id);
		});
	});

	// -----------------------------------------------------------------------
	// Bootstrap SQL constants are valid SQLite (contract pin)
	// -----------------------------------------------------------------------
	describe("bootstrap SQL constants", () => {
		it("STALE_TASK_RESET_SQL prepares cleanly against the live schema", () => {
			expect(() => node.appContext.db.prepare(STALE_TASK_RESET_SQL).finalize()).not.toThrow();
		});

		it("INTERRUPTED_TOOL_USE_SCAN_SQL prepares cleanly against the live schema", () => {
			expect(() =>
				node.appContext.db.prepare(INTERRUPTED_TOOL_USE_SCAN_SQL).finalize(),
			).not.toThrow();
		});
	});
});

describe("Startup Wiring — crash recovery on reboot", () => {
	let tmpDir: string;
	let configDir: string;
	let fake: ReturnType<typeof startFakeOpenAiServer>;

	beforeAll(async () => {
		tmpDir = mkdtempSync(join(tmpdir(), `startup-recovery-${randomBytes(4).toString("hex")}-`));
		configDir = join(tmpDir, "config");
		fake = startFakeOpenAiServer();
		await writeConfig(configDir, fake.baseUrl, "recovery-operator");
	}, 60_000);

	afterAll(async () => {
		fake?.stop();
		await cleanupTmpDir(tmpDir);
	});

	it("resets this host's stale running task to pending on the next boot", async () => {
		// First boot: establishes the data dir + DB + this host's stable siteId.
		const first = await startNode(
			{ configDir },
			{ webPort: 0, syncPort: 0, webHost: "localhost", syncHost: "localhost" },
		);
		const siteId = first.appContext.siteId;
		const db = first.appContext.db;

		// Seed a running task claimed by THIS host (a crashed prior incarnation).
		const taskId = randomUUID();
		const now = new Date().toISOString();
		insertRow(
			db,
			"tasks",
			{
				id: taskId,
				type: "cron",
				status: "running",
				trigger_spec: "0 * * * *",
				payload: null,
				created_at: now,
				created_by: siteId,
				thread_id: null,
				origin_thread_id: null,
				claimed_by: siteId,
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
			siteId,
		);
		await first.stop();

		// Second boot on the SAME data dir: initBootstrap's crash-recovery scan
		// must reset the own-claimed stale running task to pending.
		const second = await startNode(
			{ configDir },
			{ webPort: 0, syncPort: 0, webHost: "localhost", syncHost: "localhost" },
		);
		try {
			const row = second.appContext.db
				.query("SELECT status, claimed_by, lease_id FROM tasks WHERE id = ?")
				.get(taskId) as {
				status: string;
				claimed_by: string | null;
				lease_id: string | null;
			} | null;
			expect(row?.status).toBe("pending");
			expect(row?.claimed_by).toBeNull();
			expect(row?.lease_id).toBeNull();
		} finally {
			await second.stop();
		}
	}, 90_000);

	it("inserts an interruption notice for a thread whose last turn is an unanswered tool call by this host", async () => {
		const first = await startNode(
			{ configDir },
			{ webPort: 0, syncPort: 0, webHost: "localhost", syncHost: "localhost" },
		);
		const siteId = first.appContext.siteId;
		const hostName = first.appContext.hostName;
		const db = first.appContext.db;

		// A thread whose last message is a tool_result authored by THIS host with
		// no following assistant turn — the interrupted-tool-use condition.
		const threadId = randomUUID();
		const base = Date.now();
		const iso = (offsetMs: number) => new Date(base + offsetMs).toISOString();
		insertRow(
			db,
			"threads",
			{
				id: threadId,
				user_id: "system",
				interface: "web",
				host_origin: siteId,
				color: 0,
				title: "interrupted",
				summary: null,
				summary_through: null,
				summary_model_id: null,
				extracted_through: null,
				model_hint: null,
				created_at: iso(0),
				last_message_at: iso(20),
				modified_at: iso(20),
				deleted: 0,
			},
			siteId,
		);
		const mkMsg = (role: string, content: string, offset: number, toolName: string | null) => {
			insertRow(
				db,
				"messages",
				{
					id: randomUUID(),
					thread_id: threadId,
					role,
					content,
					model_id: null,
					tool_name: toolName,
					created_at: iso(offset),
					modified_at: iso(offset),
					host_origin: siteId,
					deleted: 0,
					exit_code: null,
					metadata: null,
				},
				siteId,
			);
		};
		mkMsg("user", "do the thing", 0, null);
		mkMsg("assistant", "calling a tool", 10, null);
		mkMsg("tool_result", "tool ran, awaiting next assistant turn", 20, "bms_bash");
		// Sanity: the scan the daemon runs selects this thread before reboot.
		const flagged = db.query(INTERRUPTED_TOOL_USE_SCAN_SQL).all(siteId) as Array<{
			thread_id: string;
		}>;
		expect(flagged.some((r) => r.thread_id === threadId)).toBe(true);

		await first.stop();

		const second = await startNode(
			{ configDir },
			{ webPort: 0, syncPort: 0, webHost: "localhost", syncHost: "localhost" },
		);
		try {
			// Crash recovery inserts a developer-role interruption notice naming this host.
			const notice = second.appContext.db
				.query(
					"SELECT role, content FROM messages WHERE thread_id = ? AND role = 'developer' AND content LIKE '%interrupted%' ORDER BY created_at DESC LIMIT 1",
				)
				.get(threadId) as { role: string; content: string } | null;
			expect(notice?.role).toBe("developer");
			expect(notice?.content).toContain(hostName);
		} finally {
			await second.stop();
		}
	}, 90_000);
});

describe("model_backends.js startup configuration", () => {
	it("loads JavaScript backends before creating the app context", async () => {
		const { loadStartupModelBackends } = await import("../commands/start/bootstrap");
		const configDir = mkdtempSync(join(tmpdir(), "startup-model-backends-"));
		try {
			await Bun.write(
				join(configDir, "model_backends.js"),
				`export default { default: "local", backends: [{ id: "local", provider: "openai-compatible", base_url: "http://localhost:11434/v1", model: "qwen", context_window: 8192, price(turn) { return turn.inputTokens / 100; } }] };`,
			);

			const config = await loadStartupModelBackends(configDir);
			expect(config.default).toBe("local");
			expect(
				calculateTurnCost(
					"local",
					{
						inputTokens: 100,
						outputTokens: 0,
						cacheReadTokens: 0,
						cacheWriteTokens: 0,
					},
					config.backends,
				),
			).toBe(1);
		} finally {
			await cleanupTmpDir(configDir);
		}
	});
});
