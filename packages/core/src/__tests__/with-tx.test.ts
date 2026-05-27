import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { insertRow, updateRowIf, withTx } from "../change-log";
import { createDatabase } from "../database";
import { applySchema } from "../schema";

describe("withTx(db, fn) — transaction wrapping helper", () => {
	let db: Database;

	beforeEach(() => {
		db = createDatabase(":memory:");
		applySchema(db);
	});

	afterEach(() => {
		db.close();
	});

	it("commits successful transaction and creates one change_log entry", () => {
		// Setup: insert a task row
		insertRow(
			db,
			"tasks",
			{
				id: "t1",
				type: "cron",
				trigger_spec: "0 * * * *",
				status: "pending",
				created_at: new Date().toISOString(),
				modified_at: new Date().toISOString(),
				claimed_by: null,
				claimed_at: null,
				lease_id: null,
				error: null,
				result: null,
				consecutive_failures: 0,
				alert_threshold: 3,
				next_run_at: null,
				thread_id: null,
				deleted: 0,
				heartbeat_at: null,
			},
			"site-1",
		);

		// Get initial change_log count
		const beforeCount = (
			db.query("SELECT COUNT(*) as c FROM change_log WHERE row_id = ?").get("t1") as {
				c: number;
			}
		).c;

		// Execute withTx block with updateRowIf inside
		const result = withTx(db, () => {
			return updateRowIf(
				db,
				"tasks",
				"t1",
				{ status: "pending" },
				{
					status: "running",
					claimed_by: "site-1",
					claimed_at: new Date().toISOString(),
					lease_id: "L1",
				},
				"site-1",
			);
		});

		// Assert: updateRowIf succeeded (returned true)
		expect(result).toBe(true);

		// Assert: row was updated
		const row = db
			.query("SELECT status, claimed_by, lease_id FROM tasks WHERE id = ?")
			.get("t1") as {
			status: string;
			claimed_by: string | null;
			lease_id: string | null;
		};
		expect(row.status).toBe("running");
		expect(row.claimed_by).toBe("site-1");
		expect(row.lease_id).toBe("L1");

		// Assert: exactly one new change_log entry
		const afterCount = (
			db.query("SELECT COUNT(*) as c FROM change_log WHERE row_id = ?").get("t1") as {
				c: number;
			}
		).c;
		expect(afterCount).toBe(beforeCount + 1);
	});

	it("rolls back transaction on throw and creates zero change_log entries", () => {
		// Setup: insert a task row
		insertRow(
			db,
			"tasks",
			{
				id: "t2",
				type: "heartbeat",
				trigger_spec: JSON.stringify({ interval_ms: 60_000 }),
				status: "pending",
				created_at: new Date().toISOString(),
				modified_at: new Date().toISOString(),
				claimed_by: null,
				claimed_at: null,
				lease_id: null,
				error: null,
				result: null,
				consecutive_failures: 0,
				alert_threshold: 3,
				next_run_at: null,
				thread_id: null,
				deleted: 0,
				heartbeat_at: null,
			},
			"site-1",
		);

		const beforeCount = (
			db.query("SELECT COUNT(*) as c FROM change_log WHERE row_id = ?").get("t2") as {
				c: number;
			}
		).c;
		const beforeStatus = (
			db.query("SELECT status FROM tasks WHERE id = ?").get("t2") as { status: string }
		).status;

		// Execute withTx block that throws after updateRowIf
		let exceptionThrown = false;
		try {
			withTx(db, () => {
				updateRowIf(
					db,
					"tasks",
					"t2",
					{ status: "pending" },
					{ status: "running", claimed_by: "site-1" },
					"site-1",
				);
				throw new Error("simulated failure");
			});
		} catch (_e) {
			exceptionThrown = true;
		}

		// Assert: exception was thrown
		expect(exceptionThrown).toBe(true);

		// Assert: row unchanged (rollback occurred)
		const afterStatus = (
			db.query("SELECT status FROM tasks WHERE id = ?").get("t2") as { status: string }
		).status;
		expect(afterStatus).toBe(beforeStatus);

		// Assert: no new change_log entries (rollback)
		const afterCount = (
			db.query("SELECT COUNT(*) as c FROM change_log WHERE row_id = ?").get("t2") as {
				c: number;
			}
		).c;
		expect(afterCount).toBe(beforeCount);
	});

	it("returns the function's result directly", () => {
		const result = withTx(db, () => {
			return 42;
		});

		expect(result).toBe(42);
	});

	it("returns complex object from withTx function", () => {
		const obj = { key: "value", num: 123 };
		const result = withTx(db, () => {
			return obj;
		});

		expect(result).toEqual(obj);
	});

	it("supports nested updateRowIf calls producing multiple change_log entries", () => {
		// Setup: insert two task rows
		insertRow(
			db,
			"tasks",
			{
				id: "t3",
				type: "cron",
				trigger_spec: "0 * * * *",
				status: "pending",
				created_at: new Date().toISOString(),
				modified_at: new Date().toISOString(),
				claimed_by: null,
				claimed_at: null,
				lease_id: null,
				error: null,
				result: null,
				consecutive_failures: 0,
				alert_threshold: 3,
				next_run_at: null,
				thread_id: null,
				deleted: 0,
				heartbeat_at: null,
			},
			"site-1",
		);

		insertRow(
			db,
			"tasks",
			{
				id: "t4",
				type: "event",
				trigger_spec: "test",
				status: "pending",
				created_at: new Date().toISOString(),
				modified_at: new Date().toISOString(),
				claimed_by: null,
				claimed_at: null,
				lease_id: null,
				error: null,
				result: null,
				consecutive_failures: 0,
				alert_threshold: 3,
				next_run_at: null,
				thread_id: "th1",
				deleted: 0,
				heartbeat_at: null,
			},
			"site-1",
		);

		const countBefore = (
			db.query("SELECT COUNT(*) as c FROM change_log WHERE row_id IN (?, ?)").get("t3", "t4") as {
				c: number;
			}
		).c;

		// Execute withTx with two updateRowIf calls
		withTx(db, () => {
			updateRowIf(
				db,
				"tasks",
				"t3",
				{ status: "pending" },
				{ status: "running", claimed_by: "site-1" },
				"site-1",
			);
			updateRowIf(
				db,
				"tasks",
				"t4",
				{ status: "pending" },
				{ status: "running", claimed_by: "site-1" },
				"site-1",
			);
			return true;
		});

		// Assert: two new change_log entries (one per updateRowIf)
		const countAfter = (
			db.query("SELECT COUNT(*) as c FROM change_log WHERE row_id IN (?, ?)").get("t3", "t4") as {
				c: number;
			}
		).c;
		expect(countAfter).toBe(countBefore + 2);
	});
});
