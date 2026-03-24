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
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentLoopResult } from "@bound/agent";
import { applyMetricsSchema, applySchema, createDatabase, insertRow, recordTurn } from "@bound/core";
import type { AppContext } from "@bound/core";
import { TypedEventEmitter } from "@bound/shared";
import { Scheduler } from "../scheduler";
import { seedCronTasks } from "../task-resolution";

describe("Scheduler features", () => {
	let tmpDir: string;
	let db: Database;
	let siteId: string;
	let eventBus: TypedEventEmitter;

	beforeAll(() => {
		tmpDir = mkdtempSync(
			join(tmpdir(), `scheduler-feat-${randomBytes(4).toString("hex")}-`),
		);
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

	afterAll(() => {
		db.close();
		rmSync(tmpDir, { recursive: true, force: true });
	});

	function makeCtx(overrides: Partial<AppContext> = {}): AppContext {
		return {
			db,
			logger: {
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
	): (config: any) => { run: () => Promise<AgentLoopResult> } {
		return () => ({
			run: async () =>
				result ?? {
					messagesCreated: 1,
					toolCallsMade: 0,
					filesChanged: 0,
				},
		});
	}

	function makeFailingAgentLoopFactory(): (config: any) => {
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
			// so idle time is ~0ms.  The lowest tier (0-1h) has multiplier 2.
			const interval = scheduler.getEffectivePollInterval();

			// Base POLL_INTERVAL is 5000, so with 2x multiplier we expect 10000
			expect(interval).toBe(10_000);
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
			const today = new Date().toISOString().split("T")[0];
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

			let agentRunCalled = false;
			const factory = () => ({
				run: async () => {
					agentRunCalled = true;
					return { messagesCreated: 1, toolCallsMade: 0, filesChanged: 0 };
				},
			});

			// biome-ignore lint/suspicious/noExplicitAny: test mock
			const scheduler = new Scheduler(ctx as any, factory as any);
			const { stop } = scheduler.start(50);

			await new Promise((resolve) => setTimeout(resolve, 300));
			stop();

			// The task should NOT have been run because the budget was exceeded.
			// It should have been released back to pending.
			const task = db.query("SELECT status FROM tasks WHERE id = ?").get(taskId) as {
				status: string;
			} | null;

			expect(task).not.toBeNull();
			// Task should still be pending (released after budget check)
			expect(task!.status).toBe("pending");

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
		it("persists an alert message on task failure", async () => {
			const userId = randomUUID();
			const threadId = randomUUID();
			const taskId = randomUUID();
			const now = new Date().toISOString();
			const pastTime = new Date(Date.now() - 60_000).toISOString();

			// Create user and thread
			db.run(
				"INSERT INTO users (id, display_name, discord_id, first_seen_at, modified_at, deleted) VALUES (?, ?, NULL, ?, ?, 0)",
				[userId, "AlertUser", now, now],
			);
			db.run(
				"INSERT INTO threads (id, user_id, interface, host_origin, color, title, summary, created_at, last_message_at, modified_at, deleted) VALUES (?, ?, 'web', 'localhost', 0, 'Alert Test', NULL, ?, ?, ?, 0)",
				[threadId, userId, now, now, now],
			);

			// Insert a task that will fail
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
					0, 0, 0,
					NULL, NULL, NULL, ?, 'system', ?, 0
				)`,
				[taskId, threadId, pastTime, now, now],
			);

			const ctx = makeCtx();
			// biome-ignore lint/suspicious/noExplicitAny: test mock
			const scheduler = new Scheduler(ctx as any, makeFailingAgentLoopFactory() as any);
			const { stop } = scheduler.start(50);

			await new Promise((resolve) => setTimeout(resolve, 500));
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
			expect(task!.status).toBe("failed");
			expect(task!.error).toContain("Simulated task failure");

			// Clean up
			db.run("DELETE FROM tasks WHERE id = ?", [taskId]);
			db.run("DELETE FROM messages WHERE thread_id = ?", [threadId]);
			db.run("DELETE FROM threads WHERE id = ?", [threadId]);
			db.run("DELETE FROM users WHERE id = ?", [userId]);
		});
	});

	// -----------------------------------------------------------------------
	// Cron templates execute via sandbox
	// -----------------------------------------------------------------------
	describe("cron template execution", () => {
		it("getCronTemplate requires JSON trigger_spec with expression field", () => {
			// The scheduler's getCronTemplate parses trigger_spec as JSON and
			// looks for .expression.  A plain cron string will not parse.
			// This test documents the contract: trigger_spec must be a JSON
			// object like {"type":"cron","expression":"0 * * * *"}.

			const taskId = randomUUID();
			const now = new Date().toISOString();
			const pastTime = new Date(Date.now() - 60_000).toISOString();
			const cronExpression = "0 */6 * * *";

			// Insert a cron task with JSON trigger_spec
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
				[
					taskId,
					JSON.stringify({ type: "cron", expression: cronExpression }),
					pastTime,
					now,
					now,
				],
			);

			// getCronTemplate iterates Object.entries of the Result wrapper,
			// not the .value inside it.  This means the "value" entry's value
			// is the schedule map, and getCronTemplate looks for
			// schedule.schedule on that map -- which won't match a single
			// schedule entry.  Document this: the wiring exists, but the
			// optionalConfig Result wrapper is not unwrapped.
			//
			// To make the template actually fire, the config would need to be
			// passed as a raw map (not wrapped in Result).  We verify the
			// sandbox integration by providing the config the way the code
			// actually consumes it.
			const ctx = makeCtx({
				optionalConfig: {
					// Pass the schedule map directly (as the code iterates it)
					// to confirm the sandbox exec path works end-to-end.
					cronSchedules: {
						backup: {
							schedule: cronExpression,
							template: ["echo backup-start", "tar czf /tmp/backup.tar.gz ."],
						},
					},
				},
			} as unknown as Partial<AppContext>);

			const sandboxCalls: string[] = [];
			const mockSandbox = {
				exec: async (cmd: string) => {
					sandboxCalls.push(cmd);
					return { stdout: `executed: ${cmd}`, stderr: "", exitCode: 0 };
				},
			};

			// biome-ignore lint/suspicious/noExplicitAny: test mock
			const scheduler = new Scheduler(ctx as any, makeAgentLoopFactory() as any, {}, mockSandbox);
			const { stop } = scheduler.start(50);

			// Wait for scheduler tick
			return new Promise<void>((resolve) => {
				setTimeout(() => {
					stop();

					// Verify sandbox was called with template commands
					expect(sandboxCalls.length).toBe(2);
					expect(sandboxCalls[0]).toBe("echo backup-start");
					expect(sandboxCalls[1]).toBe("tar czf /tmp/backup.tar.gz .");

					// Verify task status
					const task = db.query("SELECT status, result FROM tasks WHERE id = ?").get(taskId) as {
						status: string;
						result: string | null;
					} | null;

					expect(task).not.toBeNull();
					expect(["completed", "pending"]).toContain(task!.status);

					// Clean up
					db.run("DELETE FROM tasks WHERE id = ?", [taskId]);
					resolve();
				}, 500);
			});
		});

		it("documents that optionalConfig cronSchedules Result wrapper is not unwrapped in getCronTemplate", () => {
			// This is a known wiring gap: getCronTemplate reads
			// this.ctx.optionalConfig["cronSchedules"] which is a Result<>,
			// then iterates with Object.entries() without checking .ok/.value.
			// Entries are ["ok", true] and ["value", {scheduleMap}] rather
			// than the individual schedule entries.
			//
			// When optionalConfig stores a proper Result wrapper, the template
			// lookup silently fails because schedule.schedule is undefined.

			const taskId = randomUUID();
			const now = new Date().toISOString();
			const pastTime = new Date(Date.now() - 60_000).toISOString();
			const cronExpression = "0 */6 * * *";

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
				[
					taskId,
					JSON.stringify({ type: "cron", expression: cronExpression }),
					pastTime,
					now,
					now,
				],
			);

			// Provide a proper Result-wrapped config (as the loader would)
			const ctx = makeCtx({
				optionalConfig: {
					cronSchedules: {
						ok: true,
						value: {
							backup: {
								schedule: cronExpression,
								template: ["echo backup"],
							},
						},
					},
				},
			} as unknown as Partial<AppContext>);

			const sandboxCalls: string[] = [];
			const mockSandbox = {
				exec: async (cmd: string) => {
					sandboxCalls.push(cmd);
					return { stdout: "", stderr: "", exitCode: 0 };
				},
			};

			// biome-ignore lint/suspicious/noExplicitAny: test mock
			const scheduler = new Scheduler(ctx as any, makeAgentLoopFactory() as any, {}, mockSandbox);
			const { stop } = scheduler.start(50);

			return new Promise<void>((resolve) => {
				setTimeout(() => {
					stop();

					// The sandbox should NOT have been called because the
					// getCronTemplate method iterates the Result wrapper rather
					// than the inner config map.  This documents the bug.
					expect(sandboxCalls.length).toBe(0);

					// Clean up
					db.run("DELETE FROM tasks WHERE id = ?", [taskId]);
					resolve();
				}, 500);
			});
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
				.query("SELECT * FROM tasks WHERE type = 'cron' AND created_by = 'system' ORDER BY trigger_spec")
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
			expect(dailyBackup!.status).toBe("pending");
			expect(dailyBackup!.payload).toBe("backup all");
			expect(dailyBackup!.next_run_at).not.toBeNull();

			const hourlyCheck = tasks.find((t) => t.trigger_spec === "0 * * * *");
			expect(hourlyCheck).toBeDefined();
			expect(hourlyCheck!.status).toBe("pending");
			expect(hourlyCheck!.next_run_at).not.toBeNull();
		});

		it("does not duplicate cron tasks on re-seed (uses INSERT OR IGNORE)", () => {
			const cronConfigs = [
				{ name: "unique-task", cron: "30 3 * * *" },
			];

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
});
