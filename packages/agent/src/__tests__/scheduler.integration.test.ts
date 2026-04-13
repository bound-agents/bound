import type { Database } from "bun:sqlite";
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentLoopResult } from "@bound/agent";
import { applySchema, type createAppContext, createDatabase } from "@bound/core";
import { TypedEventEmitter } from "@bound/shared";
import { cleanupTmpDir } from "@bound/shared/test-utils";
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
			siteId: randomUUID(),
			hostName: "test-host",
		};
	});

	afterAll(async () => {
		db.close();
		await cleanupTmpDir(tmpDir);
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
		const { stop } = scheduler.start(20); // Fast poll for testing

		// Wait for scheduler to complete the task
		await waitFor(
			() =>
				(
					db.query("SELECT status FROM tasks WHERE id = ?").get(taskId) as
						| { status: string }
						| undefined
				)?.status === "completed",
			{ message: "deferred task did not complete" },
		);

		stop();

		const updatedTask = db.query("SELECT status FROM tasks WHERE id = ?").get(taskId) as
			| { status: string }
			| undefined;

		expect(updatedTask).toBeDefined();
		expect(updatedTask?.status).toBe("completed");
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
		const { stop } = scheduler.start(20);

		// Cron tasks complete fast and get rescheduled back to pending,
		// so check run_count instead of status to detect completion.
		await waitFor(
			() =>
				((
					db.query("SELECT run_count FROM tasks WHERE id = ?").get(taskId) as {
						run_count: number;
					} | null
				)?.run_count ?? 0) > 0,
			{ message: "cron task did not complete" },
		);
		stop();

		const updatedTask = db
			.query("SELECT status, next_run_at, run_count FROM tasks WHERE id = ?")
			.get(taskId) as { status: string; next_run_at: string | null; run_count: number } | null;

		expect(updatedTask).not.toBeNull();
		expect(updatedTask?.run_count).toBeGreaterThan(0);
		// After completion, cron task is rescheduled to pending with new next_run_at
		expect(updatedTask?.next_run_at).not.toBe(initialNextRun);
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
		const { stop } = scheduler.start(20);

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

	it("does not overwrite task already claimed by another host", async () => {
		const taskId = randomUUID();
		const now = new Date();
		const nowStr = now.toISOString();
		const pastTime = new Date(now.getTime() - 60000).toISOString();

		// Insert a task that's already claimed by another host
		db.exec(`
			INSERT INTO tasks (
				id, type, status, trigger_spec, payload, thread_id,
				claimed_by, claimed_at, lease_id, next_run_at, last_run_at,
				run_count, max_runs, requires, model_hint, no_history,
				inject_mode, depends_on, require_success, alert_threshold,
				consecutive_failures, event_depth, no_quiescence,
				heartbeat_at, result, error, created_at, created_by, modified_at, deleted
			) VALUES (
				'${taskId}', 'deferred', 'claimed', 'in 10m', NULL, NULL,
				'other-host', '${nowStr}', NULL, '${pastTime}', NULL,
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
		const { stop } = scheduler.start(20);

		// Let a few ticks pass
		await sleep(60);
		stop();

		const task = db.query("SELECT status, claimed_by FROM tasks WHERE id = ?").get(taskId) as {
			status: string;
			claimed_by: string | null;
		} | null;

		// Task should still be claimed by the other host, not overwritten
		expect(task?.claimed_by).toBe("other-host");
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
		const { stop } = scheduler.start(20);

		// Host affinity mismatch — task stays pending; wait enough cycles to confirm
		await sleep(60);
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
				allowlist: { default_web_user: "test", users: { test: { display_name: "Test" } } },
				modelBackends: { backends: [], default: "" },
			},
		};

		// biome-ignore lint/suspicious/noExplicitAny: test mock
		const scheduler = new Scheduler(localCtx as any, agentLoopFactory);
		const { stop } = scheduler.start(20);

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

	it("reschedules cron tasks after heartbeat eviction", async () => {
		const taskId = randomUUID();
		const now = new Date();
		const nowStr = now.toISOString();
		// Heartbeat 6 minutes ago — past the 5-minute EVICTION_TIMEOUT
		const staleHeartbeat = new Date(now.getTime() - 360_000).toISOString();

		// Insert a cron task in 'running' state with a stale heartbeat
		db.exec(`
			INSERT INTO tasks (
				id, type, status, trigger_spec, payload, thread_id,
				claimed_by, claimed_at, lease_id, next_run_at, last_run_at,
				run_count, max_runs, requires, model_hint, no_history,
				inject_mode, depends_on, require_success, alert_threshold,
				consecutive_failures, event_depth, no_quiescence,
				heartbeat_at, result, error, created_at, created_by, modified_at, deleted
			) VALUES (
				'${taskId}', 'cron', 'running', '0 * * * *', NULL, NULL,
				'test-host', '${nowStr}', NULL, NULL, '${nowStr}',
				3, NULL, NULL, NULL, 0,
				'status', NULL, 0, 1,
				0, 0, 0,
				'${staleHeartbeat}', NULL, NULL, '${nowStr}', 'system', '${nowStr}', 0
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
		const { stop } = scheduler.start(20);

		// Wait for eviction to happen (phase0 runs every tick)
		await waitFor(
			() =>
				(db.query("SELECT status FROM tasks WHERE id = ?").get(taskId) as { status: string } | null)
					?.status !== "running",
			{ message: "cron task was not evicted" },
		);
		stop();

		const task = db
			.query("SELECT status, next_run_at, consecutive_failures, error FROM tasks WHERE id = ?")
			.get(taskId) as {
			status: string;
			next_run_at: string | null;
			consecutive_failures: number;
			error: string | null;
		} | null;

		expect(task).not.toBeNull();
		// Cron task should be rescheduled to pending, NOT stuck in failed
		expect(task?.status).toBe("pending");
		expect(task?.next_run_at).not.toBeNull();
		// consecutive_failures should be incremented
		expect(task?.consecutive_failures).toBe(1);
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
				allowlist: { default_web_user: "test", users: { test: { display_name: "Test" } } },
				modelBackends: { backends: [], default: "" },
			},
		};

		// biome-ignore lint/suspicious/noExplicitAny: test mock
		const scheduler = new Scheduler(localCtx as any, agentLoopFactory);
		const { stop } = scheduler.start(20);

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

	// DEFERRED_RETRY_BACKOFF_MS is 5s per consecutive failure — these tests need > 5s wall time.
	// bun:test default timeout is 5s, so we extend to 20s.
	it("auto-retries failed deferred tasks up to DEFERRED_MAX_RETRIES", async () => {
		const taskId = randomUUID();
		const now = new Date();
		const pastTime = new Date(now.getTime() - 60000).toISOString();
		const nowStr = now.toISOString();

		// Ensure operator user exists (scheduler creates threads referencing this user)
		const operatorUserId = require("@bound/shared").deterministicUUID(
			require("@bound/shared").BOUND_NAMESPACE,
			"test",
		);
		db.exec(`
			INSERT OR IGNORE INTO users (id, display_name, platform_ids, first_seen_at, modified_at, deleted)
			VALUES ('${operatorUserId}', 'Test Operator', NULL, '${nowStr}', '${nowStr}', 0)
		`);

		// Insert deferred task with 0 consecutive failures
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
				'status', NULL, 0, 5,
				0, 0, 0,
				NULL, NULL, NULL, '${nowStr}', 'system', '${nowStr}', 0
			)
		`);

		let runCount = 0;
		const agentLoopFactory = (): { run: () => Promise<AgentLoopResult> } => ({
			run: async (): Promise<AgentLoopResult> => {
				runCount++;
				// Fail on first attempt, succeed on second
				if (runCount === 1) {
					return {
						messagesCreated: 0,
						toolCallsMade: 0,
						filesChanged: 0,
						error: "LLM silence timeout: no chunk received for 60000ms",
					};
				}
				return {
					messagesCreated: 1,
					toolCallsMade: 0,
					filesChanged: 0,
				};
			},
		});

		// biome-ignore lint/suspicious/noExplicitAny: test mock
		const scheduler = new Scheduler(appContext as any, agentLoopFactory, {
			retryBackoffMs: 50,
			basePollIntervalMs: 20,
		});
		const { stop } = scheduler.start(20);

		// Wait for the task to complete (should fail once, retry, then succeed)
		await waitFor(
			() =>
				(
					db.query("SELECT status FROM tasks WHERE id = ?").get(taskId) as {
						status: string;
					} | null
				)?.status === "completed",
			{ message: "deferred task did not auto-retry and complete", timeoutMs: 3000 },
		);
		stop();

		const finalTask = db
			.query("SELECT status, run_count, consecutive_failures FROM tasks WHERE id = ?")
			.get(taskId) as {
			status: string;
			run_count: number;
			consecutive_failures: number;
		} | null;

		expect(finalTask).not.toBeNull();
		expect(finalTask?.status).toBe("completed");
		// Should have run twice (first fail + retry success)
		expect(runCount).toBe(2);
		// consecutive_failures resets to 0 on success
		expect(finalTask?.consecutive_failures).toBe(0);
	}, 5_000);

	it("stops retrying deferred tasks after DEFERRED_MAX_RETRIES", async () => {
		const taskId = randomUUID();
		const now = new Date();
		const pastTime = new Date(now.getTime() - 60000).toISOString();
		const nowStr = now.toISOString();

		// Insert deferred task already at max-1 consecutive failures
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
				1, NULL, NULL, NULL, 0,
				'status', NULL, 0, 5,
				1, 0, 0,
				NULL, NULL, NULL, '${nowStr}', 'system', '${nowStr}', 0
			)
		`);

		const agentLoopFactory = (): { run: () => Promise<AgentLoopResult> } => ({
			run: async (): Promise<AgentLoopResult> => ({
				messagesCreated: 0,
				toolCallsMade: 0,
				filesChanged: 0,
				error: "Some transient error",
			}),
		});

		// biome-ignore lint/suspicious/noExplicitAny: test mock
		const scheduler = new Scheduler(appContext as any, agentLoopFactory, {
			retryBackoffMs: 50,
			basePollIntervalMs: 20,
		});
		const { stop } = scheduler.start(20);

		// Wait for the task to be marked as failed (should NOT retry since at max)
		await waitFor(
			() => {
				const t = db
					.query("SELECT status, consecutive_failures FROM tasks WHERE id = ?")
					.get(taskId) as { status: string; consecutive_failures: number } | null;
				// After this run, consecutive_failures will be 2 (was 1 + 1 from this failure)
				// DEFERRED_MAX_RETRIES = 2, so it should stay failed
				return t?.status === "failed" && t.consecutive_failures >= 2;
			},
			{ message: "task did not reach final failure state", timeoutMs: 3000 },
		);
		stop();

		const finalTask = db
			.query("SELECT status, consecutive_failures FROM tasks WHERE id = ?")
			.get(taskId) as { status: string; consecutive_failures: number } | null;

		expect(finalTask).not.toBeNull();
		expect(finalTask?.status).toBe("failed");
		expect(finalTask?.consecutive_failures).toBe(2);
	}, 5_000);
});
