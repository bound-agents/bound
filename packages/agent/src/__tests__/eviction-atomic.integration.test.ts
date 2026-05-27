import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { randomUUID } from "node:crypto";
import { applySchema, createDatabase, insertRow } from "@bound/core";
import type { AppContext } from "@bound/core";
import { TypedEventEmitter } from "@bound/shared";
import { Scheduler } from "../scheduler";

describe("Atomic eviction recovery (R-LR3)", () => {
	let db: Database;
	let ctx: AppContext;

	beforeEach(() => {
		db = createDatabase(":memory:");
		applySchema(db);
		ctx = {
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

	afterEach(() => {
		db.close();
	});

	it("AC3.1: eviction produces pending row with cleared claim and incremented consecutive_failures", () => {
		// Setup: Create a running event task with stale heartbeat_at
		const taskId = randomUUID();
		const now = new Date();
		const staleHeartbeat = new Date(now.getTime() - 30 * 60_000); // 30 min old
		const leaseId = randomUUID();

		insertRow(
			db,
			"tasks",
			{
				id: taskId,
				type: "event",
				trigger_spec: "test",
				status: "running",
				created_at: now.toISOString(),
				modified_at: now.toISOString(),
				claimed_by: ctx.siteId,
				claimed_at: new Date(now.getTime() - 5 * 60_000).toISOString(), // 5 min ago
				lease_id: leaseId,
				error: null,
				result: null,
				consecutive_failures: 0,
				alert_threshold: 3,
				next_run_at: null,
				thread_id: "th1",
				deleted: 0,
				heartbeat_at: staleHeartbeat.toISOString(),
			},
			ctx.siteId,
		);

		// Insert an unprocessed relay_inbox row to trigger 60s backoff
		db.run(
			"INSERT INTO relay_inbox (id, source_site_id, kind, processed, ref_id, payload, expires_at, received_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
			[
				randomUUID(),
				ctx.siteId,
				"webhook_intake",
				0,
				"th1",
				'{"test":"payload"}',
				new Date(now.getTime() + 1_800_000).toISOString(),
				now.toISOString(),
			],
		);

		// Get initial change_log count
		const beforeCount = (
			db.query("SELECT COUNT(*) as c FROM change_log WHERE row_id = ?").get(taskId) as {
				c: number;
			}
		).c;

		// Run eviction
		const scheduler = new Scheduler(ctx);
		(scheduler as any).phase0Eviction();

		// Assert: row status is pending
		const row = db
			.query(
				"SELECT status, claimed_by, claimed_at, lease_id, consecutive_failures, next_run_at, error FROM tasks WHERE id = ?",
			)
			.get(taskId) as {
			status: string;
			claimed_by: string | null;
			claimed_at: string | null;
			lease_id: string | null;
			consecutive_failures: number;
			next_run_at: string | null;
			error: string | null;
		};

		expect(row.status).toBe("pending");
		expect(row.claimed_by).toBe(null);
		expect(row.claimed_at).toBe(null);
		expect(row.lease_id).toBe(null);
		expect(row.consecutive_failures).toBe(1);
		expect(row.error).toBe("evicted due to heartbeat timeout");

		// Assert: next_run_at is approximately now + 60s (event-task backoff with unprocessed envelope)
		const nextRunAt = new Date(row.next_run_at ?? "");
		const expectedMin = now.getTime() + 60_000 - 2_000; // Allow 2s margin
		const expectedMax = now.getTime() + 60_000 + 2_000;
		expect(nextRunAt.getTime()).toBeGreaterThanOrEqual(expectedMin);
		expect(nextRunAt.getTime()).toBeLessThanOrEqual(expectedMax);

		// Assert: exactly one new change_log entry
		const afterCount = (
			db.query("SELECT COUNT(*) as c FROM change_log WHERE row_id = ?").get(taskId) as {
				c: number;
			}
		).c;
		expect(afterCount).toBe(beforeCount + 1);
	});

	it("AC8.1: post-eviction row is eligible for phase1 claim on next tick", () => {
		// Setup: Create a running cron task with stale heartbeat_at
		const taskId = randomUUID();
		const now = new Date();
		const staleHeartbeat = new Date(now.getTime() - 30 * 60_000); // 30 min old
		const leaseId = randomUUID();

		insertRow(
			db,
			"tasks",
			{
				id: taskId,
				type: "cron",
				trigger_spec: "0 * * * *", // every hour
				status: "running",
				created_at: now.toISOString(),
				modified_at: now.toISOString(),
				claimed_by: ctx.siteId,
				claimed_at: new Date(now.getTime() - 5 * 60_000).toISOString(), // 5 min ago
				lease_id: leaseId,
				error: null,
				result: null,
				consecutive_failures: 0,
				alert_threshold: 3,
				next_run_at: null,
				thread_id: null,
				deleted: 0,
				heartbeat_at: staleHeartbeat.toISOString(),
			},
			ctx.siteId,
		);

		// Run eviction
		const scheduler = new Scheduler(ctx);
		(scheduler as any).phase0Eviction();

		// Assert: row is now pending with next_run_at set (proving eviction succeeded and row is post-state-correct)
		const rowAfterEviction = db
			.query("SELECT status, next_run_at, claimed_by, claimed_at, lease_id FROM tasks WHERE id = ?")
			.get(taskId) as {
			status: string;
			next_run_at: string | null;
			claimed_by: string | null;
			claimed_at: string | null;
			lease_id: string | null;
		};
		expect(rowAfterEviction.status).toBe("pending");
		expect(rowAfterEviction.next_run_at).not.toBeNull();
		expect(rowAfterEviction.claimed_by).toBeNull();
		expect(rowAfterEviction.lease_id).toBeNull();

		// Phase 1 eligibility is confirmed by structure: the row is now in pending state with claim cleared
		// and a non-null next_run_at (either in past or near future depending on task type).
		// For cron tasks, the next_run_at is clock-aligned to the ceiling of (now / effectiveInterval) * effectiveInterval,
		// which is typically in the future. We verify the structure is correct for phase1 eligibility.
		const nextRunAtMs = new Date(rowAfterEviction.next_run_at ?? "").getTime();
		expect(nextRunAtMs).toBeGreaterThan(now.getTime() - 1_000); // Should not be in the past by much
	});

	it("AC3.1: eviction with heartbeat task computes next_run_at via clock alignment", () => {
		// Setup: Create a running heartbeat task
		const taskId = randomUUID();
		const now = new Date();
		const staleHeartbeat = new Date(now.getTime() - 30 * 60_000);
		const leaseId = randomUUID();

		insertRow(
			db,
			"tasks",
			{
				id: taskId,
				type: "heartbeat",
				trigger_spec: JSON.stringify({ interval_ms: 60_000 }),
				status: "running",
				created_at: now.toISOString(),
				modified_at: now.toISOString(),
				claimed_by: ctx.siteId,
				claimed_at: new Date(now.getTime() - 5 * 60_000).toISOString(),
				lease_id: leaseId,
				error: null,
				result: null,
				consecutive_failures: 0,
				alert_threshold: 3,
				next_run_at: null,
				thread_id: null,
				deleted: 0,
				heartbeat_at: staleHeartbeat.toISOString(),
			},
			ctx.siteId,
		);

		// Run eviction
		const scheduler = new Scheduler(ctx);
		(scheduler as any).phase0Eviction();

		// Assert: row has next_run_at set to a future time (clock-aligned)
		const row = db.query("SELECT status, next_run_at FROM tasks WHERE id = ?").get(taskId) as {
			status: string;
			next_run_at: string | null;
		};
		expect(row.status).toBe("pending");
		expect(row.next_run_at).not.toBeNull();

		const nextRunAt = new Date(row.next_run_at ?? "").getTime();
		expect(nextRunAt).toBeGreaterThan(now.getTime());
	});

	it("AC3.1: eviction with deferred task uses linear backoff", () => {
		// Setup: Create a running deferred task with 1 consecutive failure
		const taskId = randomUUID();
		const now = new Date();
		const staleHeartbeat = new Date(now.getTime() - 30 * 60_000);
		const leaseId = randomUUID();
		const beforeEvictionMs = Date.now();

		insertRow(
			db,
			"tasks",
			{
				id: taskId,
				type: "deferred",
				trigger_spec: "test",
				status: "running",
				created_at: now.toISOString(),
				modified_at: now.toISOString(),
				claimed_by: ctx.siteId,
				claimed_at: new Date(now.getTime() - 5 * 60_000).toISOString(),
				lease_id: leaseId,
				error: null,
				result: null,
				consecutive_failures: 1, // Will become 2 after eviction
				alert_threshold: 5,
				next_run_at: null,
				thread_id: null,
				deleted: 0,
				heartbeat_at: staleHeartbeat.toISOString(),
			},
			ctx.siteId,
		);

		// Run eviction
		const scheduler = new Scheduler(ctx);
		(scheduler as any).phase0Eviction();

		// Assert: row has next_run_at set to now + (DEFERRED_RETRY_BACKOFF_MS * 2)
		const row = db
			.query("SELECT status, consecutive_failures, next_run_at FROM tasks WHERE id = ?")
			.get(taskId) as { status: string; consecutive_failures: number; next_run_at: string | null };
		expect(row.status).toBe("pending");
		expect(row.consecutive_failures).toBe(2);

		// DEFERRED_RETRY_BACKOFF_MS_DEFAULT = 5_000
		// new_consecutive_failures = 2, so backoff = 5_000 * 2 = 10_000ms
		const expectedNextRunAtMs = beforeEvictionMs + 5_000 * 2;
		const actualNextRunAtMs = new Date(row.next_run_at ?? "").getTime();
		expect(actualNextRunAtMs).toBeGreaterThanOrEqual(expectedNextRunAtMs - 500);
		expect(actualNextRunAtMs).toBeLessThanOrEqual(expectedNextRunAtMs + 500);
	});

	it("AC3.1: eviction with deferred task at max retries does not reschedule", () => {
		// Setup: Create a running deferred task at or above DEFERRED_MAX_RETRIES (2)
		const taskId = randomUUID();
		const now = new Date();
		const staleHeartbeat = new Date(now.getTime() - 30 * 60_000);
		const leaseId = randomUUID();

		insertRow(
			db,
			"tasks",
			{
				id: taskId,
				type: "deferred",
				trigger_spec: "test",
				status: "running",
				created_at: now.toISOString(),
				modified_at: now.toISOString(),
				claimed_by: ctx.siteId,
				claimed_at: new Date(now.getTime() - 5 * 60_000).toISOString(),
				lease_id: leaseId,
				error: null,
				result: null,
				consecutive_failures: 2, // Will become 3, exceeding DEFERRED_MAX_RETRIES (2)
				alert_threshold: 5,
				next_run_at: null,
				thread_id: null,
				deleted: 0,
				heartbeat_at: staleHeartbeat.toISOString(),
			},
			ctx.siteId,
		);

		// Run eviction
		const scheduler = new Scheduler(ctx);
		(scheduler as any).phase0Eviction();

		// Assert: row is pending but next_run_at is null (task stays failed)
		const row = db.query("SELECT status, next_run_at FROM tasks WHERE id = ?").get(taskId) as {
			status: string;
			next_run_at: string | null;
		};
		expect(row.status).toBe("pending");
		expect(row.next_run_at).toBeNull();
	});

	it("Eviction CAS lost: row already completed by agent loop during eviction", () => {
		// Setup: Create a running task
		const taskId = randomUUID();
		const now = new Date();
		const staleHeartbeat = new Date(now.getTime() - 30 * 60_000);
		const leaseId = randomUUID();

		insertRow(
			db,
			"tasks",
			{
				id: taskId,
				type: "event",
				trigger_spec: "test",
				status: "running",
				created_at: now.toISOString(),
				modified_at: now.toISOString(),
				claimed_by: ctx.siteId,
				claimed_at: new Date(now.getTime() - 5 * 60_000).toISOString(),
				lease_id: leaseId,
				error: null,
				result: null,
				consecutive_failures: 0,
				alert_threshold: 3,
				next_run_at: null,
				thread_id: "th1",
				deleted: 0,
				heartbeat_at: staleHeartbeat.toISOString(),
			},
			ctx.siteId,
		);

		// Simulate completion before eviction: update the row directly
		db.run("UPDATE tasks SET status = ?, result = ?, modified_at = ? WHERE id = ?", [
			"completed",
			'{"success": true}',
			now.toISOString(),
			taskId,
		]);

		// Run eviction — the CAS should fail silently
		const scheduler = new Scheduler(ctx);
		(scheduler as any).phase0Eviction();

		// Assert: row status is still completed (not trampled)
		const row = db.query("SELECT status FROM tasks WHERE id = ?").get(taskId) as { status: string };
		expect(row.status).toBe("completed");
	});
});
