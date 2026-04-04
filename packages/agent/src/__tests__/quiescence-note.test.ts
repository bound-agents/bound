/**
 * Quiescence note injection tests.
 *
 * Verifies that quiescence notes are correctly injected into task threads
 * based on idle duration, system activity, and task type.
 *
 * Verifies:
 * - AC5.2: Quiescence note injected for heartbeat tasks when idle > 30min
 * - AC5.3: Quiescence note injected for cron tasks when idle > 30min
 * - AC5.4: No quiescence note when system is active (idle < 30min)
 * - Multiplier accuracy at tier boundaries
 * - Idle duration formatting
 */

import type { Database } from "bun:sqlite";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentLoopConfig, AgentLoopResult } from "@bound/agent";
import { applyMetricsSchema, applySchema, createDatabase } from "@bound/core";
import type { AppContext } from "@bound/core";
import { TypedEventEmitter } from "@bound/shared";
import { Scheduler, computeQuiescenceMultiplier, formatIdleDuration } from "../scheduler";

describe("computeQuiescenceMultiplier", () => {
	it("returns 2x for 0ms idle (tier 0 minimum)", () => {
		const now = new Date();
		const multiplier = computeQuiescenceMultiplier(now);
		expect(multiplier).toBe(2);
	});

	it("returns 2x for 30min idle (still tier 0)", () => {
		const thirtyMinAgo = new Date(Date.now() - 30 * 60 * 1000);
		const multiplier = computeQuiescenceMultiplier(thirtyMinAgo);
		// 30min is below 1h threshold (tier 0)
		expect(multiplier).toBe(2);
	});

	it("returns 3x for 2h idle (tier 1)", () => {
		const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000);
		const multiplier = computeQuiescenceMultiplier(twoHoursAgo);
		// 2h falls into tier 1 (1-4h range)
		expect(multiplier).toBe(3);
	});

	it("returns 5x for 5h idle (tier 2)", () => {
		const fiveHoursAgo = new Date(Date.now() - 5 * 60 * 60 * 1000);
		const multiplier = computeQuiescenceMultiplier(fiveHoursAgo);
		// 5h falls into tier 2 (4-12h range)
		expect(multiplier).toBe(5);
	});

	it("returns 10x for 13h idle (tier 3)", () => {
		const thirteenHoursAgo = new Date(Date.now() - 13 * 60 * 60 * 1000);
		const multiplier = computeQuiescenceMultiplier(thirteenHoursAgo);
		// 13h falls into tier 3 (12h+ range)
		expect(multiplier).toBe(10);
	});
});

describe("formatIdleDuration", () => {
	it("formats 0 minutes correctly", () => {
		const ms = 0;
		const formatted = formatIdleDuration(ms);
		expect(formatted).toBe("0m");
	});

	it("formats 30 minutes correctly", () => {
		const ms = 30 * 60_000;
		const formatted = formatIdleDuration(ms);
		expect(formatted).toBe("30m");
	});

	it("formats 2h 15m correctly", () => {
		const ms = (2 * 60 + 15) * 60_000;
		const formatted = formatIdleDuration(ms);
		expect(formatted).toBe("2h 15m");
	});

	it("formats 5 hours correctly", () => {
		const ms = 5 * 3_600_000;
		const formatted = formatIdleDuration(ms);
		expect(formatted).toBe("5h 0m");
	});

	it("formats 1 minute correctly", () => {
		const ms = 1 * 60_000;
		const formatted = formatIdleDuration(ms);
		expect(formatted).toBe("1m");
	});
});

describe("Quiescence note injection", () => {
	let tmpDir: string;
	let db: Database;
	let siteId: string;
	let eventBus: TypedEventEmitter;

	beforeAll(() => {
		tmpDir = mkdtempSync(join(tmpdir(), `quiescence-${randomBytes(4).toString("hex")}-`));
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
		db.run("DELETE FROM tasks");
		db.run("DELETE FROM threads");
		db.run("DELETE FROM messages");
	});

	afterAll(() => {
		db.close();
		rmSync(tmpDir, { recursive: true, force: true });
	});

	function makeCtx(): AppContext {
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
					daily_budget_usd: 100,
				},
			},
			optionalConfig: {},
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

	function insertHeartbeatTask(
		intervalMs: number,
		threadId?: string,
	): { taskId: string; threadId: string } {
		const taskId = randomUUID();
		const tid = threadId || randomUUID();
		const now = new Date().toISOString();
		const triggerSpec = JSON.stringify({ type: "heartbeat", interval_ms: intervalMs });

		// Insert thread first
		db.run(
			`INSERT INTO threads (
				id, user_id, interface, host_origin, color, title, summary,
				summary_through, summary_model_id, extracted_through,
				created_at, last_message_at, modified_at, deleted
			) VALUES (?, 'system', 'scheduler', ?, 0, NULL, NULL, NULL, NULL, NULL, ?, ?, ?, 0)`,
			[tid, "test-host", now, now, now],
		);

		// Insert task
		db.run(
			`INSERT INTO tasks (
				id, type, status, trigger_spec, payload, thread_id,
				claimed_by, claimed_at, lease_id, next_run_at, last_run_at,
				run_count, max_runs, requires, model_hint, no_history,
				inject_mode, depends_on, require_success, alert_threshold,
				consecutive_failures, event_depth, no_quiescence,
				heartbeat_at, result, error, created_at, created_by, modified_at, deleted
			) VALUES (
				?, 'heartbeat', 'claimed', ?, NULL, ?,
				'test-host', ?, NULL, NULL, NULL,
				0, NULL, NULL, NULL, 0,
				'status', NULL, 0, 5,
				0, 0, 0,
				NULL, NULL, NULL, ?, 'system', ?, 0
			)`,
			[taskId, triggerSpec, tid, now, now, now],
		);

		return { taskId, threadId: tid };
	}

	function insertCronTask(
		schedule: string,
		threadId?: string,
	): { taskId: string; threadId: string } {
		const taskId = randomUUID();
		const tid = threadId || randomUUID();
		const now = new Date().toISOString();
		const triggerSpec = JSON.stringify({ type: "cron", expression: schedule });

		// Insert thread first
		db.run(
			`INSERT INTO threads (
				id, user_id, interface, host_origin, color, title, summary,
				summary_through, summary_model_id, extracted_through,
				created_at, last_message_at, modified_at, deleted
			) VALUES (?, 'system', 'scheduler', ?, 0, NULL, NULL, NULL, NULL, NULL, ?, ?, ?, 0)`,
			[tid, "test-host", now, now, now],
		);

		// Insert task
		db.run(
			`INSERT INTO tasks (
				id, type, status, trigger_spec, payload, thread_id,
				claimed_by, claimed_at, lease_id, next_run_at, last_run_at,
				run_count, max_runs, requires, model_hint, no_history,
				inject_mode, depends_on, require_success, alert_threshold,
				consecutive_failures, event_depth, no_quiescence,
				heartbeat_at, result, error, created_at, created_by, modified_at, deleted
			) VALUES (
				?, 'cron', 'claimed', ?, NULL, ?,
				'test-host', ?, NULL, ?, NULL,
				0, NULL, NULL, NULL, 0,
				'status', NULL, 0, 5,
				0, 0, 0,
				NULL, NULL, NULL, ?, 'system', ?, 0
			)`,
			[taskId, triggerSpec, tid, now, now, now, now],
		);

		return { taskId, threadId: tid };
	}

	// biome-ignore lint/suspicious/noExplicitAny: Dynamic query result
	function getThreadMessages(threadId: string): Array<any> {
		return (
			db
				.query("SELECT * FROM messages WHERE thread_id = ? ORDER BY created_at ASC")
				// biome-ignore lint/suspicious/noExplicitAny: Dynamic query result cast
				.all(threadId) as any[]
		);
	}

	// AC5.2: Heartbeat quiescence note
	it("injects quiescence note for heartbeat tasks when idle > 30min (AC5.2)", async () => {
		const { taskId, threadId } = insertHeartbeatTask(30 * 60 * 1000);

		// Simulate 2 hours idle (falls into tier 1: 3x)
		const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000);

		const ctx = makeCtx();
		// biome-ignore lint/suspicious/noExplicitAny: test mock
		const scheduler = new Scheduler(ctx as any, makeAgentLoopFactory());

		// Manually set scheduler's lastUserInteractionAt to 2 hours ago
		// We access private field for test purposes
		// biome-ignore lint/suspicious/noExplicitAny: test access to private field
		(scheduler as any).lastUserInteractionAt = twoHoursAgo;

		// Run the task (which triggers runTask and note injection)
		await new Promise<void>((resolve) => {
			// biome-ignore lint/suspicious/noExplicitAny: test access to private field
			const originalRunningTasks = (scheduler as any).runningTasks;
			// biome-ignore lint/suspicious/noExplicitAny: test access to private field
			(scheduler as any).runningTasks = new Map([
				[taskId, { leaseId: randomUUID(), startedAt: new Date() }],
			]);
			// biome-ignore lint/suspicious/noExplicitAny: test access to private field
			(scheduler as any).runTask(db.query("SELECT * FROM tasks WHERE id = ?").get(taskId));
			// Give the async runTask time to complete
			setTimeout(() => {
				// biome-ignore lint/suspicious/noExplicitAny: test access to private field
				(scheduler as any).runningTasks = originalRunningTasks;
				resolve();
			}, 100);
		});

		// Verify quiescence note was injected
		const messages = getThreadMessages(threadId);
		const quiescenceMessage = messages.find((m) => m.content.includes("Quiescence is active"));
		expect(quiescenceMessage).toBeDefined();
		expect(quiescenceMessage?.content).toContain("3x"); // tier 1 multiplier
		expect(quiescenceMessage?.content).toContain("30min"); // base interval
		expect(quiescenceMessage?.content).toContain("90min"); // effective interval (30 * 3)
	});

	// AC5.3: Cron quiescence note
	it("injects quiescence note for cron tasks when idle > 30min (AC5.3)", async () => {
		const { taskId, threadId } = insertCronTask("0 * * * *"); // Hourly

		// Simulate 3 hours idle (falls into tier 1: 3x)
		const threeHoursAgo = new Date(Date.now() - 3 * 60 * 60 * 1000);

		const ctx = makeCtx();
		// biome-ignore lint/suspicious/noExplicitAny: test mock
		const scheduler = new Scheduler(ctx as any, makeAgentLoopFactory());

		// Set lastUserInteractionAt to 3 hours ago
		// biome-ignore lint/suspicious/noExplicitAny: test access to private field
		(scheduler as any).lastUserInteractionAt = threeHoursAgo;

		// Run the task
		await new Promise<void>((resolve) => {
			// biome-ignore lint/suspicious/noExplicitAny: test access to private field
			const originalRunningTasks = (scheduler as any).runningTasks;
			// biome-ignore lint/suspicious/noExplicitAny: test access to private field
			(scheduler as any).runningTasks = new Map([
				[taskId, { leaseId: randomUUID(), startedAt: new Date() }],
			]);
			// biome-ignore lint/suspicious/noExplicitAny: test access to private field
			(scheduler as any).runTask(db.query("SELECT * FROM tasks WHERE id = ?").get(taskId));
			setTimeout(() => {
				// biome-ignore lint/suspicious/noExplicitAny: test access to private field
				(scheduler as any).runningTasks = originalRunningTasks;
				resolve();
			}, 100);
		});

		// Verify quiescence note was injected with cron expression
		const messages = getThreadMessages(threadId);
		const quiescenceMessage = messages.find((m) => m.content.includes("Quiescence is active"));
		expect(quiescenceMessage).toBeDefined();
		expect(quiescenceMessage?.content).toContain("0 * * * *"); // cron expression extracted
		expect(quiescenceMessage?.content).toContain("3x"); // tier 1 multiplier
		expect(quiescenceMessage?.content).toContain("schedule stretched by 3x");
	});

	// AC5.4: No quiescence note when system is active
	it("does not inject quiescence note when idle < 30min (AC5.4)", async () => {
		const { taskId, threadId } = insertHeartbeatTask(30 * 60 * 1000);

		// Simulate only 5 minutes idle (below QUIESCENCE_NOTE_THRESHOLD of 30 minutes)
		const fiveMinutesAgo = new Date(Date.now() - 5 * 60 * 1000);

		const ctx = makeCtx();
		// biome-ignore lint/suspicious/noExplicitAny: test mock
		const scheduler = new Scheduler(ctx as any, makeAgentLoopFactory());

		// Set lastUserInteractionAt to 5 minutes ago
		// biome-ignore lint/suspicious/noExplicitAny: test access to private field
		(scheduler as any).lastUserInteractionAt = fiveMinutesAgo;

		// Run the task
		await new Promise<void>((resolve) => {
			// biome-ignore lint/suspicious/noExplicitAny: test access to private field
			const originalRunningTasks = (scheduler as any).runningTasks;
			// biome-ignore lint/suspicious/noExplicitAny: test access to private field
			(scheduler as any).runningTasks = new Map([
				[taskId, { leaseId: randomUUID(), startedAt: new Date() }],
			]);
			// biome-ignore lint/suspicious/noExplicitAny: test access to private field
			(scheduler as any).runTask(db.query("SELECT * FROM tasks WHERE id = ?").get(taskId));
			setTimeout(() => {
				// biome-ignore lint/suspicious/noExplicitAny: test access to private field
				(scheduler as any).runningTasks = originalRunningTasks;
				resolve();
			}, 100);
		});

		// Verify NO quiescence note was injected
		const messages = getThreadMessages(threadId);
		const quiescenceMessage = messages.find((m) => m.content.includes("Quiescence is active"));
		expect(quiescenceMessage).toBeUndefined();
	});

	// Verify correct multiplier in heartbeat note
	it("includes correct 5x multiplier for 5h idle in heartbeat note", async () => {
		const { taskId, threadId } = insertHeartbeatTask(30 * 60 * 1000);

		// 5 hours ago (tier 2: 5x)
		const fiveHoursAgo = new Date(Date.now() - 5 * 60 * 60 * 1000);

		const ctx = makeCtx();
		// biome-ignore lint/suspicious/noExplicitAny: test mock
		const scheduler = new Scheduler(ctx as any, makeAgentLoopFactory());

		// biome-ignore lint/suspicious/noExplicitAny: test access to private field
		(scheduler as any).lastUserInteractionAt = fiveHoursAgo;

		await new Promise<void>((resolve) => {
			// biome-ignore lint/suspicious/noExplicitAny: test access to private field
			const originalRunningTasks = (scheduler as any).runningTasks;
			// biome-ignore lint/suspicious/noExplicitAny: test access to private field
			(scheduler as any).runningTasks = new Map([
				[taskId, { leaseId: randomUUID(), startedAt: new Date() }],
			]);
			// biome-ignore lint/suspicious/noExplicitAny: test access to private field
			(scheduler as any).runTask(db.query("SELECT * FROM tasks WHERE id = ?").get(taskId));
			setTimeout(() => {
				// biome-ignore lint/suspicious/noExplicitAny: test access to private field
				(scheduler as any).runningTasks = originalRunningTasks;
				resolve();
			}, 100);
		});

		const messages = getThreadMessages(threadId);
		const quiescenceMessage = messages.find((m) => m.content.includes("Quiescence is active"));
		expect(quiescenceMessage).toBeDefined();
		expect(quiescenceMessage?.content).toContain("5x"); // tier 2 multiplier
		expect(quiescenceMessage?.content).toContain("150min"); // effective interval (30 * 5)
	});

	it("includes correct 10x multiplier for 13h idle in heartbeat note", async () => {
		const { taskId, threadId } = insertHeartbeatTask(30 * 60 * 1000);

		// 13 hours ago (tier 3: 10x)
		const thirteenHoursAgo = new Date(Date.now() - 13 * 60 * 60 * 1000);

		const ctx = makeCtx();
		// biome-ignore lint/suspicious/noExplicitAny: test mock
		const scheduler = new Scheduler(ctx as any, makeAgentLoopFactory());

		// biome-ignore lint/suspicious/noExplicitAny: test access to private field
		(scheduler as any).lastUserInteractionAt = thirteenHoursAgo;

		await new Promise<void>((resolve) => {
			// biome-ignore lint/suspicious/noExplicitAny: test access to private field
			const originalRunningTasks = (scheduler as any).runningTasks;
			// biome-ignore lint/suspicious/noExplicitAny: test access to private field
			(scheduler as any).runningTasks = new Map([
				[taskId, { leaseId: randomUUID(), startedAt: new Date() }],
			]);
			// biome-ignore lint/suspicious/noExplicitAny: test access to private field
			(scheduler as any).runTask(db.query("SELECT * FROM tasks WHERE id = ?").get(taskId));
			setTimeout(() => {
				// biome-ignore lint/suspicious/noExplicitAny: test access to private field
				(scheduler as any).runningTasks = originalRunningTasks;
				resolve();
			}, 100);
		});

		const messages = getThreadMessages(threadId);
		const quiescenceMessage = messages.find((m) => m.content.includes("Quiescence is active"));
		expect(quiescenceMessage).toBeDefined();
		expect(quiescenceMessage?.content).toContain("10x"); // tier 3 multiplier
		expect(quiescenceMessage?.content).toContain("300min"); // effective interval (30 * 10)
	});

	// Verify note format and content
	it("heartbeat note includes idle duration", async () => {
		const { taskId, threadId } = insertHeartbeatTask(30 * 60 * 1000);

		// 2 hours idle
		const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000);

		const ctx = makeCtx();
		// biome-ignore lint/suspicious/noExplicitAny: test mock
		const scheduler = new Scheduler(ctx as any, makeAgentLoopFactory());

		// biome-ignore lint/suspicious/noExplicitAny: test access to private field
		(scheduler as any).lastUserInteractionAt = twoHoursAgo;

		await new Promise<void>((resolve) => {
			// biome-ignore lint/suspicious/noExplicitAny: test access to private field
			const originalRunningTasks = (scheduler as any).runningTasks;
			// biome-ignore lint/suspicious/noExplicitAny: test access to private field
			(scheduler as any).runningTasks = new Map([
				[taskId, { leaseId: randomUUID(), startedAt: new Date() }],
			]);
			// biome-ignore lint/suspicious/noExplicitAny: test access to private field
			(scheduler as any).runTask(db.query("SELECT * FROM tasks WHERE id = ?").get(taskId));
			setTimeout(() => {
				// biome-ignore lint/suspicious/noExplicitAny: test access to private field
				(scheduler as any).runningTasks = originalRunningTasks;
				resolve();
			}, 100);
		});

		const messages = getThreadMessages(threadId);
		const quiescenceMessage = messages.find((m) => m.content.includes("Quiescence is active"));
		expect(quiescenceMessage).toBeDefined();
		expect(quiescenceMessage?.content).toContain("idle 2h"); // idle duration formatted
	});

	it("cron note includes schedule information", async () => {
		const { taskId, threadId } = insertCronTask("0 12 * * *"); // Daily at noon

		// 3 hours idle
		const threeHoursAgo = new Date(Date.now() - 3 * 60 * 60 * 1000);

		const ctx = makeCtx();
		// biome-ignore lint/suspicious/noExplicitAny: test mock
		const scheduler = new Scheduler(ctx as any, makeAgentLoopFactory());

		// biome-ignore lint/suspicious/noExplicitAny: test access to private field
		(scheduler as any).lastUserInteractionAt = threeHoursAgo;

		await new Promise<void>((resolve) => {
			// biome-ignore lint/suspicious/noExplicitAny: test access to private field
			const originalRunningTasks = (scheduler as any).runningTasks;
			// biome-ignore lint/suspicious/noExplicitAny: test access to private field
			(scheduler as any).runningTasks = new Map([
				[taskId, { leaseId: randomUUID(), startedAt: new Date() }],
			]);
			// biome-ignore lint/suspicious/noExplicitAny: test access to private field
			(scheduler as any).runTask(db.query("SELECT * FROM tasks WHERE id = ?").get(taskId));
			setTimeout(() => {
				// biome-ignore lint/suspicious/noExplicitAny: test access to private field
				(scheduler as any).runningTasks = originalRunningTasks;
				resolve();
			}, 100);
		});

		const messages = getThreadMessages(threadId);
		const quiescenceMessage = messages.find((m) => m.content.includes("Quiescence is active"));
		expect(quiescenceMessage).toBeDefined();
		expect(quiescenceMessage?.content).toContain("0 12 * * *"); // cron schedule extracted
		expect(quiescenceMessage?.content).toContain("schedule stretched by 3x");
	});

	// Edge cases
	it("handles heartbeat with invalid trigger_spec gracefully", async () => {
		const taskId = randomUUID();
		const tid = randomUUID();
		const now = new Date().toISOString();

		// Insert thread
		db.run(
			`INSERT INTO threads (
				id, user_id, interface, host_origin, color, title, summary,
				summary_through, summary_model_id, extracted_through,
				created_at, last_message_at, modified_at, deleted
			) VALUES (?, 'system', 'scheduler', ?, 0, NULL, NULL, NULL, NULL, NULL, ?, ?, ?, 0)`,
			[tid, "test-host", now, now, now],
		);

		// Insert task with invalid JSON trigger_spec
		db.run(
			`INSERT INTO tasks (
				id, type, status, trigger_spec, payload, thread_id,
				claimed_by, claimed_at, lease_id, next_run_at, last_run_at,
				run_count, max_runs, requires, model_hint, no_history,
				inject_mode, depends_on, require_success, alert_threshold,
				consecutive_failures, event_depth, no_quiescence,
				heartbeat_at, result, error, created_at, created_by, modified_at, deleted
			) VALUES (
				?, 'heartbeat', 'claimed', ?, NULL, ?,
				'test-host', ?, NULL, NULL, NULL,
				0, NULL, NULL, NULL, 0,
				'status', NULL, 0, 5,
				0, 0, 0,
				NULL, NULL, NULL, ?, 'system', ?, 0
			)`,
			[taskId, "invalid json", tid, now, now, now],
		);

		// Simulate 2 hours idle
		const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000);

		const ctx = makeCtx();
		// biome-ignore lint/suspicious/noExplicitAny: test mock
		const scheduler = new Scheduler(ctx as any, makeAgentLoopFactory());

		// biome-ignore lint/suspicious/noExplicitAny: test access to private field
		(scheduler as any).lastUserInteractionAt = twoHoursAgo;

		// Should not crash even with invalid trigger_spec
		await new Promise<void>((resolve) => {
			// biome-ignore lint/suspicious/noExplicitAny: test access to private field
			const originalRunningTasks = (scheduler as any).runningTasks;
			// biome-ignore lint/suspicious/noExplicitAny: test access to private field
			(scheduler as any).runningTasks = new Map([
				[taskId, { leaseId: randomUUID(), startedAt: new Date() }],
			]);
			// biome-ignore lint/suspicious/noExplicitAny: test access to private field
			(scheduler as any).runTask(db.query("SELECT * FROM tasks WHERE id = ?").get(taskId));
			setTimeout(() => {
				// biome-ignore lint/suspicious/noExplicitAny: test access to private field
				(scheduler as any).runningTasks = originalRunningTasks;
				resolve();
			}, 100);
		});

		// Should have injected a note with fallback values
		const messages = getThreadMessages(tid);
		const quiescenceMessage = messages.find((m) => m.content.includes("Quiescence is active"));
		expect(quiescenceMessage).toBeDefined();
		expect(quiescenceMessage?.content).toContain("30min"); // fallback base interval
	});
});
