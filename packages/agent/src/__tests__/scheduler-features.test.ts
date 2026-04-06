/**
 * Scheduler feature integration tests.
 *
 * Verifies that key scheduler features are actually wired and functional:
 * - Quiescence multiplier modifies poll interval
 * - Daily budget checking gates autonomous task execution
 * - Task failure produces an alert message
 * - Cron templates execute via sandbox
 * - seedCronTasks seeds from config
 */

import type { Database } from "bun:sqlite";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentLoopConfig, AgentLoopResult } from "@bound/agent";
import { applyMetricsSchema, applySchema, createDatabase, recordTurn } from "@bound/core";
import type { AppContext } from "@bound/core";
import { TypedEventEmitter } from "@bound/shared";
import { cleanupTmpDir } from "@bound/shared/test-utils";
import { Scheduler } from "../scheduler";
import { seedCronTasks } from "../task-resolution";
import { sleep, waitFor } from "./helpers";

describe("Scheduler features", () => {
	let tmpDir: string;
	let db: Database;
	let siteId: string;
	let eventBus: TypedEventEmitter;

	beforeAll(() => {
		tmpDir = mkdtempSync(join(tmpdir(), `scheduler-feat-${randomBytes(4).toString("hex")}-`));
		const dbPath = join(tmpDir, "test.db");
		db = createDatabase(dbPath);
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
		// Clean up all task/turn data between tests to prevent cross-contamination
		db.run("DELETE FROM tasks");
		db.run("DELETE FROM turns");
		db.run("DELETE FROM daily_summary");
	});

	afterAll(async () => {
		db.close();
		await cleanupTmpDir(tmpDir);
	});

	function makeCtx(overrides: Partial<AppContext> = {}): AppContext {
		return {
			db,
			logger: {
				debug: () => {},
				info: () => {},
				warn: () => {},
				error: () => {},
			},
			eventBus,
			hostName: "test-host",
			siteId,
			config: {
				allowlist: {
					default_web_user: "test",
					users: { test: { display_name: "Test" } },
				},
				modelBackends: {
					backends: [
						{
							id: "mock",
							provider: "ollama",
							model: "mock",
							base_url: "http://localhost:11434",
							context_window: 8000,
							tier: 1,
							price_per_m_input: 0,
							price_per_m_output: 0,
						},
					],
					default: "mock",
				},
			},
			optionalConfig: {},
			...overrides,
		} as unknown as AppContext;
	}

	function makeAgentLoopFactory(
		result?: AgentLoopResult,
	): (config: AgentLoopConfig) => { run: () => Promise<AgentLoopResult> } {
		return () => ({
			run: async () =>
				result ?? {
					messagesCreated: 1,
					toolCallsMade: 0,
					filesChanged: 0,
				},
		});
	}

	function makeFailingAgentLoopFactory(): (config: AgentLoopConfig) => {
		run: () => Promise<AgentLoopResult>;
	} {
		return () => ({
			run: async () => {
				throw new Error("Simulated task failure");
			},
		});
	}

	// -----------------------------------------------------------------------
	// Quiescence multiplier
	// -----------------------------------------------------------------------
	describe("quiescence multiplier", () => {
		it("applies quiescence multiplier to poll interval based on idle time", () => {
			const ctx = makeCtx();
			// biome-ignore lint/suspicious/noExplicitAny: test mock
			const scheduler = new Scheduler(ctx as any, makeAgentLoopFactory());

			// Immediately after creation, lastUserInteractionAt is "now",
			// so idle time is ~0ms.  The lowest tier (0-30m) has multiplier 1.
			const interval = scheduler.getEffectivePollInterval();

			// Base POLL_INTERVAL is 5000, with 1x multiplier (active user) we expect 5000
			expect(interval).toBe(5_000);
		});

		it("returns base interval when a no_quiescence task exists", () => {
			const taskId = randomUUID();
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
					?, 'deferred', 'pending', 'manual', NULL, NULL,
					NULL, NULL, NULL, NULL, NULL,
					0, NULL, NULL, NULL, 0,
					'status', NULL, 0, 5,
					0, 0, 1,
					NULL, NULL, NULL, ?, 'system', ?, 0
				)`,
				[taskId, now, now],
			);

			const ctx = makeCtx();
			// biome-ignore lint/suspicious/noExplicitAny: test mock
			const scheduler = new Scheduler(ctx as any, makeAgentLoopFactory());

			const interval = scheduler.getEffectivePollInterval();
			// no_quiescence = 1 should bypass multiplier, returning base 5000
			expect(interval).toBe(5_000);

			// Clean up
			db.run("DELETE FROM tasks WHERE id = ?", [taskId]);
		});
	});

	// -----------------------------------------------------------------------
	// Daily budget
	// -----------------------------------------------------------------------
	describe("daily budget checking", () => {
		it("checks daily budget before running autonomous tasks", async () => {
			const ctx = makeCtx({
				config: {
					allowlist: {
						default_web_user: "test",
						users: { test: { display_name: "Test" } },
					},
					modelBackends: {
						backends: [
							{
								id: "mock",
								provider: "ollama",
								model: "mock",
								base_url: "http://localhost:11434",
								context_window: 8000,
								tier: 1,
								price_per_m_input: 0,
								price_per_m_output: 0,
							},
						],
						default: "mock",
						daily_budget_usd: 1.0, // $1 daily budget
					},
				},
			} as unknown as Partial<AppContext>);

			// Record enough turns to exceed the budget
			const _today = new Date().toISOString().split("T")[0];
			for (let i = 0; i < 5; i++) {
				recordTurn(db, {
					thread_id: randomUUID(),
					model_id: "mock",
					tokens_in: 1000,
					tokens_out: 1000,
					cost_usd: 0.3, // $0.30 per turn, 5 turns = $1.50 > $1.00
					created_at: new Date().toISOString(),
				});
			}

			// Insert an autonomous (system-created) task ready to run
			const taskId = randomUUID();
			const pastTime = new Date(Date.now() - 60_000).toISOString();
			const nowStr = new Date().toISOString();

			db.run(
				`INSERT INTO tasks (
					id, type, status, trigger_spec, payload, thread_id,
					claimed_by, claimed_at, lease_id, next_run_at, last_run_at,
					run_count, max_runs, requires, model_hint, no_history,
					inject_mode, depends_on, require_success, alert_threshold,
					consecutive_failures, event_depth, no_quiescence,
					heartbeat_at, result, error, created_at, created_by, modified_at, deleted
				) VALUES (
					?, 'deferred', 'pending', 'manual', NULL, NULL,
					NULL, NULL, NULL, ?, NULL,
					0, NULL, NULL, NULL, 0,
					'status', NULL, 0, 5,
					0, 0, 0,
					NULL, NULL, NULL, ?, 'system', ?, 0
				)`,
				[taskId, pastTime, nowStr, nowStr],
			);

			let _agentRunCalled = false;
			const factory = () => ({
				run: async () => {
					_agentRunCalled = true;
					return { messagesCreated: 1, toolCallsMade: 0, filesChanged: 0 };
				},
			});

			// biome-ignore lint/suspicious/noExplicitAny: test mock
			const scheduler = new Scheduler(ctx as any, factory as any);
			const { stop } = scheduler.start(50);

			// Budget exceeded — task should stay pending; wait enough cycles to confirm
			await sleep(300);
			stop();

			// The task should NOT have been run because the budget was exceeded.
			// It should have been released back to pending.
			const task = db.query("SELECT status FROM tasks WHERE id = ?").get(taskId) as {
				status: string;
			} | null;

			expect(task).not.toBeNull();
			// Task should still be pending (released after budget check)
			expect(task?.status).toBe("pending");

			// Clean up
			db.run("DELETE FROM tasks WHERE id = ?", [taskId]);
			db.run("DELETE FROM turns");
			db.run("DELETE FROM daily_summary");
		});
	});

	// -----------------------------------------------------------------------
	// Task failure alert
	// -----------------------------------------------------------------------
	describe("task failure alert", () => {
		it("marks task as failed when run() returns an error result without throwing", async () => {
			const taskId = randomUUID();
			const now = new Date().toISOString();
			const pastTime = new Date(Date.now() - 60_000).toISOString();

			// Set consecutive_failures to 2 (= DEFERRED_MAX_RETRIES) so the task
			// stays failed and isn't auto-retried back to pending.
			db.run(
				`INSERT INTO tasks (
					id, type, status, trigger_spec, payload, thread_id,
					claimed_by, claimed_at, lease_id, next_run_at, last_run_at,
					run_count, max_runs, requires, model_hint, no_history,
					inject_mode, depends_on, require_success, alert_threshold,
					consecutive_failures, event_depth, no_quiescence,
					heartbeat_at, result, error, created_at, created_by, modified_at, deleted
				) VALUES (
					?, 'deferred', 'pending', 'manual', NULL, NULL,
					NULL, NULL, NULL, ?, NULL,
					0, NULL, NULL, NULL, 0,
					'status', NULL, 0, 5,
					2, 0, 0,
					NULL, NULL, NULL, ?, 'system', ?, 0
				)`,
				[taskId, pastTime, now, now],
			);

			// Factory returns a soft error (result with .error, no exception thrown)
			const softErrorFactory = () => ({
				run: async (): Promise<AgentLoopResult> => ({
					messagesCreated: 0,
					toolCallsMade: 0,
					filesChanged: 0,
					error: "Bedrock request failed: connection refused",
				}),
			});

			const ctx = makeCtx();
			// biome-ignore lint/suspicious/noExplicitAny: test mock
			const scheduler = new Scheduler(ctx as any, softErrorFactory as any);
			const { stop } = scheduler.start(50);

			await waitFor(
				() =>
					(
						db.query("SELECT status FROM tasks WHERE id = ?").get(taskId) as {
							status: string;
						} | null
					)?.status === "failed",
				{ message: "task did not fail" },
			);
			stop();

			const task = db.query("SELECT status, error FROM tasks WHERE id = ?").get(taskId) as {
				status: string;
				error: string | null;
			} | null;

			expect(task).not.toBeNull();
			// Must be 'failed', not 'completed'
			expect(task?.status).toBe("failed");
			expect(task?.error).toContain("Bedrock request failed");

			db.run("DELETE FROM tasks WHERE id = ?", [taskId]);
		});

		it("persists an alert message on task failure", async () => {
			const userId = randomUUID();
			const threadId = randomUUID();
			const taskId = randomUUID();
			const now = new Date().toISOString();
			const pastTime = new Date(Date.now() - 60_000).toISOString();

			// Create user and thread
			db.run(
				"INSERT INTO users (id, display_name, platform_ids, first_seen_at, modified_at, deleted) VALUES (?, ?, NULL, ?, ?, 0)",
				[userId, "AlertUser", now, now],
			);
			db.run(
				"INSERT INTO threads (id, user_id, interface, host_origin, color, title, summary, created_at, last_message_at, modified_at, deleted) VALUES (?, ?, 'web', 'localhost', 0, 'Alert Test', NULL, ?, ?, ?, 0)",
				[threadId, userId, now, now, now],
			);

			// Insert a task that will fail (cf=2 so it won't be auto-retried)
			db.run(
				`INSERT INTO tasks (
					id, type, status, trigger_spec, payload, thread_id,
					claimed_by, claimed_at, lease_id, next_run_at, last_run_at,
					run_count, max_runs, requires, model_hint, no_history,
					inject_mode, depends_on, require_success, alert_threshold,
					consecutive_failures, event_depth, no_quiescence,
					heartbeat_at, result, error, created_at, created_by, modified_at, deleted
				) VALUES (
					?, 'deferred', 'pending', 'manual', NULL, ?,
					NULL, NULL, NULL, ?, NULL,
					0, NULL, NULL, NULL, 0,
					'status', NULL, 0, 5,
					2, 0, 0,
					NULL, NULL, NULL, ?, 'system', ?, 0
				)`,
				[taskId, threadId, pastTime, now, now],
			);

			const ctx = makeCtx();
			// biome-ignore lint/suspicious/noExplicitAny: test mock
			const scheduler = new Scheduler(ctx as any, makeFailingAgentLoopFactory() as any);
			const { stop } = scheduler.start(50);

			await waitFor(
				() =>
					db
						.query("SELECT COUNT(*) as n FROM messages WHERE thread_id = ? AND role = 'alert'")
						.get(threadId)?.n > 0,
				{ message: "alert message not created" },
			);
			stop();

			// Verify that a failure alert message was persisted
			const alerts = db
				.query("SELECT * FROM messages WHERE thread_id = ? AND role = 'alert'")
				.all(threadId) as Array<{ content: string }>;

			expect(alerts.length).toBeGreaterThanOrEqual(1);
			expect(alerts[0].content).toContain("failed");

			// Verify the task itself was marked as failed
			const task = db.query("SELECT status, error FROM tasks WHERE id = ?").get(taskId) as {
				status: string;
				error: string | null;
			} | null;

			expect(task).not.toBeNull();
			expect(task?.status).toBe("failed");
			expect(task?.error).toContain("Simulated task failure");

			// Clean up
			db.run("DELETE FROM tasks WHERE id = ?", [taskId]);
			db.run("DELETE FROM messages WHERE thread_id = ?", [threadId]);
			db.run("DELETE FROM threads WHERE id = ?", [threadId]);
			db.run("DELETE FROM users WHERE id = ?", [userId]);
		});
	});

	// -----------------------------------------------------------------------
	// consecutive_failures tracking and advisory escalation
	// -----------------------------------------------------------------------
	describe("consecutive_failures tracking", () => {
		function insertTask(
			id: string,
			opts: {
				consecutiveFailures?: number;
				alertThreshold?: number;
				threadId?: string;
			} = {},
		) {
			const now = new Date().toISOString();
			const pastTime = new Date(Date.now() - 60_000).toISOString();
			db.run(
				`INSERT INTO tasks (
					id, type, status, trigger_spec, payload, thread_id,
					claimed_by, claimed_at, lease_id, next_run_at, last_run_at,
					run_count, max_runs, requires, model_hint, no_history,
					inject_mode, depends_on, require_success, alert_threshold,
					consecutive_failures, event_depth, no_quiescence,
					heartbeat_at, result, error, created_at, created_by, modified_at, deleted
				) VALUES (
					?, 'deferred', 'pending', 'manual', NULL, ?,
					NULL, NULL, NULL, ?, NULL,
					0, NULL, NULL, NULL, 0,
					'status', NULL, 0, ?,
					?, 0, 0,
					NULL, NULL, NULL, ?, 'system', ?, 0
				)`,
				[
					id,
					opts.threadId ?? null,
					pastTime,
					opts.alertThreshold ?? 3,
					opts.consecutiveFailures ?? 0,
					now,
					now,
				],
			);
		}

		function softErrorFactory(msg = "inference error") {
			return () => ({
				run: async (): Promise<AgentLoopResult> => ({
					messagesCreated: 0,
					toolCallsMade: 0,
					filesChanged: 0,
					error: msg,
				}),
			});
		}

		it("increments consecutive_failures on soft error", async () => {
			const taskId = randomUUID();
			insertTask(taskId, { consecutiveFailures: 0, alertThreshold: 5 });

			const ctx = makeCtx();
			// biome-ignore lint/suspicious/noExplicitAny: test mock
			const scheduler = new Scheduler(ctx as any, softErrorFactory() as any);
			const { stop } = scheduler.start(50);
			await waitFor(
				() =>
					((
						db.query("SELECT consecutive_failures FROM tasks WHERE id = ?").get(taskId) as {
							consecutive_failures: number;
						} | null
					)?.consecutive_failures ?? 0) > 0,
				{ message: "consecutive_failures not incremented" },
			);
			stop();

			const task = db.query("SELECT consecutive_failures FROM tasks WHERE id = ?").get(taskId) as {
				consecutive_failures: number;
			} | null;
			expect(task?.consecutive_failures).toBeGreaterThan(0);
			db.run("DELETE FROM tasks WHERE id = ?", [taskId]);
		});

		it("creates an advisory when consecutive_failures reaches alert_threshold (soft error)", async () => {
			const taskId = randomUUID();
			// One failure already — next failure crosses the threshold of 2
			insertTask(taskId, { consecutiveFailures: 1, alertThreshold: 2 });

			const ctx = makeCtx();
			// biome-ignore lint/suspicious/noExplicitAny: test mock
			const scheduler = new Scheduler(ctx as any, softErrorFactory() as any);
			const { stop } = scheduler.start(50);
			await waitFor(
				() =>
					(
						db
							.query("SELECT COUNT(*) as n FROM advisories WHERE detail LIKE ?")
							.get(`%${taskId}%`) as { n: number } | null
					)?.n > 0,
				{ message: "advisory not created" },
			);
			stop();

			const advisories = db
				.query("SELECT title, detail FROM advisories WHERE detail LIKE ?")
				.all(`%${taskId}%`) as Array<{ title: string; detail: string }>;
			expect(advisories.length).toBeGreaterThan(0);
			expect(advisories[0].detail).toContain(taskId);
			db.run("DELETE FROM tasks WHERE id = ?", [taskId]);
			db.run("DELETE FROM advisories WHERE detail LIKE ?", [`%${taskId}%`]);
		});

		it("creates an advisory when consecutive_failures reaches alert_threshold (hard error)", async () => {
			const taskId = randomUUID();
			// One failure already — next hard-error throw crosses threshold of 2
			insertTask(taskId, { consecutiveFailures: 1, alertThreshold: 2 });

			const ctx = makeCtx();
			// biome-ignore lint/suspicious/noExplicitAny: test mock
			const scheduler = new Scheduler(ctx as any, makeFailingAgentLoopFactory() as any);
			const { stop } = scheduler.start(50);
			await waitFor(
				() =>
					(
						db
							.query("SELECT COUNT(*) as n FROM advisories WHERE detail LIKE ?")
							.get(`%${taskId}%`) as { n: number } | null
					)?.n > 0,
				{ message: "advisory not created" },
			);
			stop();

			const advisories = db
				.query("SELECT title, detail FROM advisories WHERE detail LIKE ?")
				.all(`%${taskId}%`) as Array<{ title: string; detail: string }>;
			expect(advisories.length).toBeGreaterThan(0);
			db.run("DELETE FROM tasks WHERE id = ?", [taskId]);
			db.run("DELETE FROM advisories WHERE detail LIKE ?", [`%${taskId}%`]);
		});

		it("does not create a duplicate advisory when failures exceed alert_threshold", async () => {
			const taskId = randomUUID();
			// Already at threshold — next failure goes beyond it (no new advisory)
			insertTask(taskId, { consecutiveFailures: 2, alertThreshold: 2 });

			const ctx = makeCtx();
			// biome-ignore lint/suspicious/noExplicitAny: test mock
			const scheduler = new Scheduler(ctx as any, softErrorFactory() as any);
			const { stop } = scheduler.start(50);
			await waitFor(
				() =>
					((
						db.query("SELECT consecutive_failures FROM tasks WHERE id = ?").get(taskId) as {
							consecutive_failures: number;
						} | null
					)?.consecutive_failures ?? 0) > 2,
				{ message: "task did not run (consecutive_failures not incremented)" },
			);
			stop();

			const advisories = db
				.query("SELECT id FROM advisories WHERE detail LIKE ?")
				.all(`%${taskId}%`) as Array<{ id: string }>;
			expect(advisories.length).toBe(0);
			db.run("DELETE FROM tasks WHERE id = ?", [taskId]);
		});

		it("fires advisory when DB consecutive_failures reaches threshold via RETURNING (stale-value regression)", async () => {
			// Scenario: a concurrent process increments consecutive_failures in the DB
			// while the scheduler task is executing. The scheduler's own UPDATE then
			// takes it exactly to the alert_threshold. With a stale in-memory value the
			// threshold check computes (0)+1=1 ≠ 2, so the advisory is MISSED. With
			// RETURNING the check uses the fresh DB value 2 === 2 and fires correctly.
			const taskId = randomUUID();
			insertTask(taskId, { consecutiveFailures: 0, alertThreshold: 2 });

			// Factory that simulates a concurrent increment while the task runs
			const factory = () => ({
				run: async (): Promise<AgentLoopResult> => {
					// Concurrent increment: another process touched consecutive_failures
					db.run("UPDATE tasks SET consecutive_failures = consecutive_failures + 1 WHERE id = ?", [
						taskId,
					]);
					return { messagesCreated: 0, toolCallsMade: 0, filesChanged: 0, error: "timeout" };
				},
			});

			const ctx = makeCtx();
			// biome-ignore lint/suspicious/noExplicitAny: test mock
			const scheduler = new Scheduler(ctx as any, factory as any);
			const { stop } = scheduler.start(50);
			await waitFor(
				() =>
					((
						db.query("SELECT consecutive_failures FROM tasks WHERE id = ?").get(taskId) as {
							consecutive_failures: number;
						} | null
					)?.consecutive_failures ?? 0) >= 2,
				{ message: "RETURNING regression: consecutive_failures did not reach 2" },
			);
			stop();

			// DB should be at 2 (1 from concurrent + 1 from scheduler UPDATE)
			const task = db.query("SELECT consecutive_failures FROM tasks WHERE id = ?").get(taskId) as {
				consecutive_failures: number;
			} | null;
			expect(task?.consecutive_failures).toBe(2);

			// Advisory MUST have fired because DB consecutive_failures === alert_threshold
			const advisories = db
				.query("SELECT id FROM advisories WHERE detail LIKE ?")
				.all(`%${taskId}%`) as Array<{ id: string }>;
			expect(advisories.length).toBe(1);

			db.run("DELETE FROM tasks WHERE id = ?", [taskId]);
			db.run("DELETE FROM advisories WHERE detail LIKE ?", [`%${taskId}%`]);
		});

		it("resets consecutive_failures to 0 on success", async () => {
			const taskId = randomUUID();
			// Task has failures on record but now succeeds
			insertTask(taskId, { consecutiveFailures: 4, alertThreshold: 5 });

			const ctx = makeCtx();
			// biome-ignore lint/suspicious/noExplicitAny: test mock
			const scheduler = new Scheduler(ctx as any, makeAgentLoopFactory() as any);
			const { stop } = scheduler.start(50);
			await waitFor(
				() =>
					(
						db.query("SELECT consecutive_failures FROM tasks WHERE id = ?").get(taskId) as {
							consecutive_failures: number;
						} | null
					)?.consecutive_failures === 0,
				{ message: "consecutive_failures not reset to 0" },
			);
			stop();

			const task = db.query("SELECT consecutive_failures FROM tasks WHERE id = ?").get(taskId) as {
				consecutive_failures: number;
			} | null;
			expect(task?.consecutive_failures).toBe(0);
			db.run("DELETE FROM tasks WHERE id = ?", [taskId]);
		});
	});

	// -----------------------------------------------------------------------
	// Cron template wiring (deterministic, no scheduler timing dependency)
	// -----------------------------------------------------------------------
	describe("cron template execution", () => {
		it("executes template commands via sandbox when optionalConfig.cronSchedules is Result-wrapped", async () => {
			// This is the real production path: the config loader stores
			// optionalConfig["cronSchedules"] as { ok: true, value: { <map> } }.
			// getCronTemplate must unwrap .value to find the template — this test
			// confirms the Scheduler handles the Result wrapper correctly end-to-end.

			const cronExpression = "0 */6 * * *";
			const taskId = randomUUID();
			const now = new Date().toISOString();
			const pastTime = new Date(Date.now() - 60_000).toISOString();

			// triggerSpec as produced by the `schedule --every` command
			const triggerSpec = JSON.stringify({ type: "cron", expression: cronExpression });

			db.run(
				`INSERT INTO tasks (
					id, type, status, trigger_spec, payload, thread_id,
					claimed_by, claimed_at, lease_id, next_run_at, last_run_at,
					run_count, max_runs, requires, model_hint, no_history,
					inject_mode, depends_on, require_success, alert_threshold,
					consecutive_failures, event_depth, no_quiescence,
					heartbeat_at, result, error, created_at, created_by, modified_at, deleted
				) VALUES (
					?, 'cron', 'pending', ?, NULL, NULL,
					NULL, NULL, NULL, ?, NULL,
					0, NULL, NULL, NULL, 0,
					'status', NULL, 0, 5,
					0, 0, 0,
					NULL, NULL, NULL, ?, 'system', ?, 0
				)`,
				[taskId, triggerSpec, pastTime, now, now],
			);

			const execCalls: string[] = [];
			let agentLoopCalled = false;

			// optionalConfig with Result-wrapped cronSchedules (real production format)
			const ctx = makeCtx({
				optionalConfig: {
					cronSchedules: {
						ok: true,
						value: {
							backup: {
								schedule: cronExpression,
								template: ["echo backup-start", "echo backup-done"],
							},
						},
					},
				} as unknown as AppContext["optionalConfig"],
			});

			const agentLoopFactory = () => {
				agentLoopCalled = true;
				return {
					run: async (): Promise<AgentLoopResult> => ({
						messagesCreated: 0,
						toolCallsMade: 0,
						filesChanged: 0,
					}),
				};
			};

			const sandbox = {
				exec: async (cmd: string) => {
					execCalls.push(cmd);
					return { stdout: cmd, stderr: "", exitCode: 0 };
				},
			};

			// biome-ignore lint/suspicious/noExplicitAny: test mock
			const scheduler = new Scheduler(ctx as any, agentLoopFactory as any, {}, sandbox);
			const { stop } = scheduler.start(50);
			await waitFor(() => execCalls.length > 0, { message: "cron template not executed" });
			stop();

			// Template was found and executed via sandbox — agent loop was NOT used
			expect(agentLoopCalled).toBe(false);
			expect(execCalls).toContain("echo backup-start");
			expect(execCalls).toContain("echo backup-done");

			db.run("DELETE FROM tasks WHERE id = ?", [taskId]);
		});
	});

	// -----------------------------------------------------------------------
	// Bug #4: runTask must create a thread row when generating a new threadId
	// Bug #1: runTask must inject the task payload as a user message before running
	// -----------------------------------------------------------------------
	describe("task thread and payload injection", () => {
		it("creates a thread row when task has no thread_id", async () => {
			const taskId = randomUUID();
			const now = new Date().toISOString();
			const pastTime = new Date(Date.now() - 60_000).toISOString();

			// Task with NULL thread_id — scheduler must create a thread row
			db.run(
				`INSERT INTO tasks (
					id, type, status, trigger_spec, payload, thread_id,
					claimed_by, claimed_at, lease_id, next_run_at, last_run_at,
					run_count, max_runs, requires, model_hint, no_history,
					inject_mode, depends_on, require_success, alert_threshold,
					consecutive_failures, event_depth, no_quiescence,
					heartbeat_at, result, error, created_at, created_by, modified_at, deleted
				) VALUES (
					?, 'deferred', 'pending', 'manual', NULL, NULL,
					NULL, NULL, NULL, ?, NULL,
					0, NULL, NULL, NULL, 0,
					'status', NULL, 0, 5,
					0, 0, 0,
					NULL, NULL, NULL, ?, 'system', ?, 0
				)`,
				[taskId, pastTime, now, now],
			);

			let capturedThreadId: string | undefined;
			const factory = (config: { threadId: string }) => {
				capturedThreadId = config.threadId;
				return {
					run: async (): Promise<AgentLoopResult> => ({
						messagesCreated: 0,
						toolCallsMade: 0,
						filesChanged: 0,
					}),
				};
			};

			const ctx = makeCtx();
			// biome-ignore lint/suspicious/noExplicitAny: test mock
			const scheduler = new Scheduler(ctx as any, factory as any);
			const { stop } = scheduler.start(50);

			await waitFor(() => capturedThreadId !== undefined, {
				message: "agent loop factory not called with threadId",
			});
			stop();

			expect(capturedThreadId).toBeDefined();

			// A thread row must exist for the generated threadId
			// biome-ignore lint/style/noNonNullAssertion: verified by expect(capturedThreadId).toBeDefined() above
			const thread = db.query("SELECT id FROM threads WHERE id = ?").get(capturedThreadId!) as {
				id: string;
			} | null;

			expect(thread).not.toBeNull();

			db.run("DELETE FROM tasks WHERE id = ?", [taskId]);
			if (capturedThreadId) {
				db.run("DELETE FROM threads WHERE id = ?", [capturedThreadId]);
				db.run("DELETE FROM messages WHERE thread_id = ?", [capturedThreadId]);
			}
		});

		it("creates scheduler threads with operator user_id instead of system", async () => {
			const taskId = randomUUID();
			const now = new Date().toISOString();
			const pastTime = new Date(Date.now() - 60_000).toISOString();

			db.run(
				`INSERT INTO tasks (
					id, type, status, trigger_spec, payload, thread_id,
					claimed_by, claimed_at, lease_id, next_run_at, last_run_at,
					run_count, max_runs, requires, model_hint, no_history,
					inject_mode, depends_on, require_success, alert_threshold,
					consecutive_failures, event_depth, no_quiescence,
					heartbeat_at, result, error, created_at, created_by, modified_at, deleted
				) VALUES (
					?, 'deferred', 'pending', 'manual', NULL, NULL,
					NULL, NULL, NULL, ?, NULL,
					0, NULL, NULL, NULL, 0,
					'status', NULL, 0, 5,
					0, 0, 0,
					NULL, NULL, NULL, ?, 'system', ?, 0
				)`,
				[taskId, pastTime, now, now],
			);

			let capturedThreadId: string | undefined;
			const factory = (config: { threadId: string }) => {
				capturedThreadId = config.threadId;
				return {
					run: async (): Promise<AgentLoopResult> => ({
						messagesCreated: 0,
						toolCallsMade: 0,
						filesChanged: 0,
					}),
				};
			};

			const ctx = makeCtx();
			// biome-ignore lint/suspicious/noExplicitAny: test mock
			const scheduler = new Scheduler(ctx as any, factory as any);
			const { stop } = scheduler.start(50);

			await waitFor(() => capturedThreadId !== undefined, {
				message: "agent loop factory not called with threadId",
			});
			stop();

			expect(capturedThreadId).toBeDefined();

			// The thread's user_id should be the operator's resolved UUID, NOT "system"
			const threadId = capturedThreadId as string;
			const thread = db.query("SELECT user_id FROM threads WHERE id = ?").get(threadId) as {
				user_id: string;
			} | null;

			expect(thread).not.toBeNull();
			// Operator UUID is deterministicUUID(BOUND_NAMESPACE, "test") since default_web_user = "test"
			const { deterministicUUID, BOUND_NAMESPACE } = await import("@bound/shared");
			const expectedUserId = deterministicUUID(BOUND_NAMESPACE, "test");
			expect(thread?.user_id).toBe(expectedUserId);
			expect(thread?.user_id).not.toBe("system");

			db.run("DELETE FROM tasks WHERE id = ?", [taskId]);
			if (capturedThreadId) {
				db.run("DELETE FROM threads WHERE id = ?", [capturedThreadId]);
				db.run("DELETE FROM messages WHERE thread_id = ?", [capturedThreadId]);
			}
		});

		it("inserts task payload as synthetic retrieve_task tool call", async () => {
			const taskId = randomUUID();
			const now = new Date().toISOString();
			const pastTime = new Date(Date.now() - 60_000).toISOString();
			const payload = "Analyze the sales report and summarize key findings.";

			db.run(
				`INSERT INTO tasks (
					id, type, status, trigger_spec, payload, thread_id,
					claimed_by, claimed_at, lease_id, next_run_at, last_run_at,
					run_count, max_runs, requires, model_hint, no_history,
					inject_mode, depends_on, require_success, alert_threshold,
					consecutive_failures, event_depth, no_quiescence,
					heartbeat_at, result, error, created_at, created_by, modified_at, deleted
				) VALUES (
					?, 'deferred', 'pending', 'manual', ?, NULL,
					NULL, NULL, NULL, ?, NULL,
					0, NULL, NULL, NULL, 0,
					'status', NULL, 0, 5,
					0, 0, 0,
					NULL, NULL, NULL, ?, 'system', ?, 0
				)`,
				[taskId, payload, pastTime, now, now],
			);

			let capturedThreadId: string | undefined;
			let messagesAtRunTime = 0;
			const factory = (config: { threadId: string }) => {
				capturedThreadId = config.threadId;
				return {
					run: async (): Promise<AgentLoopResult> => {
						const rows = db
							.query("SELECT COUNT(*) as c FROM messages WHERE thread_id = ?")
							// biome-ignore lint/style/noNonNullAssertion: verified by expect above
							.get(capturedThreadId!) as { c: number };
						messagesAtRunTime = rows.c;
						return { messagesCreated: 0, toolCallsMade: 0, filesChanged: 0 };
					},
				};
			};

			const ctx = makeCtx();
			// biome-ignore lint/suspicious/noExplicitAny: test mock
			const scheduler = new Scheduler(ctx as any, factory as any);
			const { stop } = scheduler.start(50);

			await waitFor(() => messagesAtRunTime > 0, {
				message: "payload not injected before agent loop",
			});
			stop();

			// Three messages: user "." + tool_call retrieve_task + tool_result with payload
			expect(messagesAtRunTime).toBeGreaterThanOrEqual(3);

			const allMsgs = db
				.query(
					"SELECT role, content, tool_name FROM messages WHERE thread_id = ? ORDER BY rowid ASC",
				)
				// biome-ignore lint/style/noNonNullAssertion: verified by expect above
				.all(capturedThreadId!) as {
				role: string;
				content: string;
				tool_name: string | null;
			}[];

			// First message: minimal user stub for Bedrock
			expect(allMsgs[0].role).toBe("user");
			expect(allMsgs[0].content).toBe(".");

			// Second message: synthetic assistant tool_call
			expect(allMsgs[1].role).toBe("tool_call");
			const toolCallBlocks = JSON.parse(allMsgs[1].content);
			expect(Array.isArray(toolCallBlocks)).toBe(true);
			expect(toolCallBlocks[0].type).toBe("tool_use");
			expect(toolCallBlocks[0].name).toBe("retrieve_task");

			// Third message: tool_result with the actual payload
			// tool_name must be the toolCallId (not "retrieve_task") so Bedrock
			// can match the tool_result to the tool_call by ID
			expect(allMsgs[2].role).toBe("tool_result");
			expect(allMsgs[2].tool_name).toBe(toolCallBlocks[0].id);
			expect(allMsgs[2].content).toBe(payload);

			if (capturedThreadId) {
				db.run("DELETE FROM tasks WHERE id = ?", [taskId]);
				db.run("DELETE FROM threads WHERE id = ?", [capturedThreadId]);
				db.run("DELETE FROM messages WHERE thread_id = ?", [capturedThreadId]);
			}
		});
	});

	// -----------------------------------------------------------------------
	// Cron rescheduling after hard errors (thrown exceptions)
	// -----------------------------------------------------------------------
	describe("cron rescheduling after hard errors", () => {
		it("reschedules cron task to pending after a hard error (thrown exception)", async () => {
			const taskId = randomUUID();
			const now = new Date().toISOString();
			const pastTime = new Date(Date.now() - 60_000).toISOString();
			const triggerSpec = JSON.stringify({ type: "cron", expression: "0 * * * *" });

			db.run(
				`INSERT INTO tasks (
					id, type, status, trigger_spec, payload, thread_id,
					claimed_by, claimed_at, lease_id, next_run_at, last_run_at,
					run_count, max_runs, requires, model_hint, no_history,
					inject_mode, depends_on, require_success, alert_threshold,
					consecutive_failures, event_depth, no_quiescence,
					heartbeat_at, result, error, created_at, created_by, modified_at, deleted
				) VALUES (
					?, 'cron', 'pending', ?, NULL, NULL,
					NULL, NULL, NULL, ?, NULL,
					0, NULL, NULL, NULL, 0,
					'status', NULL, 0, 5,
					0, 0, 0,
					NULL, NULL, NULL, ?, 'system', ?, 0
				)`,
				[taskId, triggerSpec, pastTime, now, now],
			);

			const ctx = makeCtx();
			// biome-ignore lint/suspicious/noExplicitAny: test mock
			const scheduler = new Scheduler(ctx as any, makeFailingAgentLoopFactory() as any);
			const { stop } = scheduler.start(50);

			// Wait for the task to be processed (it will throw, then should reschedule)
			await waitFor(
				() => {
					const task = db
						.query("SELECT status, error, next_run_at FROM tasks WHERE id = ?")
						.get(taskId) as {
						status: string;
						error: string | null;
						next_run_at: string | null;
					} | null;
					// After hard error, cron task should be rescheduled to pending with future next_run_at
					return (
						task?.status === "pending" &&
						task?.next_run_at !== null &&
						new Date(task.next_run_at).getTime() > Date.now()
					);
				},
				{ message: "cron task not rescheduled after hard error", timeoutMs: 5000 },
			);
			stop();

			const task = db
				.query("SELECT status, next_run_at, error FROM tasks WHERE id = ?")
				.get(taskId) as {
				status: string;
				next_run_at: string | null;
				error: string | null;
			} | null;

			expect(task).not.toBeNull();
			expect(task?.status).toBe("pending");
			expect(task?.next_run_at).not.toBeNull();
			// next_run_at should be in the future
			const nextRun = new Date(task?.next_run_at ?? "");
			expect(nextRun.getTime()).toBeGreaterThan(Date.now());

			db.run("DELETE FROM tasks WHERE id = ?", [taskId]);
		});

		it("reschedules cron task after model validation failure", async () => {
			const taskId = randomUUID();
			const now = new Date().toISOString();
			const pastTime = new Date(Date.now() - 60_000).toISOString();
			const triggerSpec = JSON.stringify({ type: "cron", expression: "0 * * * *" });

			db.run(
				`INSERT INTO tasks (
					id, type, status, trigger_spec, payload, thread_id,
					claimed_by, claimed_at, lease_id, next_run_at, last_run_at,
					run_count, max_runs, requires, model_hint, no_history,
					inject_mode, depends_on, require_success, alert_threshold,
					consecutive_failures, event_depth, no_quiescence,
					heartbeat_at, result, error, created_at, created_by, modified_at, deleted
				) VALUES (
					?, 'cron', 'pending', ?, NULL, NULL,
					NULL, NULL, NULL, ?, NULL,
					0, NULL, NULL, 'nonexistent-model', 0,
					'status', NULL, 0, 5,
					0, 0, 0,
					NULL, NULL, NULL, ?, 'system', ?, 0
				)`,
				[taskId, triggerSpec, pastTime, now, now],
			);

			const ctx = makeCtx();
			const scheduler = new Scheduler(
				// biome-ignore lint/suspicious/noExplicitAny: test mock
				ctx as any,
				// biome-ignore lint/suspicious/noExplicitAny: test mock
				makeAgentLoopFactory() as any,
				{
					modelValidator: () => ({
						ok: false,
						error: "Model not found",
					}),
				},
			);
			const { stop } = scheduler.start(50);

			// Wait for the task to be processed — should reschedule despite model failure
			await waitFor(
				() => {
					const task = db
						.query("SELECT status, next_run_at FROM tasks WHERE id = ?")
						.get(taskId) as {
						status: string;
						next_run_at: string | null;
					} | null;
					// After model validation failure, cron should be rescheduled to pending
					return (
						task?.status === "pending" &&
						task?.next_run_at !== null &&
						new Date(task.next_run_at).getTime() > Date.now()
					);
				},
				{ message: "cron task not rescheduled after model validation failure", timeoutMs: 5000 },
			);
			stop();

			const task = db.query("SELECT status, next_run_at FROM tasks WHERE id = ?").get(taskId) as {
				status: string;
				next_run_at: string | null;
			} | null;

			expect(task).not.toBeNull();
			expect(task?.status).toBe("pending");
			expect(task?.next_run_at).not.toBeNull();
			const nextRun = new Date(task?.next_run_at ?? "");
			expect(nextRun.getTime()).toBeGreaterThan(Date.now());

			db.run("DELETE FROM tasks WHERE id = ?", [taskId]);
		});

		it("reschedules cron template task after hard error", async () => {
			const cronExpression = "0 */6 * * *";
			const taskId = randomUUID();
			const now = new Date().toISOString();
			const pastTime = new Date(Date.now() - 60_000).toISOString();
			const triggerSpec = JSON.stringify({ type: "cron", expression: cronExpression });

			db.run(
				`INSERT INTO tasks (
					id, type, status, trigger_spec, payload, thread_id,
					claimed_by, claimed_at, lease_id, next_run_at, last_run_at,
					run_count, max_runs, requires, model_hint, no_history,
					inject_mode, depends_on, require_success, alert_threshold,
					consecutive_failures, event_depth, no_quiescence,
					heartbeat_at, result, error, created_at, created_by, modified_at, deleted
				) VALUES (
					?, 'cron', 'pending', ?, NULL, NULL,
					NULL, NULL, NULL, ?, NULL,
					0, NULL, NULL, NULL, 0,
					'status', NULL, 0, 5,
					0, 0, 0,
					NULL, NULL, NULL, ?, 'system', ?, 0
				)`,
				[taskId, triggerSpec, pastTime, now, now],
			);

			const ctx = makeCtx({
				optionalConfig: {
					cronSchedules: {
						ok: true,
						value: {
							backup: {
								schedule: cronExpression,
								template: ["echo start", "false"], // 'false' will fail
							},
						},
					},
				} as unknown as AppContext["optionalConfig"],
			});

			const failingSandbox = {
				exec: async (_cmd: string) => {
					throw new Error("sandbox execution failed");
				},
			};

			const scheduler = new Scheduler(
				// biome-ignore lint/suspicious/noExplicitAny: test mock
				ctx as any,
				// biome-ignore lint/suspicious/noExplicitAny: test mock
				makeAgentLoopFactory() as any,
				{},
				failingSandbox,
			);
			const { stop } = scheduler.start(50);

			await waitFor(
				() => {
					const task = db
						.query("SELECT status, next_run_at FROM tasks WHERE id = ?")
						.get(taskId) as {
						status: string;
						next_run_at: string | null;
					} | null;
					return (
						task?.status === "pending" &&
						task?.next_run_at !== null &&
						new Date(task.next_run_at).getTime() > Date.now()
					);
				},
				{ message: "cron template task not rescheduled after hard error", timeoutMs: 5000 },
			);
			stop();

			const task = db.query("SELECT status, next_run_at FROM tasks WHERE id = ?").get(taskId) as {
				status: string;
				next_run_at: string | null;
			} | null;

			expect(task).not.toBeNull();
			expect(task?.status).toBe("pending");

			db.run("DELETE FROM tasks WHERE id = ?", [taskId]);
		});
	});

	// -----------------------------------------------------------------------
	// Bug #9: JSON trigger_spec from schedule command must be parsed for rescheduling
	// -----------------------------------------------------------------------
	describe("cron rescheduling with JSON trigger_spec", () => {
		it("reschedules cron task when trigger_spec is JSON-encoded (from schedule command)", async () => {
			const taskId = randomUUID();
			const now = new Date().toISOString();
			const pastTime = new Date(Date.now() - 60_000).toISOString();

			// This is the format the `schedule --every` command produces
			const triggerSpec = JSON.stringify({ type: "cron", expression: "0 * * * *" });

			db.run(
				`INSERT INTO tasks (
					id, type, status, trigger_spec, payload, thread_id,
					claimed_by, claimed_at, lease_id, next_run_at, last_run_at,
					run_count, max_runs, requires, model_hint, no_history,
					inject_mode, depends_on, require_success, alert_threshold,
					consecutive_failures, event_depth, no_quiescence,
					heartbeat_at, result, error, created_at, created_by, modified_at, deleted
				) VALUES (
					?, 'cron', 'pending', ?, NULL, NULL,
					NULL, NULL, NULL, ?, NULL,
					0, NULL, NULL, NULL, 0,
					'status', NULL, 0, 5,
					0, 0, 0,
					NULL, NULL, NULL, ?, 'system', ?, 0
				)`,
				[taskId, triggerSpec, pastTime, now, now],
			);

			const ctx = makeCtx();
			// biome-ignore lint/suspicious/noExplicitAny: test mock
			const scheduler = new Scheduler(ctx as any, makeAgentLoopFactory() as any);
			const { stop } = scheduler.start(50);

			await waitFor(
				() =>
					((
						db.query("SELECT run_count FROM tasks WHERE id = ?").get(taskId) as {
							run_count: number;
						} | null
					)?.run_count ?? 0) >= 1,
				{ message: "cron task did not run" },
			);
			stop();

			const task = db
				.query("SELECT status, next_run_at, run_count FROM tasks WHERE id = ?")
				.get(taskId) as {
				status: string;
				next_run_at: string | null;
				run_count: number;
			} | null;

			expect(task).not.toBeNull();
			// Task must have run at least once
			expect(task?.run_count).toBeGreaterThanOrEqual(1);
			// After completing, cron task should be rescheduled to a future time
			expect(task?.status).toBe("pending");
			expect(task?.next_run_at).not.toBeNull();
			// next_run_at should be in the future (not the old pastTime)
			// biome-ignore lint/style/noNonNullAssertion: asserted non-null by expect above
			const nextRun = new Date(task?.next_run_at!);
			expect(nextRun.getTime()).toBeGreaterThan(Date.now());

			db.run("DELETE FROM tasks WHERE id = ?", [taskId]);
		});
	});

	// -----------------------------------------------------------------------
	// Model hint validation at run time (Issue 6)
	// -----------------------------------------------------------------------
	describe("run-time model hint validation", () => {
		function insertTaskWithModelHint(id: string, modelHint: string, threadId?: string) {
			const now = new Date().toISOString();
			const pastTime = new Date(Date.now() - 60_000).toISOString();
			// Set consecutive_failures=2 (= DEFERRED_MAX_RETRIES) so failed tasks
			// stay failed and aren't auto-retried back to pending.
			db.run(
				`INSERT INTO tasks (
					id, type, status, trigger_spec, payload, thread_id,
					claimed_by, claimed_at, lease_id, next_run_at, last_run_at,
					run_count, max_runs, requires, model_hint, no_history,
					inject_mode, depends_on, require_success, alert_threshold,
					consecutive_failures, event_depth, no_quiescence,
					heartbeat_at, result, error, created_at, created_by, modified_at, deleted
				) VALUES (
					?, 'deferred', 'pending', 'manual', NULL, ?,
					NULL, NULL, NULL, ?, NULL,
					0, NULL, NULL, ?, 0,
					'status', NULL, 0, 5,
					2, 0, 0,
					NULL, NULL, NULL, ?, 'system', ?, 0
				)`,
				[id, threadId ?? null, pastTime, modelHint, now, now],
			);
		}

		it("marks task failed with clear error when model_hint is invalid at run time", async () => {
			const taskId = randomUUID();
			insertTaskWithModelHint(taskId, "nonexistent-model-xyz");

			let agentLoopCalled = false;
			const factory = () => {
				agentLoopCalled = true;
				return {
					run: async (): Promise<AgentLoopResult> => ({
						messagesCreated: 1,
						toolCallsMade: 0,
						filesChanged: 0,
					}),
				};
			};

			// modelValidator rejects the hint
			const ctx = makeCtx();
			const scheduler = new Scheduler(
				// biome-ignore lint/suspicious/noExplicitAny: test mock
				ctx as any,
				// biome-ignore lint/suspicious/noExplicitAny: test mock
				factory as any,
				{
					modelValidator: (_modelId: string) => ({
						ok: false,
						error: `Model "nonexistent-model-xyz" not found in cluster`,
					}),
				},
			);
			const { stop } = scheduler.start(50);
			await waitFor(
				() =>
					(
						db.query("SELECT status FROM tasks WHERE id = ?").get(taskId) as {
							status: string;
						} | null
					)?.status === "failed",
				{ message: "task did not fail on invalid model hint" },
			);
			stop();

			// Agent loop should NOT have been called
			expect(agentLoopCalled).toBe(false);

			// Task should be marked failed with a descriptive error
			const task = db.query("SELECT status, error FROM tasks WHERE id = ?").get(taskId) as {
				status: string;
				error: string | null;
			} | null;
			expect(task?.status).toBe("failed");
			expect(task?.error).toContain("nonexistent-model-xyz");

			db.run("DELETE FROM tasks WHERE id = ?", [taskId]);
		});

		it("runs normally when model_hint passes validation", async () => {
			const taskId = randomUUID();
			insertTaskWithModelHint(taskId, "valid-model");

			let agentLoopCalled = false;
			const factory = () => {
				agentLoopCalled = true;
				return {
					run: async (): Promise<AgentLoopResult> => ({
						messagesCreated: 1,
						toolCallsMade: 0,
						filesChanged: 0,
					}),
				};
			};

			const ctx = makeCtx();
			const scheduler = new Scheduler(
				// biome-ignore lint/suspicious/noExplicitAny: test mock
				ctx as any,
				// biome-ignore lint/suspicious/noExplicitAny: test mock
				factory as any,
				{
					modelValidator: (_modelId: string) => ({ ok: true }),
				},
			);
			const { stop } = scheduler.start(50);
			await waitFor(() => agentLoopCalled, { message: "agent loop not called" });
			stop();

			expect(agentLoopCalled).toBe(true);

			const task = db.query("SELECT status FROM tasks WHERE id = ?").get(taskId) as {
				status: string;
			} | null;
			expect(task?.status).toBe("completed");

			db.run("DELETE FROM tasks WHERE id = ?", [taskId]);
		});

		it("runs normally when no model_hint is set (validator not consulted)", async () => {
			const taskId = randomUUID();
			// No model_hint
			const now = new Date().toISOString();
			const pastTime = new Date(Date.now() - 60_000).toISOString();
			db.run(
				`INSERT INTO tasks (
					id, type, status, trigger_spec, payload, thread_id,
					claimed_by, claimed_at, lease_id, next_run_at, last_run_at,
					run_count, max_runs, requires, model_hint, no_history,
					inject_mode, depends_on, require_success, alert_threshold,
					consecutive_failures, event_depth, no_quiescence,
					heartbeat_at, result, error, created_at, created_by, modified_at, deleted
				) VALUES (
					?, 'deferred', 'pending', 'manual', NULL, NULL,
					NULL, NULL, NULL, ?, NULL,
					0, NULL, NULL, NULL, 0,
					'status', NULL, 0, 5,
					0, 0, 0,
					NULL, NULL, NULL, ?, 'system', ?, 0
				)`,
				[taskId, pastTime, now, now],
			);

			let agentLoopCalled = false;
			const factory = () => {
				agentLoopCalled = true;
				return {
					run: async (): Promise<AgentLoopResult> => ({
						messagesCreated: 1,
						toolCallsMade: 0,
						filesChanged: 0,
					}),
				};
			};

			const ctx = makeCtx();
			const scheduler = new Scheduler(
				// biome-ignore lint/suspicious/noExplicitAny: test mock
				ctx as any,
				// biome-ignore lint/suspicious/noExplicitAny: test mock
				factory as any,
				{
					// Validator that would reject everything — but should NOT be consulted
					// because model_hint is null
					modelValidator: (_modelId: string) => ({
						ok: false,
						error: "should never fire",
					}),
				},
			);
			const { stop } = scheduler.start(50);
			await waitFor(() => agentLoopCalled, { message: "agent loop not called" });
			stop();

			// Agent loop must still run because there's no model_hint to validate
			expect(agentLoopCalled).toBe(true);

			db.run("DELETE FROM tasks WHERE id = ?", [taskId]);
		});
	});

	// -----------------------------------------------------------------------
	// seedCronTasks from config
	// -----------------------------------------------------------------------
	describe("seedCronTasks", () => {
		it("seeds cron tasks from config on startup", () => {
			const cronConfigs = [
				{ name: "daily-backup", cron: "0 2 * * *", payload: "backup all" },
				{ name: "hourly-check", cron: "0 * * * *" },
			];

			const tasksBefore = (
				db.query("SELECT COUNT(*) as count FROM tasks WHERE type = 'cron'").get() as {
					count: number;
				}
			).count;

			seedCronTasks(db, cronConfigs, siteId);

			const tasksAfter = (
				db.query("SELECT COUNT(*) as count FROM tasks WHERE type = 'cron'").get() as {
					count: number;
				}
			).count;

			expect(tasksAfter).toBe(tasksBefore + 2);

			// Verify the tasks were created with correct fields
			const tasks = db
				.query(
					"SELECT * FROM tasks WHERE type = 'cron' AND created_by = 'system' ORDER BY trigger_spec",
				)
				.all() as Array<{
				id: string;
				type: string;
				status: string;
				trigger_spec: string;
				payload: string | null;
				next_run_at: string | null;
			}>;

			const dailyBackup = tasks.find((t) => t.trigger_spec === "0 2 * * *");
			expect(dailyBackup).toBeDefined();
			expect(dailyBackup?.status).toBe("pending");
			expect(dailyBackup?.payload).toBe("backup all");
			expect(dailyBackup?.next_run_at).not.toBeNull();

			const hourlyCheck = tasks.find((t) => t.trigger_spec === "0 * * * *");
			expect(hourlyCheck).toBeDefined();
			expect(hourlyCheck?.status).toBe("pending");
			expect(hourlyCheck?.next_run_at).not.toBeNull();
		});

		it("does not duplicate cron tasks on re-seed (uses INSERT OR IGNORE)", () => {
			const cronConfigs = [{ name: "unique-task", cron: "30 3 * * *" }];

			seedCronTasks(db, cronConfigs, siteId);
			const countAfterFirst = (
				db.query("SELECT COUNT(*) as count FROM tasks WHERE trigger_spec = '30 3 * * *'").get() as {
					count: number;
				}
			).count;

			// Seed again with the same config
			seedCronTasks(db, cronConfigs, siteId);
			const countAfterSecond = (
				db.query("SELECT COUNT(*) as count FROM tasks WHERE trigger_spec = '30 3 * * *'").get() as {
					count: number;
				}
			).count;

			// Should not have created a duplicate
			expect(countAfterSecond).toBe(countAfterFirst);
		});
	});

	// -----------------------------------------------------------------------
	// Thread title generation for scheduler threads
	// -----------------------------------------------------------------------
	describe("scheduler thread title generation", () => {
		it("creates threads with null title, not raw JSON payload", async () => {
			const taskId = randomUUID();
			const now = new Date().toISOString();
			const pastTime = new Date(Date.now() - 60_000).toISOString();
			const payload = JSON.stringify({ type: "deep_read", instructions: "Read something" });

			db.run(
				`INSERT INTO tasks (
					id, type, status, trigger_spec, payload, thread_id,
					claimed_by, claimed_at, lease_id, next_run_at, last_run_at,
					run_count, max_runs, requires, model_hint, no_history,
					inject_mode, depends_on, require_success, alert_threshold,
					consecutive_failures, event_depth, no_quiescence,
					heartbeat_at, result, error, created_at, created_by, modified_at, deleted
				) VALUES (
					?, 'deferred', 'pending', 'manual', ?, NULL,
					NULL, NULL, NULL, ?, NULL,
					0, NULL, NULL, NULL, 0,
					'status', NULL, 0, 5,
					0, 0, 0,
					NULL, NULL, NULL, ?, 'system', ?, 0
				)`,
				[taskId, payload, pastTime, now, now],
			);

			const ctx = makeCtx();
			// biome-ignore lint/suspicious/noExplicitAny: test mock
			const scheduler = new Scheduler(ctx as any, makeAgentLoopFactory() as any);
			const { stop } = scheduler.start(50);

			await waitFor(
				() =>
					(
						db.query("SELECT status FROM tasks WHERE id = ?").get(taskId) as {
							status: string;
						} | null
					)?.status === "completed",
				{ message: "task did not complete" },
			);
			stop();

			// The scheduler should have created a thread for this task.
			// The thread title must NOT be raw JSON — it should be null so
			// that generateThreadTitle can produce a proper title later.
			const task = db.query("SELECT thread_id FROM tasks WHERE id = ?").get(taskId) as {
				thread_id: string | null;
			} | null;
			expect(task?.thread_id).toBeTruthy();

			const thread = db
				.query("SELECT title FROM threads WHERE id = ?")
				.get(task?.thread_id ?? "") as {
				title: string | null;
			} | null;
			expect(thread).not.toBeNull();
			// Title should be null (not raw JSON payload)
			expect(thread?.title).toBeNull();

			// Clean up
			db.run("DELETE FROM tasks WHERE id = ?", [taskId]);
			if (task?.thread_id) {
				db.run("DELETE FROM threads WHERE id = ?", [task.thread_id]);
				db.run("DELETE FROM messages WHERE thread_id = ?", [task.thread_id]);
			}
		});

		it("calls generateTitle callback after successful task completion", async () => {
			const taskId = randomUUID();
			const now = new Date().toISOString();
			const pastTime = new Date(Date.now() - 60_000).toISOString();
			const payload = JSON.stringify({ type: "test_task" });

			db.run(
				`INSERT INTO tasks (
					id, type, status, trigger_spec, payload, thread_id,
					claimed_by, claimed_at, lease_id, next_run_at, last_run_at,
					run_count, max_runs, requires, model_hint, no_history,
					inject_mode, depends_on, require_success, alert_threshold,
					consecutive_failures, event_depth, no_quiescence,
					heartbeat_at, result, error, created_at, created_by, modified_at, deleted
				) VALUES (
					?, 'deferred', 'pending', 'manual', ?, NULL,
					NULL, NULL, NULL, ?, NULL,
					0, NULL, NULL, NULL, 0,
					'status', NULL, 0, 5,
					0, 0, 0,
					NULL, NULL, NULL, ?, 'system', ?, 0
				)`,
				[taskId, payload, pastTime, now, now],
			);

			const titleGenCalls: string[] = [];
			const ctx = makeCtx();
			// biome-ignore lint/suspicious/noExplicitAny: test mock
			const scheduler = new Scheduler(ctx as any, makeAgentLoopFactory() as any, {
				generateTitle: async (threadId: string) => {
					titleGenCalls.push(threadId);
				},
			});
			const { stop } = scheduler.start(50);

			await waitFor(
				() =>
					(
						db.query("SELECT status FROM tasks WHERE id = ?").get(taskId) as {
							status: string;
						} | null
					)?.status === "completed",
				{ message: "task did not complete" },
			);
			stop();

			// generateTitle should have been called with the thread ID
			expect(titleGenCalls.length).toBe(1);

			// Clean up
			const task = db.query("SELECT thread_id FROM tasks WHERE id = ?").get(taskId) as {
				thread_id: string | null;
			} | null;
			db.run("DELETE FROM tasks WHERE id = ?", [taskId]);
			if (task?.thread_id) {
				db.run("DELETE FROM threads WHERE id = ?", [task.thread_id]);
				db.run("DELETE FROM messages WHERE thread_id = ?", [task.thread_id]);
			}
		});
	});

	// -----------------------------------------------------------------------
	// Cron thread rotation
	// -----------------------------------------------------------------------
	describe("cron thread rotation", () => {
		it("rotates thread when message count exceeds threshold", async () => {
			const taskId = randomUUID();
			const oldThreadId = randomUUID();
			const now = new Date().toISOString();
			const pastTime = new Date(Date.now() - 60_000).toISOString();

			// Create the old thread
			db.run(
				"INSERT INTO threads (id, user_id, interface, host_origin, color, title, summary, summary_through, summary_model_id, extracted_through, created_at, last_message_at, modified_at, deleted) VALUES (?, 'system', 'scheduler', 'test-host', 0, NULL, NULL, NULL, NULL, NULL, ?, ?, ?, 0)",
				[oldThreadId, now, now, now],
			);

			// Insert 201 messages to exceed the 200-message threshold
			for (let i = 0; i < 201; i++) {
				db.run(
					"INSERT INTO messages (id, thread_id, role, content, model_id, tool_name, created_at, modified_at, host_origin, deleted) VALUES (?, ?, 'user', 'msg', NULL, NULL, ?, ?, 'test-host', 0)",
					[randomUUID(), oldThreadId, now, now],
				);
			}

			// Create cron task pointing to the old thread
			db.run(
				`INSERT INTO tasks (
					id, type, status, trigger_spec, payload, thread_id,
					claimed_by, claimed_at, lease_id, next_run_at, last_run_at,
					run_count, max_runs, requires, model_hint, no_history,
					inject_mode, depends_on, require_success, alert_threshold,
					consecutive_failures, event_depth, no_quiescence,
					heartbeat_at, result, error, created_at, created_by, modified_at, deleted
				) VALUES (
					?, 'cron', 'pending', '{"type":"cron","expression":"0 * * * *"}', '{"prompt":"test"}', ?,
					NULL, NULL, NULL, ?, NULL,
					0, NULL, NULL, NULL, 0,
					'status', NULL, 0, 5,
					0, 0, 0,
					NULL, NULL, NULL, ?, 'system', ?, 0
				)`,
				[taskId, oldThreadId, pastTime, now, now],
			);

			let capturedConfig: { threadId: string } | null = null;
			const factory = (config: { threadId: string }) => {
				capturedConfig = config;
				return {
					run: async () => ({ messagesCreated: 1, toolCallsMade: 0, filesChanged: 0 }),
				};
			};

			const ctx = makeCtx();
			// biome-ignore lint/suspicious/noExplicitAny: test mock
			const scheduler = new Scheduler(ctx as any, factory as any);
			const { stop } = scheduler.start(50);

			await waitFor(() => capturedConfig !== null, {
				message: "agent loop factory not called",
			});
			stop();

			// The factory should have received the NEW threadId (not the old one)
			expect(capturedConfig).not.toBeNull();
			// biome-ignore lint/style/noNonNullAssertion: verified not null above
			expect(capturedConfig!.threadId).not.toBe(oldThreadId);

			// The task row should now point to the new thread
			const taskRow = db.query("SELECT thread_id FROM tasks WHERE id = ?").get(taskId) as {
				thread_id: string;
			};
			expect(taskRow.thread_id).not.toBe(oldThreadId);

			// The old thread should still exist (not deleted)
			const oldThread = db.query("SELECT id FROM threads WHERE id = ?").get(oldThreadId) as {
				id: string;
			} | null;
			expect(oldThread).not.toBeNull();

			// Clean up
			db.run("DELETE FROM tasks WHERE id = ?", [taskId]);
			db.run("DELETE FROM threads WHERE id IN (?, ?)", [oldThreadId, taskRow.thread_id]);
			db.run("DELETE FROM messages WHERE thread_id IN (?, ?)", [oldThreadId, taskRow.thread_id]);
		});

		it("does not rotate thread when message count is below threshold", async () => {
			const taskId = randomUUID();
			const threadId = randomUUID();
			const now = new Date().toISOString();
			const pastTime = new Date(Date.now() - 60_000).toISOString();

			// Create thread with only 10 messages (well below threshold)
			db.run(
				"INSERT INTO threads (id, user_id, interface, host_origin, color, title, summary, summary_through, summary_model_id, extracted_through, created_at, last_message_at, modified_at, deleted) VALUES (?, 'system', 'scheduler', 'test-host', 0, NULL, NULL, NULL, NULL, NULL, ?, ?, ?, 0)",
				[threadId, now, now, now],
			);

			for (let i = 0; i < 10; i++) {
				db.run(
					"INSERT INTO messages (id, thread_id, role, content, model_id, tool_name, created_at, modified_at, host_origin, deleted) VALUES (?, ?, 'user', 'msg', NULL, NULL, ?, ?, 'test-host', 0)",
					[randomUUID(), threadId, now, now],
				);
			}

			db.run(
				`INSERT INTO tasks (
					id, type, status, trigger_spec, payload, thread_id,
					claimed_by, claimed_at, lease_id, next_run_at, last_run_at,
					run_count, max_runs, requires, model_hint, no_history,
					inject_mode, depends_on, require_success, alert_threshold,
					consecutive_failures, event_depth, no_quiescence,
					heartbeat_at, result, error, created_at, created_by, modified_at, deleted
				) VALUES (
					?, 'cron', 'pending', '{"type":"cron","expression":"0 * * * *"}', '{"prompt":"test"}', ?,
					NULL, NULL, NULL, ?, NULL,
					0, NULL, NULL, NULL, 0,
					'status', NULL, 0, 5,
					0, 0, 0,
					NULL, NULL, NULL, ?, 'system', ?, 0
				)`,
				[taskId, threadId, pastTime, now, now],
			);

			let capturedConfig: { threadId: string } | null = null;
			const factory = (config: { threadId: string }) => {
				capturedConfig = config;
				return {
					run: async () => ({ messagesCreated: 1, toolCallsMade: 0, filesChanged: 0 }),
				};
			};

			const ctx = makeCtx();
			// biome-ignore lint/suspicious/noExplicitAny: test mock
			const scheduler = new Scheduler(ctx as any, factory as any);
			const { stop } = scheduler.start(50);

			await waitFor(() => capturedConfig !== null, {
				message: "agent loop factory not called",
			});
			stop();

			// Thread should NOT have been rotated
			// biome-ignore lint/style/noNonNullAssertion: verified not null by waitFor
			expect(capturedConfig!.threadId).toBe(threadId);

			const finalTask = db.query("SELECT thread_id FROM tasks WHERE id = ?").get(taskId) as {
				thread_id: string;
			};
			expect(finalTask.thread_id).toBe(threadId);

			// Clean up
			db.run("DELETE FROM tasks WHERE id = ?", [taskId]);
			db.run("DELETE FROM threads WHERE id = ?", [threadId]);
			db.run("DELETE FROM messages WHERE thread_id = ?", [threadId]);
		});
	});
});
