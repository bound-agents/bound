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

			// NOTE: In Phase 1, rescheduleHeartbeat is an outbox-exempt raw UPDATE
			// that does not clear claim metadata. The row is 'pending', so phase1
			// claiming will overwrite the stale columns on the next claim. This
			// becomes fully compliant after Phase 2 R-LR11 lands.
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
			// With consecutive_failures = 1 (pre-increment), the backoff is 1 * 5000 = 5000ms
			// Formula note: retryDeferredTask uses LINEAR backoff:
			// next_run_at = now + DEFERRED_RETRY_BACKOFF_MS * (consecutive_failures)
			// where consecutive_failures is the PRE-increment value passed to retryDeferredTask.
			// SEMANTIC DIFFERENCE: Phase 1 (healer, this test) uses pre-increment multiplication.
			// Phase 3 R-LR3 (eviction) uses post-increment: newConsecutiveFailures = prev + 1;
			// next_run_at = now + DEFERRED_RETRY_BACKOFF_MS * newConsecutiveFailures.
			// They differ by exactly DEFERRED_RETRY_BACKOFF_MS:
			// Phase 1: 1 * 5000 = 5000ms; Phase 3: (1+1) * 5000 = 10000ms.
			// When Phase 3 lands, this test must be updated to expect 10000ms for prev=1 OR
			// the Phase 1 helper must be migrated to post-increment for consistency.
			const expectedBackoffMs = DEFERRED_RETRY_BACKOFF_MS_DEFAULT * 1; // 1 * 5000
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
});
