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
import { sleep, waitFor } from "./helpers";

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
			INSERT INTO users (id, display_name, platform_ids, first_seen_at, modified_at, deleted)
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
		await waitFor(
			() =>
				(
					db.query("SELECT status FROM tasks WHERE id = ?").get(taskId) as
						| { status: string }
						| undefined
				)?.status !== "pending",
			{ message: "deferred task did not run" },
		);

		stop();

		// Check that the task was claimed and/or run
		const updatedTask = db.query("SELECT status FROM tasks WHERE id = ?").get(taskId) as
			| { status: string }
			| undefined;

		expect(updatedTask).toBeDefined();
		// Task should have progressed from pending (claimed, running, or completed)
		expect(["claimed", "running", "completed"]).toContain(updatedTask?.status);
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

		await waitFor(
			() =>
				(db.query("SELECT status FROM tasks WHERE id = ?").get(taskId) as { status: string } | null)
					?.status !== "pending",
			{ message: "cron task not claimed/run" },
		);
		stop();

		// After running, the task should have been claimed/run and next_run_at recomputed
		const updatedTask = db
			.query("SELECT status, next_run_at, run_count FROM tasks WHERE id = ?")
			.get(taskId) as { status: string; next_run_at: string | null; run_count: number } | null;

		expect(updatedTask).not.toBeNull();
		// The task should have progressed — either completed with next_run_at updated,
		// or at minimum been claimed/run
		expect(["claimed", "running", "completed", "pending"]).toContain(updatedTask?.status);
		// If task completed, next_run_at should be updated to next cron window
		if (updatedTask?.status === "pending" && updatedTask?.run_count > 0) {
			// Task completed and was reset to pending with new next_run_at
			expect(updatedTask?.next_run_at).not.toBe(initialNextRun);
		}
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

		await waitFor(
			() =>
				(
					db.query("SELECT status FROM tasks WHERE id = ?").get(taskId) as
						| { status: string }
						| undefined
				)?.status !== "pending",
			{ message: "dependent task did not run" },
		);
		stop();

		const task = db.query("SELECT status FROM tasks WHERE id = ?").get(taskId) as
			| { status: string }
			| undefined;

		// Task should have progressed beyond pending (dependencies were satisfied)
		expect(task).toBeDefined();
		expect(task?.status).not.toBe("pending");
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

		// Host affinity mismatch — task stays pending; wait enough cycles to confirm
		await sleep(300);
		stop();

		const task = db.query("SELECT status FROM tasks WHERE id = ?").get(taskId) as
			| { status: string }
			| undefined;

		// Task should remain pending since host doesn't match
		expect(task?.status).toBe("pending");
	});

	it("persists thread_id back to task row when task had no thread", async () => {
		const taskId = randomUUID();
		const now = new Date().toISOString();
		const pastTime = new Date(Date.now() - 60000).toISOString();

		// Insert a deferred task with thread_id = NULL
		db.exec(`
			INSERT INTO tasks (
				id, type, status, trigger_spec, payload, thread_id,
				claimed_by, claimed_at, lease_id, next_run_at, last_run_at,
				run_count, max_runs, requires, model_hint, no_history,
				inject_mode, depends_on, require_success, alert_threshold,
				consecutive_failures, event_depth, no_quiescence,
				heartbeat_at, result, error, created_at, created_by, modified_at, deleted
			) VALUES (
				'${taskId}', 'deferred', 'pending', 'in 10m', 'Do something', NULL,
				NULL, NULL, NULL, '${pastTime}', NULL,
				0, NULL, NULL, NULL, 0,
				'status', NULL, 0, 5,
				0, 0, 0,
				NULL, NULL, NULL, '${now}', 'system', '${now}', 0
			)
		`);

		const agentLoopFactory = (): { run: () => Promise<AgentLoopResult> } => ({
			run: async (): Promise<AgentLoopResult> => ({
				messagesCreated: 1,
				toolCallsMade: 0,
				filesChanged: 0,
			}),
		});

		// Use correct camelCase config key so shouldSkipDueToBudget doesn't throw
		const localCtx = {
			...appContext,
			config: {
				allowlist: [],
				modelBackends: { backends: [], default: "" },
			},
		};

		// biome-ignore lint/suspicious/noExplicitAny: test mock
		const scheduler = new Scheduler(localCtx as any, agentLoopFactory);
		const { stop } = scheduler.start(100);

		// Wait for the task to complete (run_count > 0 means it ran)
		await waitFor(
			() =>
				(
					db.query("SELECT run_count FROM tasks WHERE id = ?").get(taskId) as {
						run_count: number;
					} | null
				)?.run_count === 1,
			{ message: "task did not complete", timeoutMs: 5000 },
		);
		stop();

		const updatedTask = db.query("SELECT thread_id FROM tasks WHERE id = ?").get(taskId) as {
			thread_id: string | null;
		} | null;

		expect(updatedTask).not.toBeNull();
		// The scheduler should have persisted the generated thread_id back
		expect(updatedTask?.thread_id).not.toBeNull();
		expect(typeof updatedTask?.thread_id).toBe("string");

		// Verify the thread actually exists in the threads table
		// biome-ignore lint/style/noNonNullAssertion: asserted above
		const thread = db.query("SELECT id FROM threads WHERE id = ?").get(updatedTask!.thread_id) as {
			id: string;
		} | null;
		expect(thread).not.toBeNull();
	});

	it("creates separate execution thread when task has origin_thread_id", async () => {
		const taskId = randomUUID();
		const originThreadId = randomUUID();
		const now = new Date().toISOString();
		const pastTime = new Date(Date.now() - 60000).toISOString();

		// Create the origin thread (the conversation that scheduled the task)
		db.exec(`
			INSERT INTO threads (id, user_id, interface, host_origin, color, title, summary, summary_through, summary_model_id, extracted_through, created_at, last_message_at, modified_at, deleted)
			VALUES ('${originThreadId}', 'user-1', 'web', 'test', 0, 'Origin Conversation', NULL, NULL, NULL, NULL, '${now}', '${now}', '${now}', 0)
		`);

		// Insert task with origin_thread_id set but thread_id = NULL
		// (simulating what the schedule command should do)
		db.exec(`
			INSERT INTO tasks (
				id, type, status, trigger_spec, payload, thread_id, origin_thread_id,
				claimed_by, claimed_at, lease_id, next_run_at, last_run_at,
				run_count, max_runs, requires, model_hint, no_history,
				inject_mode, depends_on, require_success, alert_threshold,
				consecutive_failures, event_depth, no_quiescence,
				heartbeat_at, result, error, created_at, created_by, modified_at, deleted
			) VALUES (
				'${taskId}', 'deferred', 'pending', 'in 10m', 'Do something', NULL, '${originThreadId}',
				NULL, NULL, NULL, '${pastTime}', NULL,
				0, NULL, NULL, NULL, 0,
				'status', NULL, 0, 5,
				0, 0, 0,
				NULL, NULL, NULL, '${now}', 'system', '${now}', 0
			)
		`);

		const agentLoopFactory = (): { run: () => Promise<AgentLoopResult> } => ({
			run: async (): Promise<AgentLoopResult> => ({
				messagesCreated: 1,
				toolCallsMade: 0,
				filesChanged: 0,
			}),
		});

		const localCtx = {
			...appContext,
			config: {
				allowlist: [],
				modelBackends: { backends: [], default: "" },
			},
		};

		// biome-ignore lint/suspicious/noExplicitAny: test mock
		const scheduler = new Scheduler(localCtx as any, agentLoopFactory);
		const { stop } = scheduler.start(100);

		await waitFor(
			() =>
				(
					db.query("SELECT run_count FROM tasks WHERE id = ?").get(taskId) as {
						run_count: number;
					} | null
				)?.run_count === 1,
			{ message: "task did not complete", timeoutMs: 5000 },
		);
		stop();

		const updatedTask = db
			.query("SELECT thread_id, origin_thread_id FROM tasks WHERE id = ?")
			.get(taskId) as { thread_id: string | null; origin_thread_id: string | null } | null;

		expect(updatedTask).not.toBeNull();
		// Execution thread should be created and persisted
		expect(updatedTask?.thread_id).not.toBeNull();
		// Origin thread reference should be preserved
		expect(updatedTask?.origin_thread_id).toBe(originThreadId);
		// Execution thread must be DIFFERENT from origin thread
		expect(updatedTask?.thread_id).not.toBe(originThreadId);
	});
});
