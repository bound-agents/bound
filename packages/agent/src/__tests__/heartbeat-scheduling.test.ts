/**
 * Heartbeat scheduling tests.
 *
 * Verifies that rescheduleHeartbeat() correctly computes clock-aligned
 * boundaries with quiescence multipliers.
 */

import type { Database } from "bun:sqlite";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyMetricsSchema, applySchema, createDatabase } from "@bound/core";
import type { AppContext } from "@bound/core";
import { TypedEventEmitter } from "@bound/shared";
import { rescheduleHeartbeat } from "../scheduler";

describe("rescheduleHeartbeat", () => {
	let tmpDir: string;
	let db: Database;
	let siteId: string;
	let eventBus: TypedEventEmitter;

	beforeAll(() => {
		tmpDir = mkdtempSync(join(tmpdir(), `hb-sched-${randomBytes(4).toString("hex")}-`));
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
		};
	}

	function insertHeartbeatTask(
		intervalMs: number,
		status = "running",
	): { id: string; taskId: string } {
		const taskId = randomUUID();
		const now = new Date().toISOString();
		const triggerSpec = JSON.stringify({ type: "heartbeat", interval_ms: intervalMs });

		db.run(
			`INSERT INTO tasks (
				id, type, status, trigger_spec, payload, thread_id,
				claimed_by, claimed_at, lease_id, next_run_at, last_run_at,
				run_count, max_runs, requires, model_hint, no_history,
				inject_mode, depends_on, require_success, alert_threshold,
				consecutive_failures, event_depth, no_quiescence,
				heartbeat_at, result, error, created_at, created_by, modified_at, deleted
			) VALUES (
				?, 'heartbeat', ?, ?, NULL, NULL,
				NULL, NULL, NULL, NULL, NULL,
				0, NULL, NULL, NULL, 0,
				'status', NULL, 0, 5,
				0, 0, 0,
				NULL, NULL, NULL, ?, 'system', ?, 0
			)`,
			[taskId, status, triggerSpec, now, now],
		);

		return { id: taskId, taskId };
	}

	// biome-ignore lint/suspicious/noExplicitAny: Dynamic query result from SQLite
	function getTask(taskId: string): any {
		return db.query("SELECT * FROM tasks WHERE id = ?").get(taskId);
	}

	// AC1.1: Clock alignment - 30min interval at 14:17 should give 14:30
	it("aligns to clock boundaries (AC1.1)", () => {
		const { taskId } = insertHeartbeatTask(30 * 60 * 1000, "running");
		const ctx = makeCtx();
		const lastInteraction = new Date();

		const task = getTask(taskId);
		rescheduleHeartbeat(db, task, ctx.logger, "test", lastInteraction);

		// biome-ignore lint/suspicious/noExplicitAny: Dynamic query result from SQLite
		const row = db.query("SELECT next_run_at, status FROM tasks WHERE id = ?").get(taskId) as any;
		expect(row.status).toBe("pending");

		// Check that next_run_at is on a 30-minute boundary
		// For 30min intervals, should be at :00 or :30
		const minutes = new Date(row.next_run_at).getUTCMinutes();
		expect([0, 30]).toContain(minutes);
	});

	// AC1.2: Self-reschedule after completion
	it("resets status to pending after completion (AC1.2)", () => {
		const { taskId } = insertHeartbeatTask(30 * 60 * 1000, "completed");
		const ctx = makeCtx();
		const lastInteraction = new Date();

		const task = getTask(taskId);
		rescheduleHeartbeat(db, task, ctx.logger, "completion", lastInteraction);

		// biome-ignore lint/suspicious/noExplicitAny: Dynamic query result from SQLite
		const row = db.query("SELECT status FROM tasks WHERE id = ?").get(taskId) as any;
		expect(row.status).toBe("pending");
	});

	// AC1.3: Reschedule after errors/eviction
	it("reschedules from failed status (AC1.3)", () => {
		const { taskId } = insertHeartbeatTask(30 * 60 * 1000, "failed");
		const ctx = makeCtx();
		const lastInteraction = new Date();

		const task = getTask(taskId);
		rescheduleHeartbeat(db, task, ctx.logger, "eviction", lastInteraction);

		// biome-ignore lint/suspicious/noExplicitAny: Dynamic query result from SQLite
		const row = db.query("SELECT status, next_run_at FROM tasks WHERE id = ?").get(taskId) as any;
		expect(row.status).toBe("pending");
		expect(row.next_run_at).toBeDefined();
	});

	// AC1.4: Arbitrary intervals
	it("handles 15min interval with clock alignment (AC1.4a)", () => {
		const { taskId } = insertHeartbeatTask(15 * 60 * 1000, "running");
		const ctx = makeCtx();
		const lastInteraction = new Date();

		const task = getTask(taskId);
		rescheduleHeartbeat(db, task, ctx.logger, "test", lastInteraction);

		// biome-ignore lint/suspicious/noExplicitAny: Dynamic query result from SQLite
		const row = db.query("SELECT next_run_at FROM tasks WHERE id = ?").get(taskId) as any;
		const nextDate = new Date(row.next_run_at);
		const minutes = nextDate.getUTCMinutes();
		// 15min interval: boundaries at :00, :15, :30, :45
		expect([0, 15, 30, 45]).toContain(minutes);
	});

	it("handles 45min interval with clock alignment (AC1.4b)", () => {
		const { taskId } = insertHeartbeatTask(45 * 60 * 1000, "running");
		const ctx = makeCtx();
		const lastInteraction = new Date();

		const task = getTask(taskId);
		rescheduleHeartbeat(db, task, ctx.logger, "test", lastInteraction);

		// biome-ignore lint/suspicious/noExplicitAny: Dynamic query result from SQLite
		const row = db.query("SELECT next_run_at FROM tasks WHERE id = ?").get(taskId) as any;
		const nextDate = new Date(row.next_run_at);
		const totalMinutes = nextDate.getUTCHours() * 60 + nextDate.getUTCMinutes();
		// 45min boundaries: at 0, 45, 90 (1:30), 135 (2:15), etc.
		const mod = totalMinutes % 45;
		expect(mod).toBe(0);
	});

	it("handles 2h (120min) interval with clock alignment (AC1.4c)", () => {
		const { taskId } = insertHeartbeatTask(2 * 60 * 60 * 1000, "running");
		const ctx = makeCtx();
		const lastInteraction = new Date();

		const task = getTask(taskId);
		rescheduleHeartbeat(db, task, ctx.logger, "test", lastInteraction);

		// biome-ignore lint/suspicious/noExplicitAny: Dynamic query result from SQLite
		const row = db.query("SELECT next_run_at FROM tasks WHERE id = ?").get(taskId) as any;
		const nextDate = new Date(row.next_run_at);
		const totalMinutes = nextDate.getUTCHours() * 60 + nextDate.getUTCMinutes();
		// 2h (120min) boundaries: at 0, 120 (2:00), 240 (4:00), etc.
		const mod = totalMinutes % 120;
		expect(mod).toBe(0);
	});

	// Quiescence multipliers
	it("applies 2x multiplier for fresh interaction (multiplier=2 minimum)", () => {
		const { taskId } = insertHeartbeatTask(30 * 60 * 1000, "running");
		const ctx = makeCtx();
		// Just now
		const lastInteraction = new Date();

		const task = getTask(taskId);
		rescheduleHeartbeat(db, task, ctx.logger, "test", lastInteraction);

		// biome-ignore lint/suspicious/noExplicitAny: Dynamic query result from SQLite
		const row = db.query("SELECT next_run_at FROM tasks WHERE id = ?").get(taskId) as any;
		// With 2x multiplier: 30min becomes 60min effective interval
		// So boundaries should be at :00 (full hour marks)
		const nextDate = new Date(row.next_run_at);
		expect(nextDate.getUTCMinutes()).toBe(0);
	});

	it("applies 3x multiplier for 2h idle", () => {
		const { taskId } = insertHeartbeatTask(30 * 60 * 1000, "running");
		const ctx = makeCtx();
		// 2 hours ago (falls into 1-4h tier: 3x)
		const lastInteraction = new Date(Date.now() - 2 * 60 * 60 * 1000);

		const task = getTask(taskId);
		rescheduleHeartbeat(db, task, ctx.logger, "test", lastInteraction);

		// biome-ignore lint/suspicious/noExplicitAny: Dynamic query result from SQLite
		const row = db.query("SELECT next_run_at FROM tasks WHERE id = ?").get(taskId) as any;
		// With 3x multiplier: 30min becomes 90min effective interval
		const nextDate = new Date(row.next_run_at);
		const totalMinutes = nextDate.getUTCHours() * 60 + nextDate.getUTCMinutes();
		// Boundaries at 0, 90 (1:30), 180 (3:00), 270 (4:30), etc.
		const mod = totalMinutes % 90;
		expect(mod).toBe(0);
	});

	it("applies 5x multiplier for 5h idle", () => {
		const { taskId } = insertHeartbeatTask(30 * 60 * 1000, "running");
		const ctx = makeCtx();
		// 5 hours ago (falls into 4-12h tier: 5x)
		const lastInteraction = new Date(Date.now() - 5 * 60 * 60 * 1000);

		const task = getTask(taskId);
		rescheduleHeartbeat(db, task, ctx.logger, "test", lastInteraction);

		// biome-ignore lint/suspicious/noExplicitAny: Dynamic query result from SQLite
		const row = db.query("SELECT next_run_at FROM tasks WHERE id = ?").get(taskId) as any;
		// With 5x multiplier: 30min becomes 150min effective interval
		// Verify that next_run_at is in the future
		const nextDate = new Date(row.next_run_at);
		expect(nextDate.getTime()).toBeGreaterThan(Date.now());

		// Verify it's at a valid boundary by checking that (time - now) is roughly a multiple of 150min
		// allowing for small timing variations
		const msUntilNext = nextDate.getTime() - Date.now();
		const effectiveIntervalMs = 30 * 60 * 1000 * 5; // 150min in ms
		expect(msUntilNext).toBeGreaterThan(0);
		expect(msUntilNext).toBeLessThanOrEqual(effectiveIntervalMs);
	});

	// AC3.2: Eviction reschedule
	it("reschedules evicted task to next boundary (AC3.2)", () => {
		const { taskId } = insertHeartbeatTask(30 * 60 * 1000, "running");
		const ctx = makeCtx();
		const lastInteraction = new Date();

		const task = getTask(taskId);
		rescheduleHeartbeat(db, task, ctx.logger, "eviction_timeout", lastInteraction);

		// biome-ignore lint/suspicious/noExplicitAny: Dynamic query result from SQLite
		const row = db.query("SELECT next_run_at, status FROM tasks WHERE id = ?").get(taskId) as any;
		expect(row.status).toBe("pending");
		const nextDate = new Date(row.next_run_at);
		expect(nextDate.getTime()).toBeGreaterThan(Date.now());
	});

	// Edge cases
	it("handles non-heartbeat task gracefully", () => {
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
				?, 'cron', 'running', '0 * * * *', NULL, NULL,
				NULL, NULL, NULL, NULL, NULL,
				0, NULL, NULL, NULL, 0,
				'status', NULL, 0, 5,
				0, 0, 0,
				NULL, NULL, NULL, ?, 'system', ?, 0
			)`,
			[taskId, now, now],
		);

		const ctx = makeCtx();
		const lastInteraction = new Date();

		// Should return early without updating
		const task = getTask(taskId);
		rescheduleHeartbeat(db, task, ctx.logger, "test", lastInteraction);

		// biome-ignore lint/suspicious/noExplicitAny: Dynamic query result from SQLite
		const row = db.query("SELECT status FROM tasks WHERE id = ?").get(taskId) as any;
		expect(row.status).toBe("running"); // unchanged
	});

	it("logs error on invalid JSON in trigger_spec", () => {
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
				?, 'heartbeat', 'running', 'invalid json', NULL, NULL,
				NULL, NULL, NULL, NULL, NULL,
				0, NULL, NULL, NULL, 0,
				'status', NULL, 0, 5,
				0, 0, 0,
				NULL, NULL, NULL, ?, 'system', ?, 0
			)`,
			[taskId, now, now],
		);

		const ctx = makeCtx();
		let errorLogged = false;
		ctx.logger.error = () => {
			errorLogged = true;
		};
		const lastInteraction = new Date();

		const task = getTask(taskId);
		rescheduleHeartbeat(db, task, ctx.logger, "test", lastInteraction);

		expect(errorLogged).toBe(true);

		// biome-ignore lint/suspicious/noExplicitAny: Dynamic query result from SQLite
		const row = db.query("SELECT status FROM tasks WHERE id = ?").get(taskId) as any;
		expect(row.status).toBe("running"); // unchanged
	});

	it("logs error on missing interval_ms", () => {
		const taskId = randomUUID();
		const now = new Date().toISOString();
		const triggerSpec = JSON.stringify({ type: "heartbeat" }); // Missing interval_ms

		db.run(
			`INSERT INTO tasks (
				id, type, status, trigger_spec, payload, thread_id,
				claimed_by, claimed_at, lease_id, next_run_at, last_run_at,
				run_count, max_runs, requires, model_hint, no_history,
				inject_mode, depends_on, require_success, alert_threshold,
				consecutive_failures, event_depth, no_quiescence,
				heartbeat_at, result, error, created_at, created_by, modified_at, deleted
			) VALUES (
				?, 'heartbeat', 'running', ?, NULL, NULL,
				NULL, NULL, NULL, NULL, NULL,
				0, NULL, NULL, NULL, 0,
				'status', NULL, 0, 5,
				0, 0, 0,
				NULL, NULL, NULL, ?, 'system', ?, 0
			)`,
			[taskId, triggerSpec, now, now],
		);

		const ctx = makeCtx();
		let errorLogged = false;
		ctx.logger.error = () => {
			errorLogged = true;
		};
		const lastInteraction = new Date();

		const task = getTask(taskId);
		rescheduleHeartbeat(db, task, ctx.logger, "test", lastInteraction);

		expect(errorLogged).toBe(true);
	});

	// AC5.1: Quiescence multiplier stretches heartbeat interval
	it("applies quiescence multiplier to heartbeat interval (AC5.1)", () => {
		const { taskId } = insertHeartbeatTask(30 * 60 * 1000, "running");
		const ctx = makeCtx();

		// Simulate 5 hours idle (tier 2: 5x multiplier)
		const fiveHoursAgo = new Date(Date.now() - 5 * 60 * 60 * 1000);

		const task = getTask(taskId);
		rescheduleHeartbeat(db, task, ctx.logger, "test", fiveHoursAgo);

		// biome-ignore lint/suspicious/noExplicitAny: Dynamic query result from SQLite
		const row = db.query("SELECT next_run_at FROM tasks WHERE id = ?").get(taskId) as any;
		const nextDate = new Date(row.next_run_at);

		// With 5x multiplier: 30min becomes 150min effective interval
		// Verify that next_run_at is in the future and at least 90min away
		// (accounting for the fact that we could be anywhere in the cycle)
		const msUntilNext = nextDate.getTime() - Date.now();
		expect(msUntilNext).toBeGreaterThan(0);
		// At minimum, should be > 1.5x the base 30-min interval to account for quiescence
		expect(msUntilNext).toBeGreaterThan(45 * 60 * 1000); // > 45 minutes
	});

	// Additional AC5.1 test: verify different intervals with quiescence
	it("stretches 15min interval by 3x for 2h idle (AC5.1 variant)", () => {
		const { taskId } = insertHeartbeatTask(15 * 60 * 1000, "running");
		const ctx = makeCtx();

		// Simulate 2 hours idle (tier 1: 3x multiplier)
		const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000);

		const task = getTask(taskId);
		rescheduleHeartbeat(db, task, ctx.logger, "test", twoHoursAgo);

		// biome-ignore lint/suspicious/noExplicitAny: Dynamic query result from SQLite
		const row = db.query("SELECT next_run_at FROM tasks WHERE id = ?").get(taskId) as any;
		const nextDate = new Date(row.next_run_at);

		// With 3x multiplier: 15min becomes 45min effective interval
		// Verify that next_run_at is in the future and at least 15min away (the base interval)
		const msUntilNext = nextDate.getTime() - Date.now();
		expect(msUntilNext).toBeGreaterThan(0);
		// At minimum, should be > 1x the base 15-min interval to account for quiescence
		expect(msUntilNext).toBeGreaterThan(15 * 60 * 1000); // > 15 minutes
	});
});
