import type { Database } from "bun:sqlite";
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentLoopResult } from "@bound/agent";
import { applySchema, type createAppContext, createDatabase } from "@bound/core";
import { TypedEventEmitter } from "@bound/shared";
import { Scheduler } from "../scheduler";

describe("Scheduler Integration", () => {
	let tmpDir: string;
	let dbPath: string;
	let db: Database;
	let appContext: ReturnType<typeof createAppContext>;

	beforeAll(() => {
		tmpDir = mkdtempSync(join(tmpdir(), "scheduler-integration-test-"));
		dbPath = join(tmpDir, "test.db");

		db = createDatabase(dbPath);
		applySchema(db);

		appContext = {
			db,
			config: {
				allowlist: [],
				model_backends: [],
			},
			optionalConfig: {
				mcp_servers: [],
			},
			eventBus: new TypedEventEmitter(),
			logger: {
				info: () => {},
				warn: () => {},
				error: () => {},
			},
			siteId: randomUUID(),
			hostName: "test-host",
		};
	});

	afterAll(() => {
		db.close();
		rmSync(tmpDir, { recursive: true });
	});

	it("runs deferred tasks with next_run_at in the past", async () => {
		const taskId = randomUUID();
		const userId = randomUUID();
		const now = new Date();
		const pastTime = new Date(now.getTime() - 60000).toISOString();
		const nowStr = now.toISOString();

		// Insert user
		db.exec(`
			INSERT INTO users (id, display_name, discord_id, first_seen_at, modified_at, deleted)
			VALUES ('${userId}', 'Test User', NULL, '${nowStr}', '${nowStr}', 0)
		`);

		// Insert thread
		const threadId = randomUUID();
		db.exec(`
			INSERT INTO threads (id, user_id, interface, host_origin, color, title, summary, summary_through, summary_model_id, extracted_through, created_at, last_message_at, modified_at, deleted)
			VALUES ('${threadId}', '${userId}', 'web', 'test', 0, 'Test Thread', NULL, NULL, NULL, NULL, '${nowStr}', '${nowStr}', '${nowStr}', 0)
		`);

		// Insert deferred task
		db.exec(`
			INSERT INTO tasks (
				id, type, status, trigger_spec, payload, thread_id,
				claimed_by, claimed_at, lease_id, next_run_at, last_run_at,
				run_count, max_runs, requires, model_hint, no_history,
				inject_mode, depends_on, require_success, alert_threshold,
				consecutive_failures, event_depth, no_quiescence,
				heartbeat_at, result, error, created_at, created_by, modified_at, deleted
			) VALUES (
				'${taskId}', 'deferred', 'pending', 'in 10m', NULL, '${threadId}',
				NULL, NULL, NULL, '${pastTime}', NULL,
				0, NULL, NULL, NULL, 0,
				'status', NULL, 0, 5,
				0, 0, 0,
				NULL, NULL, NULL, '${nowStr}', 'system', '${nowStr}', 0
			)
		`);

		const agentLoopFactory = (): { run: () => Promise<AgentLoopResult> } => {
			return {
				run: async (): Promise<AgentLoopResult> => ({
					messagesCreated: 1,
					toolCallsMade: 0,
					filesChanged: 0,
				}),
			};
		};

		// biome-ignore lint/suspicious/noExplicitAny: test mock
		const scheduler = new Scheduler(appContext as any, agentLoopFactory);
		const { stop } = scheduler.start(100); // Fast poll for testing

		// Wait for scheduler to run the task
		await new Promise((resolve) => setTimeout(resolve, 1000));

		stop();

		// Check that the task was claimed and/or run
		const updatedTask = db.query("SELECT status FROM tasks WHERE id = ?").get(taskId) as
			| { status: string }
			| undefined;

		expect(updatedTask).toBeDefined();
		// Task should be running or completed
		expect(["running", "completed"]).toContain(updatedTask?.status);
	});

	it("computes next_run_at for cron tasks", async () => {
		const taskId = randomUUID();
		const now = new Date();
		const nowStr = now.toISOString();
		const initialNextRun = nowStr;

		// Insert cron task
		db.exec(`
			INSERT INTO tasks (
				id, type, status, trigger_spec, payload, thread_id,
				claimed_by, claimed_at, lease_id, next_run_at, last_run_at,
				run_count, max_runs, requires, model_hint, no_history,
				inject_mode, depends_on, require_success, alert_threshold,
				consecutive_failures, event_depth, no_quiescence,
				heartbeat_at, result, error, created_at, created_by, modified_at, deleted
			) VALUES (
				'${taskId}', 'cron', 'pending', '0 * * * *', NULL, NULL,
				NULL, NULL, NULL, '${initialNextRun}', NULL,
				0, NULL, NULL, NULL, 0,
				'status', NULL, 0, 5,
				0, 0, 0,
				NULL, NULL, NULL, '${nowStr}', 'system', '${nowStr}', 0
			)
		`);

		const agentLoopFactory = (): { run: () => Promise<AgentLoopResult> } => ({
			run: async (): Promise<AgentLoopResult> => ({
				messagesCreated: 0,
				toolCallsMade: 0,
				filesChanged: 0,
			}),
		});

		// biome-ignore lint/suspicious/noExplicitAny: test mock
		const scheduler = new Scheduler(appContext as any, agentLoopFactory);
		const { stop } = scheduler.start(100);

		await new Promise((resolve) => setTimeout(resolve, 1000));
		stop();

		// After running, the task should have next_run_at updated to the next hour
		const updatedTask = db
			.query("SELECT status, next_run_at FROM tasks WHERE id = ?")
			.get(taskId) as { status: string; next_run_at: string | null } | undefined;

		expect(updatedTask).toBeDefined();
		// Verify that next_run_at was actually changed (not the same as initial)
		expect(updatedTask!.next_run_at).not.toBe(initialNextRun);
		expect(updatedTask!.next_run_at).not.toBeNull();
	});

	it("respects task dependencies", async () => {
		const depTaskId = randomUUID();
		const depTaskId2 = randomUUID();
		const taskId = randomUUID();
		const now = new Date().toISOString();
		const pastTime = new Date(Date.now() - 60000).toISOString();

		// Insert dependency tasks
		db.exec(`
			INSERT INTO tasks (
				id, type, status, trigger_spec, payload, thread_id,
				claimed_by, claimed_at, lease_id, next_run_at, last_run_at,
				run_count, max_runs, requires, model_hint, no_history,
				inject_mode, depends_on, require_success, alert_threshold,
				consecutive_failures, event_depth, no_quiescence,
				heartbeat_at, result, error, created_at, created_by, modified_at, deleted
			) VALUES (
				'${depTaskId}', 'deferred', 'completed', 'in 10m', NULL, NULL,
				NULL, NULL, NULL, NULL, NULL,
				1, NULL, NULL, NULL, 0,
				'status', NULL, 0, 5,
				0, 0, 0,
				NULL, NULL, NULL, '${now}', 'system', '${now}', 0
			)
		`);

		db.exec(`
			INSERT INTO tasks (
				id, type, status, trigger_spec, payload, thread_id,
				claimed_by, claimed_at, lease_id, next_run_at, last_run_at,
				run_count, max_runs, requires, model_hint, no_history,
				inject_mode, depends_on, require_success, alert_threshold,
				consecutive_failures, event_depth, no_quiescence,
				heartbeat_at, result, error, created_at, created_by, modified_at, deleted
			) VALUES (
				'${depTaskId2}', 'deferred', 'completed', 'in 10m', NULL, NULL,
				NULL, NULL, NULL, NULL, NULL,
				1, NULL, NULL, NULL, 0,
				'status', NULL, 0, 5,
				0, 0, 0,
				NULL, NULL, NULL, '${now}', 'system', '${now}', 0
			)
		`);

		// Insert dependent task
		db.exec(`
			INSERT INTO tasks (
				id, type, status, trigger_spec, payload, thread_id,
				claimed_by, claimed_at, lease_id, next_run_at, last_run_at,
				run_count, max_runs, requires, model_hint, no_history,
				inject_mode, depends_on, require_success, alert_threshold,
				consecutive_failures, event_depth, no_quiescence,
				heartbeat_at, result, error, created_at, created_by, modified_at, deleted
			) VALUES (
				'${taskId}', 'deferred', 'pending', 'in 10m', NULL, NULL,
				NULL, NULL, NULL, '${pastTime}', NULL,
				0, NULL, NULL, NULL, 0,
				'status', '${JSON.stringify([depTaskId, depTaskId2])}', 0, 5,
				0, 0, 0,
				NULL, NULL, NULL, '${now}', 'system', '${now}', 0
			)
		`);

		const agentLoopFactory = (): { run: () => Promise<AgentLoopResult> } => ({
			run: async (): Promise<AgentLoopResult> => ({
				messagesCreated: 0,
				toolCallsMade: 0,
				filesChanged: 0,
			}),
		});

		// biome-ignore lint/suspicious/noExplicitAny: test mock
		const scheduler = new Scheduler(appContext as any, agentLoopFactory);
		const { stop } = scheduler.start(100);

		await new Promise((resolve) => setTimeout(resolve, 1000));
		stop();

		const task = db.query("SELECT status FROM tasks WHERE id = ?").get(taskId) as
			| { status: string }
			| undefined;

		// Task should have progressed beyond pending (dependencies were satisfied)
		expect(task).toBeDefined();
		expect(task!.status).not.toBe("pending");
	});

	it("handles host affinity constraints", async () => {
		const taskId = randomUUID();
		const now = new Date().toISOString();
		const pastTime = new Date(Date.now() - 60000).toISOString();

		// Insert task requiring a different host
		db.exec(`
			INSERT INTO tasks (
				id, type, status, trigger_spec, payload, thread_id,
				claimed_by, claimed_at, lease_id, next_run_at, last_run_at,
				run_count, max_runs, requires, model_hint, no_history,
				inject_mode, depends_on, require_success, alert_threshold,
				consecutive_failures, event_depth, no_quiescence,
				heartbeat_at, result, error, created_at, created_by, modified_at, deleted
			) VALUES (
				'${taskId}', 'deferred', 'pending', 'in 10m', NULL, NULL,
				NULL, NULL, NULL, '${pastTime}', NULL,
				0, NULL, '${JSON.stringify({ host: "other-host" })}', NULL, 0,
				'status', NULL, 0, 5,
				0, 0, 0,
				NULL, NULL, NULL, '${now}', 'system', '${now}', 0
			)
		`);

		const agentLoopFactory = (): { run: () => Promise<AgentLoopResult> } => ({
			run: async (): Promise<AgentLoopResult> => ({
				messagesCreated: 0,
				toolCallsMade: 0,
				filesChanged: 0,
			}),
		});

		// biome-ignore lint/suspicious/noExplicitAny: test mock
		const scheduler = new Scheduler(appContext as any, agentLoopFactory);
		const { stop } = scheduler.start(100);

		await new Promise((resolve) => setTimeout(resolve, 1000));
		stop();

		const task = db.query("SELECT status FROM tasks WHERE id = ?").get(taskId) as
			| { status: string }
			| undefined;

		// Task should remain pending since host doesn't match
		expect(task?.status).toBe("pending");
	});
});
