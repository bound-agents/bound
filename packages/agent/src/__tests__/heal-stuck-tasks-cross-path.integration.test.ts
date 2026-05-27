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
import { STUCK_THRESHOLD, healStuckTasks } from "../scheduler";

describe("healStuckTasks: cross-path coverage (AC4.3)", () => {
	let tmpDir: string;
	let dbPath: string;
	let db: Database;
	let appContext: ReturnType<typeof createAppContext>;
	let siteId: string;

	beforeAll(() => {
		tmpDir = mkdtempSync(join(tmpdir(), "heal-stuck-tasks-cross-path-test-"));
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

	// Four failed-write paths, each paired with a different task type to test cross-path + per-type dispatch
	const FAILED_WRITE_FIXTURES = [
		{
			name: "eviction",
			taskType: "cron" as const,
			error: "evicted due to heartbeat timeout",
		},
		{
			name: "model-validation",
			taskType: "heartbeat" as const,
			error: "model validation failed: Model 'unknown' not available in current config",
		},
		{
			name: "soft-error",
			taskType: "event" as const,
			error: "Error: Task run completed with error field",
		},
		{
			name: "hard-error",
			taskType: "deferred" as const,
			error: "Error: Task encountered unexpected error during execution",
		},
	] as const;

	for (const fixture of FAILED_WRITE_FIXTURES) {
		it(`recovers wedge from ${fixture.name} path (${fixture.taskType} task)`, () => {
			cleanupDb();
			const taskId = randomUUID();
			const now = new Date();
			const nowStr = now.toISOString();
			const stuckTime = new Date(now.getTime() - STUCK_THRESHOLD - 60000).toISOString();

			// Determine trigger_spec based on task type
			let triggerSpec: string;
			switch (fixture.taskType) {
				case "cron":
					triggerSpec = "0 * * * *";
					break;
				case "heartbeat":
					// interval_ms must be >= 60_000, use 120_000 (2 min)
					triggerSpec = '{"interval_ms":120000}';
					break;
				case "event":
					triggerSpec = "webhook:bound";
					break;
				case "deferred":
					triggerSpec = "{}";
					break;
			}

			// Escape single quotes in error message for SQL
			const errorEscaped = fixture.error.replace(/'/g, "''");

			// Insert row using raw SQL (matching the pattern in heal-stuck-tasks.test.ts)
			db.exec(`
				INSERT INTO tasks (
					id, type, status, trigger_spec, payload, thread_id,
					claimed_by, claimed_at, lease_id, next_run_at, last_run_at,
					run_count, max_runs, requires, model_hint, no_history,
					inject_mode, depends_on, require_success, alert_threshold,
					consecutive_failures, event_depth, no_quiescence,
					heartbeat_at, result, error, created_at, created_by, modified_at, deleted
				) VALUES (
					'${taskId}', '${fixture.taskType}', 'failed', '${triggerSpec}', NULL, NULL,
					'peer-A', '${stuckTime}', 'lease-1', NULL, NULL,
					0, NULL, NULL, NULL, 0,
					'status', NULL, 0, 5,
					${fixture.taskType === "deferred" ? 1 : 0}, 0, 0,
					NULL, NULL, '${errorEscaped}', '${nowStr}', 'system', '${nowStr}', 0
				)
			`);

			// Run healer
			const recovered = healStuckTasks(db, appContext.logger, siteId, new Date());

			// Verify recovery count
			expect(recovered).toBe(1);

			const updatedTask = db
				.query(
					"SELECT status, claimed_by, claimed_at, lease_id, next_run_at, consecutive_failures FROM tasks WHERE id = ?",
				)
				.get(taskId) as Partial<Task> | undefined;

			// Task should be recovered to pending
			expect(updatedTask?.status).toBe("pending");

			// For non-heartbeat tasks: claim metadata should be cleared
			if (fixture.taskType !== "heartbeat") {
				expect(updatedTask?.claimed_by).toBeNull();
				expect(updatedTask?.claimed_at).toBeNull();
				expect(updatedTask?.lease_id).toBeNull();
			}
			// For heartbeat tasks: Phase 1 leaves claim metadata populated (see Task 2 note)
			// Phase 2 R-LR11 will clear it via updateRow

			// next_run_at must be set for cron, heartbeat, and deferred tasks
			// Event tasks only set next_run_at if there are unprocessed relay_inbox entries
			if (fixture.taskType === "event") {
				// Event tasks without relay_inbox entries may not set next_run_at
				// This is expected behavior in resetEventTask
			} else {
				expect(updatedTask?.next_run_at).not.toBeNull();
			}

			// For deferred tasks: verify backoff formula
			if (fixture.taskType === "deferred") {
				const nextRunMs = new Date(updatedTask?.next_run_at || "").getTime();
				const expectedMs = now.getTime() + 5_000; // DEFERRED_RETRY_BACKOFF_MS_DEFAULT = 5_000
				// Allow 1000ms tolerance for test execution time
				expect(Math.abs(nextRunMs - expectedMs)).toBeLessThan(1000);
			}

			// For heartbeat tasks: verify next_run_at is set
			if (fixture.taskType === "heartbeat") {
				expect(updatedTask?.next_run_at).not.toBeNull();
			}

			// Exactly one change_log entry should exist for this task
			// (Phase 2 R-LR11: rescheduleHeartbeat now routes through outbox)
			const changeLogEntries = db.query("SELECT * FROM change_log WHERE row_id = ?").all(taskId) as
				| Array<{ id: string; row_id: string; siteId: string }>
				| undefined;

			// All task types (including heartbeat) now use updateRow which creates changelog
			expect(changeLogEntries?.length).toBe(1);
		});
	}
});
