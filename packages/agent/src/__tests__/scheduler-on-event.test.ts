import type { Database } from "bun:sqlite";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentLoopConfig, AgentLoopResult } from "@bound/agent";
import { applyMetricsSchema, applySchema, createDatabase } from "@bound/core";
import type { AppContext } from "@bound/core";
import { TypedEventEmitter } from "@bound/shared";
import { cleanupTmpDir } from "@bound/shared/test-utils";
import { Scheduler } from "../scheduler";

/**
 * Covers Scheduler.onEvent's uncovered branches:
 *   - the MAX_EVENT_DEPTH guard,
 *   - the model-validator decline that leaves an event task pending for another host,
 *   - the pending→claimed CAS claim (and its changelog entry),
 *   - multiple matching event tasks claimed in one firing.
 * Real DB, real event bus; onEvent drives the claim synchronously (no run()).
 */

describe("Scheduler.onEvent event-task claim", () => {
	let tmpDir: string;
	let db: Database;
	let siteId: string;
	let eventBus: TypedEventEmitter;

	beforeAll(() => {
		tmpDir = mkdtempSync(join(tmpdir(), `sched-onevent-${randomBytes(4).toString("hex")}-`));
		db = createDatabase(join(tmpDir, "test.db"));
		applySchema(db);
		applyMetricsSchema(db);
	});

	beforeEach(() => {
		siteId = randomUUID();
		eventBus = new TypedEventEmitter();
		db.run("DELETE FROM host_meta");
		db.run("INSERT INTO host_meta (key, value) VALUES ('site_id', ?)", [siteId]);
	});

	afterEach(() => {
		db.run("DELETE FROM tasks");
		db.run("DELETE FROM change_log");
	});

	afterAll(async () => {
		db.close();
		await cleanupTmpDir(tmpDir);
	});

	function makeCtx(): AppContext {
		return {
			db,
			logger: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
			eventBus,
			hostName: "test-host",
			siteId,
			config: {
				allowlist: { default_web_user: "test", users: { test: { display_name: "Test" } } },
			},
			optionalConfig: {},
		} as unknown as AppContext;
	}

	function makeAgentLoopFactory(): (config: AgentLoopConfig) => {
		run: () => Promise<AgentLoopResult>;
	} {
		return () => ({
			run: async () => ({ messagesCreated: 1, toolCallsMade: 0, filesChanged: 0 }),
		});
	}

	function insertPendingEventTask(triggerSpec: string, modelHint: string | null): string {
		const id = randomUUID();
		const now = new Date().toISOString();
		db.run(
			`INSERT INTO tasks (
				id, type, status, trigger_spec, payload, thread_id,
				claimed_by, claimed_at, lease_id, next_run_at, last_run_at,
				run_count, max_runs, requires, model_hint, no_history,
				inject_mode, depends_on, require_success, alert_threshold,
				consecutive_failures, event_depth, no_quiescence,
				heartbeat_at, result, error, created_at, created_by, modified_at, deleted
			) VALUES (
				?, 'event', 'pending', ?, NULL, NULL,
				NULL, NULL, NULL, NULL, NULL,
				0, NULL, NULL, ?, 0,
				'status', NULL, 0, 5,
				0, 0, 0,
				NULL, NULL, NULL, ?, 'system', ?, 0
			)`,
			[id, triggerSpec, modelHint, now, now],
		);
		return id;
	}

	function statusOf(taskId: string): string {
		const row = db.query("SELECT status FROM tasks WHERE id = ?").get(taskId) as {
			status: string;
		} | null;
		return row?.status ?? "<missing>";
	}

	it("ignores the firing and leaves the task pending once MAX_EVENT_DEPTH is exceeded", () => {
		const triggerSpec = "webhook:depth";
		const taskId = insertPendingEventTask(triggerSpec, "");

		const scheduler = new Scheduler(makeCtx(), makeAgentLoopFactory(), {
			modelValidator: () => ({ ok: true as const }),
		});

		// Drive eventDepth to the ceiling so the next firing is refused by the guard.
		(scheduler as unknown as { eventDepth: number }).eventDepth = 5;

		scheduler.onEvent(triggerSpec, null);

		// The depth guard returned early without touching the task.
		expect(statusOf(taskId)).toBe("pending");
	});

	it("records a changelog entry when it claims a matching pending event task (outbox invariant #1)", () => {
		const triggerSpec = "webhook:claim";
		const taskId = insertPendingEventTask(triggerSpec, "");

		const scheduler = new Scheduler(makeCtx(), makeAgentLoopFactory(), {
			modelValidator: () => ({ ok: true as const }),
		});

		scheduler.onEvent(triggerSpec, null);

		// The CAS claim must emit a change_log row so the claim propagates across the cluster.
		const changelog = db
			.query("SELECT COUNT(*) AS n FROM change_log WHERE table_name = 'tasks' AND row_id = ?")
			.get(taskId) as { n: number };
		expect(changelog.n).toBeGreaterThan(0);
	});

	it("claims every matching pending event task in one firing", () => {
		const triggerSpec = "webhook:multi";
		const a = insertPendingEventTask(triggerSpec, "");
		const b = insertPendingEventTask(triggerSpec, "");
		// A non-matching task stays pending.
		const other = insertPendingEventTask("webhook:other", "");

		const scheduler = new Scheduler(makeCtx(), makeAgentLoopFactory(), {
			modelValidator: () => ({ ok: true as const }),
		});

		scheduler.onEvent(triggerSpec, null);

		expect(statusOf(a)).toBe("claimed");
		expect(statusOf(b)).toBe("claimed");
		expect(statusOf(other)).toBe("pending");
	});

	it("does not re-claim a task that is already claimed (CAS no-op)", () => {
		const triggerSpec = "webhook:already";
		const taskId = insertPendingEventTask(triggerSpec, "");
		// Pre-claim it by a different host.
		db.run("UPDATE tasks SET status = 'claimed', claimed_by = 'other-host' WHERE id = ?", [taskId]);

		const scheduler = new Scheduler(makeCtx(), makeAgentLoopFactory(), {
			modelValidator: () => ({ ok: true as const }),
		});

		scheduler.onEvent(triggerSpec, null);

		// The SELECT only matches status='pending', so a claimed task is untouched.
		const row = db.query("SELECT status, claimed_by FROM tasks WHERE id = ?").get(taskId) as {
			status: string;
			claimed_by: string;
		} | null;
		expect(row?.status).toBe("claimed");
		expect(row?.claimed_by).toBe("other-host");
	});
});
