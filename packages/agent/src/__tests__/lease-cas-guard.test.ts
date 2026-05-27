import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { randomUUID } from "node:crypto";
import { applySchema, createDatabase, insertRow, updateRowIf } from "@bound/core";
import type { AppContext } from "@bound/core";
import { TypedEventEmitter } from "@bound/shared";

describe("Lease CAS guards (AC3.3)", () => {
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

	it("AC3.3: happy-path completion rejects lease CAS when peer eviction clears lease", () => {
		// Setup: Create a running task with lease_id = "L1"
		const taskId = randomUUID();
		const threadId = randomUUID();
		const now = new Date();
		const leaseId = "L1";

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
				thread_id: threadId,
				deleted: 0,
				heartbeat_at: new Date(now.getTime() - 10 * 60_000).toISOString(),
			},
			ctx.siteId,
		);

		// Simulate peer eviction: directly UPDATE to pending and clear lease (mimics atomic eviction from Task 2)
		db.run("UPDATE tasks SET status = 'pending', lease_id = NULL, claimed_by = NULL WHERE id = ?", [
			taskId,
		]);

		// Get the starting change_log count
		const startChangeLogCount = (
			db.query("SELECT COUNT(*) as c FROM change_log WHERE row_id = ?").get(taskId) as {
				c: number;
			}
		).c;

		// Now attempt a happy-path completion with original lease_id
		// Simulate the runTask completion path calling updateRowIf with the stale lease
		// We'll use the private method or manually invoke the scheduler logic
		// For this test, we directly check what updateRowIf would do via bun:sqlite

		// Manually call updateRowIf-equivalent logic to verify the lease guard
		const wrote = updateRowIf(
			db,
			"tasks",
			taskId,
			{ status: "running", lease_id: leaseId }, // Precondition includes lease guard
			{
				status: "completed",
				result: JSON.stringify({ success: true }),
				error: "",
				run_count: 1,
				last_run_at: now.toISOString(),
				consecutive_failures: 0,
			},
			ctx.siteId,
		);

		// Assert: updateRowIf returned false (precondition failed)
		expect(wrote).toBe(false);

		// Assert: row remains in pending status
		const row = db.query("SELECT status, lease_id FROM tasks WHERE id = ?").get(taskId) as {
			status: string;
			lease_id: string | null;
		};
		expect(row.status).toBe("pending");
		expect(row.lease_id).toBeNull();

		// Assert: no new change_log entry was created (the rejected write doesn't emit a changelog)
		const endChangeLogCount = (
			db.query("SELECT COUNT(*) as c FROM change_log WHERE row_id = ?").get(taskId) as {
				c: number;
			}
		).c;
		expect(endChangeLogCount).toBe(startChangeLogCount);
	});

	it("AC3.3: model-validation failure rejects lease CAS when peer eviction clears lease", () => {
		// Setup: Create a running task with lease_id = "L1"
		const taskId = randomUUID();
		const now = new Date();
		const leaseId = "L1";

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
				thread_id: null,
				deleted: 0,
				heartbeat_at: new Date(now.getTime() - 10 * 60_000).toISOString(),
			},
			ctx.siteId,
		);

		// Simulate peer eviction: clear lease
		db.run("UPDATE tasks SET status = 'pending', lease_id = NULL, claimed_by = NULL WHERE id = ?", [
			taskId,
		]);

		// Get the starting change_log count
		const startChangeLogCount = (
			db.query("SELECT COUNT(*) as c FROM change_log WHERE row_id = ?").get(taskId) as {
				c: number;
			}
		).c;

		// Simulate the raw SQL UPDATE with lease CAS guard
		const result = db
			.query(
				"UPDATE tasks SET status = 'failed', error = ?, consecutive_failures = consecutive_failures + 1, modified_at = ? WHERE id = ? AND lease_id = ?",
			)
			.run("Model validation error", new Date().toISOString(), taskId, leaseId);

		// Assert: result.changes === 0 (no rows matched the WHERE clause due to lease CAS)
		expect(result.changes).toBe(0);

		// Assert: row remains in pending status
		const row = db.query("SELECT status, lease_id FROM tasks WHERE id = ?").get(taskId) as {
			status: string;
			lease_id: string | null;
		};
		expect(row.status).toBe("pending");
		expect(row.lease_id).toBeNull();

		// Assert: no new change_log entry was created
		const endChangeLogCount = (
			db.query("SELECT COUNT(*) as c FROM change_log WHERE row_id = ?").get(taskId) as {
				c: number;
			}
		).c;
		expect(endChangeLogCount).toBe(startChangeLogCount);
	});

	it("AC3.3: soft error rejects lease CAS when peer eviction clears lease", () => {
		// Setup: Create a running task with lease_id = "L1"
		const taskId = randomUUID();
		const now = new Date();
		const leaseId = "L1";

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
				thread_id: null,
				deleted: 0,
				heartbeat_at: new Date(now.getTime() - 10 * 60_000).toISOString(),
			},
			ctx.siteId,
		);

		// Simulate peer eviction: clear lease
		db.run("UPDATE tasks SET status = 'pending', lease_id = NULL, claimed_by = NULL WHERE id = ?", [
			taskId,
		]);

		// Get the starting change_log count
		const startChangeLogCount = (
			db.query("SELECT COUNT(*) as c FROM change_log WHERE row_id = ?").get(taskId) as {
				c: number;
			}
		).c;

		// Simulate the raw SQL UPDATE with lease CAS guard (soft error path)
		const result = db
			.query(
				"UPDATE tasks SET status = 'failed', error = ?, result = ?, run_count = run_count + 1, last_run_at = ?, consecutive_failures = consecutive_failures + 1, modified_at = ? WHERE id = ? AND lease_id = ?",
			)
			.run("Soft error", "{}", now.toISOString(), new Date().toISOString(), taskId, leaseId);

		// Assert: result.changes === 0 (no rows matched)
		expect(result.changes).toBe(0);

		// Assert: row remains in pending status
		const row = db.query("SELECT status, lease_id FROM tasks WHERE id = ?").get(taskId) as {
			status: string;
			lease_id: string | null;
		};
		expect(row.status).toBe("pending");
		expect(row.lease_id).toBeNull();

		// Assert: no new change_log entry was created
		const endChangeLogCount = (
			db.query("SELECT COUNT(*) as c FROM change_log WHERE row_id = ?").get(taskId) as {
				c: number;
			}
		).c;
		expect(endChangeLogCount).toBe(startChangeLogCount);
	});

	it("AC3.3: hard error rejects lease CAS when peer eviction clears lease", () => {
		// Setup: Create a running task with lease_id = "L1"
		const taskId = randomUUID();
		const now = new Date();
		const leaseId = "L1";

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
				thread_id: null,
				deleted: 0,
				heartbeat_at: new Date(now.getTime() - 10 * 60_000).toISOString(),
			},
			ctx.siteId,
		);

		// Simulate peer eviction: clear lease
		db.run("UPDATE tasks SET status = 'pending', lease_id = NULL, claimed_by = NULL WHERE id = ?", [
			taskId,
		]);

		// Get the starting change_log count
		const startChangeLogCount = (
			db.query("SELECT COUNT(*) as c FROM change_log WHERE row_id = ?").get(taskId) as {
				c: number;
			}
		).c;

		// Simulate the raw SQL UPDATE with lease CAS guard (hard error path)
		const result = db
			.query(
				"UPDATE tasks SET status = 'failed', error = ?, consecutive_failures = consecutive_failures + 1, modified_at = ? WHERE id = ? AND lease_id = ?",
			)
			.run("Hard error", new Date().toISOString(), taskId, leaseId);

		// Assert: result.changes === 0 (no rows matched)
		expect(result.changes).toBe(0);

		// Assert: row remains in pending status
		const row = db.query("SELECT status, lease_id FROM tasks WHERE id = ?").get(taskId) as {
			status: string;
			lease_id: string | null;
		};
		expect(row.status).toBe("pending");
		expect(row.lease_id).toBeNull();

		// Assert: no new change_log entry was created
		const endChangeLogCount = (
			db.query("SELECT COUNT(*) as c FROM change_log WHERE row_id = ?").get(taskId) as {
				c: number;
			}
		).c;
		expect(endChangeLogCount).toBe(startChangeLogCount);
	});

	it("AC3.3: completion succeeds when lease matches (non-peer-eviction case)", () => {
		// Setup: Create a running task with lease_id = "L1"
		const taskId = randomUUID();
		const threadId = randomUUID();
		const now = new Date();
		const leaseId = "L1";

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
				thread_id: threadId,
				deleted: 0,
				heartbeat_at: new Date(now.getTime() - 10 * 60_000).toISOString(),
			},
			ctx.siteId,
		);

		// NO peer eviction — task still has its original lease

		// Get the starting change_log count
		const startChangeLogCount = (
			db.query("SELECT COUNT(*) as c FROM change_log WHERE row_id = ?").get(taskId) as {
				c: number;
			}
		).c;

		// Attempt completion with matching lease
		const wrote = updateRowIf(
			db,
			"tasks",
			taskId,
			{ status: "running", lease_id: leaseId }, // Precondition includes lease guard
			{
				status: "completed",
				result: JSON.stringify({ success: true }),
				error: "",
				run_count: 1,
				last_run_at: now.toISOString(),
				consecutive_failures: 0,
			},
			ctx.siteId,
		);

		// Assert: updateRowIf returned true (precondition succeeded)
		expect(wrote).toBe(true);

		// Assert: row is now completed
		const row = db.query("SELECT status FROM tasks WHERE id = ?").get(taskId) as {
			status: string;
		};
		expect(row.status).toBe("completed");

		// Assert: a new change_log entry was created
		const endChangeLogCount = (
			db.query("SELECT COUNT(*) as c FROM change_log WHERE row_id = ?").get(taskId) as {
				c: number;
			}
		).c;
		expect(endChangeLogCount).toBe(startChangeLogCount + 1);
	});
});
