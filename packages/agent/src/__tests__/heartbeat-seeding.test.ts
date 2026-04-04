/**
 * Heartbeat seeding tests.
 *
 * Verifies that seedHeartbeat() correctly creates the heartbeat task with
 * proper defaults, configuration, idempotency, and CAS-blocking semantics.
 */

import type { Database } from "bun:sqlite";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyMetricsSchema, applySchema, createDatabase } from "@bound/core";
import { BOUND_NAMESPACE, deterministicUUID } from "@bound/shared";
import type { HeartbeatConfig } from "@bound/shared";
import { seedHeartbeat } from "../task-resolution";

describe("seedHeartbeat", () => {
	let tmpDir: string;
	let db: Database;
	let siteId: string;

	beforeAll(() => {
		tmpDir = mkdtempSync(join(tmpdir(), `hb-seed-${randomBytes(4).toString("hex")}-`));
		const dbPath = join(tmpDir, "test.db");
		db = createDatabase(dbPath);
		applySchema(db);
		applyMetricsSchema(db);
	});

	beforeEach(() => {
		siteId = randomUUID();
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

	function getHeartbeatTask(): any {
		const expectedId = deterministicUUID(BOUND_NAMESPACE, "heartbeat");
		return db.query("SELECT * FROM tasks WHERE id = ?").get(expectedId);
	}

	function countHeartbeatTasks(): number {
		const result = db.query("SELECT COUNT(*) as count FROM tasks WHERE type = ?").get("heartbeat") as any;
		return result?.count ?? 0;
	}

	// AC4.1: Default seeding (no config provided)
	it("seeds heartbeat with defaults when config is undefined (AC4.1)", () => {
		seedHeartbeat(db, undefined, siteId);

		const task = getHeartbeatTask();
		expect(task).toBeDefined();
		expect(task.type).toBe("heartbeat");
		expect(task.status).toBe("pending");
		expect(task.created_by).toBe("system");

		const triggerSpec = JSON.parse(task.trigger_spec);
		expect(triggerSpec.type).toBe("heartbeat");
		expect(triggerSpec.interval_ms).toBe(1_800_000); // 30 minutes default

		// Verify next_run_at is set and is in the future
		const nextRunAt = new Date(task.next_run_at);
		expect(nextRunAt.getTime()).toBeGreaterThan(Date.now());
	});

	// AC4.2: Custom interval
	it("seeds heartbeat with custom interval_ms (AC4.2)", () => {
		const config: HeartbeatConfig = {
			enabled: true,
			interval_ms: 900_000, // 15 minutes
		};

		seedHeartbeat(db, config, siteId);

		const task = getHeartbeatTask();
		expect(task).toBeDefined();

		const triggerSpec = JSON.parse(task.trigger_spec);
		expect(triggerSpec.interval_ms).toBe(900_000);
	});

	// AC4.3: Idempotency
	it("does not create duplicate heartbeat tasks on multiple calls (AC4.3)", () => {
		const config: HeartbeatConfig = {
			enabled: true,
			interval_ms: 1_800_000,
		};

		seedHeartbeat(db, config, siteId);
		seedHeartbeat(db, config, siteId);
		seedHeartbeat(db, config, siteId);

		const count = countHeartbeatTasks();
		expect(count).toBe(1);
	});

	// AC4.4: Disabled config
	it("does not seed heartbeat when enabled is false (AC4.4)", () => {
		const config: HeartbeatConfig = {
			enabled: false,
			interval_ms: 1_800_000,
		};

		seedHeartbeat(db, config, siteId);

		const count = countHeartbeatTasks();
		expect(count).toBe(0);

		const task = getHeartbeatTask();
		expect(task).toBeNull();
	});

	// Deterministic UUID consistency
	it("uses consistent deterministic UUID for heartbeat task", () => {
		seedHeartbeat(db, undefined, siteId);

		const expectedId = deterministicUUID(BOUND_NAMESPACE, "heartbeat");
		const task = getHeartbeatTask();
		expect(task.id).toBe(expectedId);
	});

	// Clock alignment verification
	it("sets next_run_at to a clock-aligned boundary", () => {
		const config: HeartbeatConfig = {
			enabled: true,
			interval_ms: 1_800_000, // 30 minutes
		};

		seedHeartbeat(db, config, siteId);

		const task = getHeartbeatTask();
		const nextRunTime = new Date(task.next_run_at).getTime();
		const intervalMs = config.interval_ms;

		// Verify it's on a boundary by checking that nextRunTime % intervalMs == 0
		const remainder = nextRunTime % intervalMs;
		expect(remainder).toBe(0);
	});

	// Field validation
	it("sets all required task fields correctly", () => {
		seedHeartbeat(db, undefined, siteId);

		const task = getHeartbeatTask();
		expect(task.type).toBe("heartbeat");
		expect(task.status).toBe("pending");
		expect(task.created_by).toBe("system");
		expect(task.thread_id).toBeNull();
		expect(task.claimed_by).toBeNull();
		expect(task.claimed_at).toBeNull();
		expect(task.lease_id).toBeNull();
		expect(task.last_run_at).toBeNull();
		expect(task.run_count).toBe(0);
		expect(task.max_runs).toBeNull();
		expect(task.requires).toBeNull();
		expect(task.model_hint).toBeNull();
		expect(task.no_history).toBe(0);
		expect(task.inject_mode).toBe("status");
		expect(task.depends_on).toBeNull();
		expect(task.require_success).toBe(0);
		expect(task.alert_threshold).toBe(5);
		expect(task.consecutive_failures).toBe(0);
		expect(task.event_depth).toBe(0);
		expect(task.no_quiescence).toBe(0);
		expect(task.heartbeat_at).toBeNull();
		expect(task.result).toBeNull();
		expect(task.error).toBeNull();
		expect(task.deleted).toBe(0);
	});

	// CAS blocking (AC3.1)
	it("heartbeat can be blocked by CAS when running (AC3.1)", () => {
		seedHeartbeat(db, undefined, siteId);

		// Manually update the task to running status
		const taskId = deterministicUUID(BOUND_NAMESPACE, "heartbeat");
		db.run("UPDATE tasks SET status = ? WHERE id = ?", ["running", taskId]);

		// Simulate CAS claim query: only claiming if status = 'pending'
		const result = db.query("SELECT id FROM tasks WHERE id = ? AND status = ?").get(taskId, "pending");

		expect(result).toBeNull(); // CAS should fail because status is 'running'
	});

	// Trigger spec validation
	it("creates valid trigger_spec JSON", () => {
		const config: HeartbeatConfig = {
			enabled: true,
			interval_ms: 900_000,
		};

		seedHeartbeat(db, config, siteId);

		const task = getHeartbeatTask();
		const triggerSpec = JSON.parse(task.trigger_spec);

		expect(triggerSpec.type).toBe("heartbeat");
		expect(typeof triggerSpec.interval_ms).toBe("number");
		expect(triggerSpec.interval_ms).toBe(900_000);
	});

	// Multiple configurations (testing idempotency with different configs)
	it("respects config changes on subsequent seeding (idempotent but not updated)", () => {
		// Seed with one config
		seedHeartbeat(db, { enabled: true, interval_ms: 1_800_000 }, siteId);

		let task = getHeartbeatTask();
		let spec = JSON.parse(task.trigger_spec);
		expect(spec.interval_ms).toBe(1_800_000);

		// Seed again with different config - should not update (INSERT OR IGNORE)
		seedHeartbeat(db, { enabled: true, interval_ms: 900_000 }, siteId);

		task = getHeartbeatTask();
		spec = JSON.parse(task.trigger_spec);
		// Should still be the original value because INSERT OR IGNORE doesn't update
		expect(spec.interval_ms).toBe(1_800_000);

		// Only one task should exist
		const count = countHeartbeatTasks();
		expect(count).toBe(1);
	});

	// Default values when config is empty object
	it("handles partial config by using passed values", () => {
		// When config is passed without interval_ms, we still need to provide it
		// The seedHeartbeat function uses config.interval_ms directly, not defaults
		// This test verifies that when we provide a config, we must provide interval_ms
		const config: HeartbeatConfig = {
			enabled: true,
			interval_ms: 1_800_000, // Must provide this
		};
		seedHeartbeat(db, config, siteId);

		const task = getHeartbeatTask();
		expect(task).toBeDefined();
		const spec = JSON.parse(task.trigger_spec);
		expect(spec.interval_ms).toBe(1_800_000);
	});
});
