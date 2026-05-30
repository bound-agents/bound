import type { Database } from "bun:sqlite";
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applySchema, type createAppContext, createDatabase } from "@bound/core";
import type { Task } from "@bound/shared";
import { TypedEventEmitter } from "@bound/shared";
import { cleanupTmpDir } from "@bound/shared/test-utils";
import { DEFERRED_RETRY_BACKOFF_MS_DEFAULT, STUCK_THRESHOLD, healStuckTasks } from "../scheduler";

describe("healStuckTasks", () => {
	let tmpDir: string;
	let dbPath: string;
	let db: Database;
	let appContext: ReturnType<typeof createAppContext>;
	let siteId: string;

	beforeAll(() => {
		tmpDir = mkdtempSync(join(tmpdir(), "heal-stuck-tasks-test-"));
		dbPath = join(tmpDir, "test.db");

		db = createDatabase(dbPath);
		applySchema(db);

		siteId = randomUUID();
		appContext = {
			db,
			config: {
				allowlist: { default_web_user: "test", users: { test: { display_name: "Test" } } },
				modelBackends: { backends: [], default: "" },
			},
			optionalConfig: {
				mcp_servers: [],
			},
			eventBus: new TypedEventEmitter(),
			logger: {
				debug: () => {},
				info: () => {},
				warn: () => {},
				error: () => {},
			},
			siteId,
			hostName: "test-host",
		};
	});

	const cleanupDb = () => {
		// Clear all tasks and change_log entries to avoid cross-test contamination
		db.exec("DELETE FROM change_log");
		db.exec("DELETE FROM tasks");
	};

	afterAll(async () => {
		db.close();
		await cleanupTmpDir(tmpDir);
	});

	describe("AC4.1: Success cases", () => {
		it("recovers a stuck cron task", () => {
			cleanupDb();
			const taskId = randomUUID();
			const now = new Date();
			const nowStr = now.toISOString();
			const stuckTime = new Date(now.getTime() - STUCK_THRESHOLD - 60000).toISOString();

			// Insert a cron task in failed state with stale claim metadata
			db.exec(`
				INSERT INTO tasks (
					id, type, status, trigger_spec, payload, thread_id,
					claimed_by, claimed_at, lease_id, next_run_at, last_run_at,
					run_count, max_runs, requires, model_hint, no_history,
					inject_mode, depends_on, require_success, alert_threshold,
					consecutive_failures, event_depth, no_quiescence,
					heartbeat_at, result, error, created_at, created_by, modified_at, deleted
				) VALUES (
					'${taskId}', 'cron', 'failed', '0 * * * *', NULL, NULL,
					'peer-A', '${stuckTime}', 'lease-1', NULL, NULL,
					0, NULL, NULL, NULL, 0,
					'status', NULL, 0, 5,
					0, 0, 0,
					NULL, NULL, 'test error', '${nowStr}', 'system', '${nowStr}', 0
				)
			`);

			// Run healer
			const recovered = healStuckTasks(db, appContext.logger, siteId, new Date());

			// Verify recovery
			expect(recovered).toBe(1);

			const updatedTask = db
				.query(
					"SELECT status, claimed_by, claimed_at, lease_id, next_run_at FROM tasks WHERE id = ?",
				)
				.get(taskId) as Partial<Task> | undefined;

			expect(updatedTask?.status).toBe("pending");
			expect(updatedTask?.claimed_by).toBeNull();
			expect(updatedTask?.claimed_at).toBeNull();
			expect(updatedTask?.lease_id).toBeNull();
			expect(updatedTask?.next_run_at).toBeDefined();
			expect(updatedTask?.next_run_at).not.toBeNull();

			// Verify exactly one change_log entry for this task
			const changeLogEntries = db
				.query("SELECT COUNT(*) as c FROM change_log WHERE row_id = ?")
				.get(taskId) as { c: number } | undefined;
			expect(changeLogEntries?.c).toBe(1);
		});

		it("recovers a stuck heartbeat task", () => {
			cleanupDb();
			const taskId = randomUUID();
			const now = new Date();
			const nowStr = now.toISOString();
			const stuckTime = new Date(now.getTime() - STUCK_THRESHOLD - 60000).toISOString();

			// Insert a heartbeat task in failed state with stale claim metadata
			db.exec(`
				INSERT INTO tasks (
					id, type, status, trigger_spec, payload, thread_id,
					claimed_by, claimed_at, lease_id, next_run_at, last_run_at,
					run_count, max_runs, requires, model_hint, no_history,
					inject_mode, depends_on, require_success, alert_threshold,
					consecutive_failures, event_depth, no_quiescence,
					heartbeat_at, result, error, created_at, created_by, modified_at, deleted
				) VALUES (
					'${taskId}', 'heartbeat', 'failed', '{"interval_ms":120000}', NULL, NULL,
					'peer-A', '${stuckTime}', 'lease-1', NULL, NULL,
					0, NULL, NULL, NULL, 0,
					'status', NULL, 0, 5,
					0, 0, 0,
					NULL, NULL, 'heartbeat error', '${nowStr}', 'system', '${nowStr}', 0
				)
			`);

			// Run healer
			const recovered = healStuckTasks(db, appContext.logger, siteId, new Date());

			// Verify recovery
			expect(recovered).toBe(1);

			const updatedTask = db
				.query("SELECT status, next_run_at FROM tasks WHERE id = ?")
				.get(taskId) as Partial<Task> | undefined;

			expect(updatedTask?.status).toBe("pending");
			expect(updatedTask?.next_run_at).toBeDefined();
			expect(updatedTask?.next_run_at).not.toBeNull();

			// NOTE: rescheduleHeartbeat now routes through outbox (Phase 2 R-LR11). It does not
			// clear claim metadata; the next phase1 claim CAS overwrites stale claim columns.
		});

		it("recovers a stuck event task", () => {
			cleanupDb();
			const taskId = randomUUID();
			const now = new Date();
			const nowStr = now.toISOString();
			const stuckTime = new Date(now.getTime() - STUCK_THRESHOLD - 60000).toISOString();

			// Insert an event task in failed state with stale claim metadata
			db.exec(`
				INSERT INTO tasks (
					id, type, status, trigger_spec, payload, thread_id,
					claimed_by, claimed_at, lease_id, next_run_at, last_run_at,
					run_count, max_runs, requires, model_hint, no_history,
					inject_mode, depends_on, require_success, alert_threshold,
					consecutive_failures, event_depth, no_quiescence,
					heartbeat_at, result, error, created_at, created_by, modified_at, deleted
				) VALUES (
					'${taskId}', 'event', 'failed', 'webhook:bound', NULL, NULL,
					'peer-A', '${stuckTime}', 'lease-1', NULL, NULL,
					0, NULL, NULL, NULL, 0,
					'status', NULL, 0, 5,
					0, 0, 0,
					NULL, NULL, 'event error', '${nowStr}', 'system', '${nowStr}', 0
				)
			`);

			// Run healer
			const recovered = healStuckTasks(db, appContext.logger, siteId, new Date());

			// Verify recovery
			expect(recovered).toBe(1);

			const updatedTask = db
				.query(
					"SELECT status, claimed_by, claimed_at, lease_id, next_run_at FROM tasks WHERE id = ?",
				)
				.get(taskId) as Partial<Task> | undefined;

			expect(updatedTask?.status).toBe("pending");
			expect(updatedTask?.claimed_by).toBeNull();
			expect(updatedTask?.claimed_at).toBeNull();
			expect(updatedTask?.lease_id).toBeNull();

			// Verify exactly one change_log entry for this task
			const changeLogEntries = db
				.query("SELECT COUNT(*) as c FROM change_log WHERE row_id = ?")
				.get(taskId) as { c: number } | undefined;
			expect(changeLogEntries?.c).toBe(1);
		});

		it("recovers a stuck deferred task with backoff formula", () => {
			cleanupDb();
			const taskId = randomUUID();
			const now = new Date();
			const nowStr = now.toISOString();
			const stuckTime = new Date(now.getTime() - STUCK_THRESHOLD - 60000).toISOString();

			// Insert a deferred task in failed state with consecutive_failures = 1
			db.exec(`
				INSERT INTO tasks (
					id, type, status, trigger_spec, payload, thread_id,
					claimed_by, claimed_at, lease_id, next_run_at, last_run_at,
					run_count, max_runs, requires, model_hint, no_history,
					inject_mode, depends_on, require_success, alert_threshold,
					consecutive_failures, event_depth, no_quiescence,
					heartbeat_at, result, error, created_at, created_by, modified_at, deleted
				) VALUES (
					'${taskId}', 'deferred', 'failed', 'in 10m', NULL, NULL,
					'peer-A', '${stuckTime}', 'lease-1', NULL, NULL,
					0, NULL, NULL, NULL, 0,
					'status', NULL, 0, 5,
					1, 0, 0,
					NULL, NULL, 'deferred error', '${nowStr}', 'system', '${nowStr}', 0
				)
			`);

			// Run healer
			const beforeTime = Date.now();
			const recovered = healStuckTasks(db, appContext.logger, siteId, new Date());

			// Verify recovery
			expect(recovered).toBe(1);

			const updatedTask = db
				.query(
					"SELECT status, claimed_by, claimed_at, lease_id, next_run_at FROM tasks WHERE id = ?",
				)
				.get(taskId) as Partial<Task> | undefined;

			expect(updatedTask?.status).toBe("pending");
			expect(updatedTask?.claimed_by).toBeNull();
			expect(updatedTask?.claimed_at).toBeNull();
			expect(updatedTask?.lease_id).toBeNull();

			// Verify backoff formula: next_run_at = now + DEFERRED_RETRY_BACKOFF_MS * consecutive_failures
			// With consecutive_failures = 1 initially, after increment it becomes 2
			// RFC R-LR3 prescribes post-increment: next_run_at = now + DEFERRED_RETRY_BACKOFF_MS * (prev + 1)
			// Phase 3 resolved the Phase 1/3 divergence by migrating the healer to post-increment.
			// Both paths now use the same formula: retryBackoffMs * (consecutive_failures + 1).
			// For prev=1: (1+1) * 5000 = 10000ms
			const expectedBackoffMs = DEFERRED_RETRY_BACKOFF_MS_DEFAULT * 2; // 2 * 5000
			const expectedNextRunAt = new Date(beforeTime + expectedBackoffMs);
			const actualNextRunAt = updatedTask?.next_run_at ? new Date(updatedTask.next_run_at) : null;

			expect(actualNextRunAt).toBeDefined();
			expect(actualNextRunAt).not.toBeNull();
			// Allow 1000ms tolerance for timing variations
			expect(
				Math.abs((actualNextRunAt?.getTime() ?? 0) - expectedNextRunAt.getTime()),
			).toBeLessThan(1000);

			// Verify exactly one change_log entry for this task
			const changeLogEntries = db
				.query("SELECT COUNT(*) as c FROM change_log WHERE row_id = ?")
				.get(taskId) as { c: number } | undefined;
			expect(changeLogEntries?.c).toBe(1);
		});
	});

	describe("AC4.2: Failure modes", () => {
		it("does not recover a task with recent claim (within threshold)", () => {
			cleanupDb();
			const taskId = randomUUID();
			const now = new Date();
			const nowStr = now.toISOString();
			// Set claimed_at to 5 minutes ago (well within the 20-minute threshold)
			const recentTime = new Date(now.getTime() - 5 * 60 * 1000).toISOString();

			db.exec(`
				INSERT INTO tasks (
					id, type, status, trigger_spec, payload, thread_id,
					claimed_by, claimed_at, lease_id, next_run_at, last_run_at,
					run_count, max_runs, requires, model_hint, no_history,
					inject_mode, depends_on, require_success, alert_threshold,
					consecutive_failures, event_depth, no_quiescence,
					heartbeat_at, result, error, created_at, created_by, modified_at, deleted
				) VALUES (
					'${taskId}', 'cron', 'failed', '0 * * * *', NULL, NULL,
					'peer-A', '${recentTime}', 'lease-1', NULL, NULL,
					0, NULL, NULL, NULL, 0,
					'status', NULL, 0, 5,
					0, 0, 0,
					NULL, NULL, 'test error', '${nowStr}', 'system', '${nowStr}', 0
				)
			`);

			// Run healer
			const recovered = healStuckTasks(db, appContext.logger, siteId, new Date());

			// Should not recover
			expect(recovered).toBe(0);

			const updatedTask = db
				.query("SELECT status, claimed_by FROM tasks WHERE id = ?")
				.get(taskId) as Partial<Task> | undefined;

			expect(updatedTask?.status).toBe("failed");
			expect(updatedTask?.claimed_by).toBe("peer-A");
		});

		it("does not recover a task with no claim metadata", () => {
			cleanupDb();
			const taskId = randomUUID();
			const now = new Date();
			const nowStr = now.toISOString();

			db.exec(`
				INSERT INTO tasks (
					id, type, status, trigger_spec, payload, thread_id,
					claimed_by, claimed_at, lease_id, next_run_at, last_run_at,
					run_count, max_runs, requires, model_hint, no_history,
					inject_mode, depends_on, require_success, alert_threshold,
					consecutive_failures, event_depth, no_quiescence,
					heartbeat_at, result, error, created_at, created_by, modified_at, deleted
				) VALUES (
					'${taskId}', 'event', 'failed', 'webhook:test', NULL, NULL,
					NULL, NULL, NULL, NULL, NULL,
					0, NULL, NULL, NULL, 0,
					'status', NULL, 0, 5,
					0, 0, 0,
					NULL, NULL, 'test error', '${nowStr}', 'system', '${nowStr}', 0
				)
			`);

			// Run healer
			const recovered = healStuckTasks(db, appContext.logger, siteId, new Date());

			// Should not recover (no claimed_by)
			expect(recovered).toBe(0);

			const updatedTask = db.query("SELECT status FROM tasks WHERE id = ?").get(taskId) as
				| Partial<Task>
				| undefined;

			expect(updatedTask?.status).toBe("failed");
		});
	});

	// #87: the heal predicate was `status IN ('failed', 'cancelled')` for ALL
	// task types. That carried two defects:
	//   1. retry-exhausted deferred tasks (consecutive_failures >=
	//      DEFERRED_MAX_RETRIES) stay `failed` + claimed forever — retryDeferredTask
	//      bails without clearing the claim — so the healer re-selected and
	//      re-WARNed them every cycle (the reported log spam).
	//   2. deliberately-cancelled cron/event/deferred tasks were re-dispatched
	//      (resurrected), contradicting the cancel. The 'cancelled' clause was
	//      only ever needed for heartbeats (uncancellable by design).
	// The fix makes the predicate type-aware. These tests pin the new behavior.
	describe("AC: #87 — terminal/cancelled rows are not re-healed", () => {
		// DEFERRED_MAX_RETRIES is 2; a deferred row with consecutive_failures >= 2
		// can no longer be retried (retryDeferredTask refuses at prev+1 > 2).
		const insertStuckTask = (
			taskId: string,
			type: string,
			status: string,
			consecutiveFailures: number,
			triggerSpec: string,
		) => {
			const now = new Date();
			const nowStr = now.toISOString();
			const stuckTime = new Date(now.getTime() - STUCK_THRESHOLD - 60000).toISOString();
			db.exec(`
				INSERT INTO tasks (
					id, type, status, trigger_spec, payload, thread_id,
					claimed_by, claimed_at, lease_id, next_run_at, last_run_at,
					run_count, max_runs, requires, model_hint, no_history,
					inject_mode, depends_on, require_success, alert_threshold,
					consecutive_failures, event_depth, no_quiescence,
					heartbeat_at, result, error, created_at, created_by, modified_at, deleted
				) VALUES (
					'${taskId}', '${type}', '${status}', '${triggerSpec}', NULL, NULL,
					'peer-A', '${stuckTime}', 'lease-1', NULL, NULL,
					0, NULL, NULL, NULL, 0,
					'status', NULL, 0, 5,
					${consecutiveFailures}, 0, 0,
					NULL, NULL, 'test error', '${nowStr}', 'system', '${nowStr}', 0
				)
			`);
		};

		it("still revives a cancelled heartbeat (uncancellable by design)", () => {
			cleanupDb();
			const taskId = randomUUID();
			insertStuckTask(taskId, "heartbeat", "cancelled", 0, '{"interval_ms":120000}');

			const recovered = healStuckTasks(db, appContext.logger, siteId, new Date());

			expect(recovered).toBe(1);
			const updated = db.query("SELECT status FROM tasks WHERE id = ?").get(taskId) as
				| Partial<Task>
				| undefined;
			expect(updated?.status).toBe("pending");
		});

		it("does not resurrect a cancelled cron task", () => {
			cleanupDb();
			const taskId = randomUUID();
			insertStuckTask(taskId, "cron", "cancelled", 0, "0 * * * *");

			const recovered = healStuckTasks(db, appContext.logger, siteId, new Date());

			expect(recovered).toBe(0);
			const updated = db.query("SELECT status, claimed_by FROM tasks WHERE id = ?").get(taskId) as
				| Partial<Task>
				| undefined;
			expect(updated?.status).toBe("cancelled");
			// Untouched — no change_log entry written for a terminal row.
			const changeLog = db
				.query("SELECT COUNT(*) as c FROM change_log WHERE row_id = ?")
				.get(taskId) as { c: number } | undefined;
			expect(changeLog?.c).toBe(0);
		});

		it("does not resurrect a cancelled deferred task", () => {
			cleanupDb();
			const taskId = randomUUID();
			// consecutive_failures = 0 → before the fix, retryDeferredTask (called
			// with prev+1 = 1 <= 2) would rewrite it to pending = resurrection.
			insertStuckTask(taskId, "deferred", "cancelled", 0, "in 10m");

			const recovered = healStuckTasks(db, appContext.logger, siteId, new Date());

			expect(recovered).toBe(0);
			const updated = db.query("SELECT status, claimed_by FROM tasks WHERE id = ?").get(taskId) as
				| Partial<Task>
				| undefined;
			expect(updated?.status).toBe("cancelled");
		});

		it("does not resurrect a cancelled event task", () => {
			cleanupDb();
			const taskId = randomUUID();
			insertStuckTask(taskId, "event", "cancelled", 0, "webhook:bound");

			const recovered = healStuckTasks(db, appContext.logger, siteId, new Date());

			expect(recovered).toBe(0);
			const updated = db.query("SELECT status FROM tasks WHERE id = ?").get(taskId) as
				| Partial<Task>
				| undefined;
			expect(updated?.status).toBe("cancelled");
		});

		it("does not re-select a retry-exhausted deferred task (no log spam)", () => {
			cleanupDb();
			const taskId = randomUUID();
			// consecutive_failures = 2 = DEFERRED_MAX_RETRIES → retryDeferredTask
			// refuses (prev+1 = 3 > 2). Before the fix this row stayed failed +
			// claimed and was re-WARNed every heal cycle.
			insertStuckTask(taskId, "deferred", "failed", 2, "in 10m");

			const recovered = healStuckTasks(db, appContext.logger, siteId, new Date());

			expect(recovered).toBe(0);
			const updated = db.query("SELECT status, claimed_by FROM tasks WHERE id = ?").get(taskId) as
				| Partial<Task>
				| undefined;
			// Left untouched in its terminal state — not re-dispatched, not re-logged.
			expect(updated?.status).toBe("failed");
			expect(updated?.claimed_by).toBe("peer-A");
		});

		it("still recovers a deferred task that has retries remaining", () => {
			cleanupDb();
			const taskId = randomUUID();
			// consecutive_failures = 1 < DEFERRED_MAX_RETRIES → genuinely recoverable.
			insertStuckTask(taskId, "deferred", "failed", 1, "in 10m");

			const recovered = healStuckTasks(db, appContext.logger, siteId, new Date());

			expect(recovered).toBe(1);
			const updated = db.query("SELECT status FROM tasks WHERE id = ?").get(taskId) as
				| Partial<Task>
				| undefined;
			expect(updated?.status).toBe("pending");
		});
	});
});
