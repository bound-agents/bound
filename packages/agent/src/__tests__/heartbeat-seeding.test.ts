/**
 * Heartbeat seeding tests.
 *
 * Verifies that seedHeartbeat() creates the heartbeat task with the fixed
 * system defaults, idempotency, and CAS-blocking semantics. The heartbeat is a
 * system-managed, uncancellable task with no operator config surface — the
 * cadence is fixed at DEFAULT_HEARTBEAT_INTERVAL_MS.
 */

import type { Database } from "bun:sqlite";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyMetricsSchema, applySchema, createDatabase } from "@bound/core";
import { BOUND_NAMESPACE, deterministicUUID } from "@bound/shared";
import { cleanupTmpDir } from "@bound/shared/test-utils";
import { DEFAULT_HEARTBEAT_INTERVAL_MS, seedHeartbeat } from "../task-resolution";

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

	afterAll(async () => {
		db.close();
		await cleanupTmpDir(tmpDir);
	});

	function getHeartbeatTask(): any {
		const expectedId = deterministicUUID(BOUND_NAMESPACE, "heartbeat");
		return db.query("SELECT * FROM tasks WHERE id = ?").get(expectedId);
	}

	function countHeartbeatTasks(): number {
		const result = db
			.query("SELECT COUNT(*) as count FROM tasks WHERE type = ?")
			.get("heartbeat") as any;
		return result?.count ?? 0;
	}

	// Default seeding — fixed 30-minute cadence, no config surface
	it("seeds heartbeat with the fixed default cadence", () => {
		seedHeartbeat(db, siteId);

		const task = getHeartbeatTask();
		expect(task).toBeDefined();
		expect(task.type).toBe("heartbeat");
		expect(task.status).toBe("pending");
		expect(task.created_by).toBe("system");

		const triggerSpec = JSON.parse(task.trigger_spec);
		expect(triggerSpec.type).toBe("heartbeat");
		expect(triggerSpec.interval_ms).toBe(DEFAULT_HEARTBEAT_INTERVAL_MS); // 30 minutes

		// Verify next_run_at is set and is in the future
		const nextRunAt = new Date(task.next_run_at);
		expect(nextRunAt.getTime()).toBeGreaterThan(Date.now());
	});

	// Idempotency
	it("does not create duplicate heartbeat tasks on multiple calls", () => {
		seedHeartbeat(db, siteId);
		seedHeartbeat(db, siteId);
		seedHeartbeat(db, siteId);

		const count = countHeartbeatTasks();
		expect(count).toBe(1);
	});

	// Deterministic UUID consistency
	it("uses consistent deterministic UUID for heartbeat task", () => {
		seedHeartbeat(db, siteId);

		const expectedId = deterministicUUID(BOUND_NAMESPACE, "heartbeat");
		const task = getHeartbeatTask();
		expect(task.id).toBe(expectedId);
	});

	// Clock alignment verification
	it("sets next_run_at to a clock-aligned boundary", () => {
		seedHeartbeat(db, siteId);

		const task = getHeartbeatTask();
		const nextRunTime = new Date(task.next_run_at).getTime();

		// Verify it's on a boundary by checking that nextRunTime % intervalMs == 0
		const remainder = nextRunTime % DEFAULT_HEARTBEAT_INTERVAL_MS;
		expect(remainder).toBe(0);
	});

	// Field validation
	it("sets all required task fields correctly", () => {
		seedHeartbeat(db, siteId);

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
		expect(task.no_history).toBe(1);
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
		seedHeartbeat(db, siteId);

		// Manually update the task to running status
		const taskId = deterministicUUID(BOUND_NAMESPACE, "heartbeat");
		db.run("UPDATE tasks SET status = ? WHERE id = ?", ["running", taskId]);

		// Simulate CAS claim query: only claiming if status = 'pending'
		const result = db
			.query("SELECT id FROM tasks WHERE id = ? AND status = ?")
			.get(taskId, "pending");

		expect(result).toBeNull(); // CAS should fail because status is 'running'
	});

	// Trigger spec validation
	it("creates valid trigger_spec JSON", () => {
		seedHeartbeat(db, siteId);

		const task = getHeartbeatTask();
		const triggerSpec = JSON.parse(task.trigger_spec);

		expect(triggerSpec.type).toBe("heartbeat");
		expect(typeof triggerSpec.interval_ms).toBe("number");
		expect(triggerSpec.interval_ms).toBe(DEFAULT_HEARTBEAT_INTERVAL_MS);
	});

	// Idempotent: a re-seed never updates an existing row (INSERT OR IGNORE)
	it("does not update an existing heartbeat task on re-seed", () => {
		seedHeartbeat(db, siteId);

		const task = getHeartbeatTask();
		const spec = JSON.parse(task.trigger_spec);
		expect(spec.interval_ms).toBe(DEFAULT_HEARTBEAT_INTERVAL_MS);

		seedHeartbeat(db, siteId);

		const count = countHeartbeatTasks();
		expect(count).toBe(1);
	});

	// model_hint is always null — there is no config to set it from
	it("leaves model_hint null", () => {
		seedHeartbeat(db, siteId);

		const task = getHeartbeatTask();
		expect(task.model_hint).toBeNull();
	});
});
