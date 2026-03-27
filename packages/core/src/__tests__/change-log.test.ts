import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { randomUUID } from "node:crypto";
import { randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	createChangeLogEntry,
	insertRow,
	softDelete,
	updateRow,
	withChangeLog,
} from "../change-log";
import { createDatabase } from "../database";
import { applySchema } from "../schema";

describe("Change Log Producer", () => {
	let dbPath: string;
	let db: ReturnType<typeof createDatabase>;
	const siteId = "site-123";

	beforeEach(() => {
		dbPath = join(tmpdir(), `bound-test-${randomBytes(4).toString("hex")}.db`);
		db = createDatabase(dbPath);
		applySchema(db);
	});

	afterEach(() => {
		try {
			db.close();
		} catch {
			// ignore
		}
		try {
			require("node:fs").unlinkSync(dbPath);
		} catch {
			// ignore
		}
	});

	it("creates change log entries with row snapshots", () => {
		const userId = randomUUID();
		const now = new Date().toISOString();

		const rowData = {
			id: userId,
			display_name: "Alice",
			first_seen_at: now,
			modified_at: now,
			deleted: 0,
		};

		createChangeLogEntry(db, "users", userId, siteId, rowData);

		const entry = db.query("SELECT * FROM change_log WHERE row_id = ?").get(userId) as Record<
			string,
			unknown
		>;

		expect(entry).toBeDefined();
		expect(entry.table_name).toBe("users");
		expect(entry.row_id).toBe(userId);
		expect(entry.site_id).toBe(siteId);

		const rowDataFromLog = JSON.parse(entry.row_data as string);
		expect(rowDataFromLog.display_name).toBe("Alice");
	});

	it("inserts row and creates change log entry atomically", () => {
		const userId = randomUUID();
		const now = new Date().toISOString();

		const userData = {
			id: userId,
			display_name: "Bob",
			first_seen_at: now,
			modified_at: now,
			deleted: 0,
		};

		insertRow(db, "users", userData, siteId);

		const user = db.query("SELECT * FROM users WHERE id = ?").get(userId) as Record<
			string,
			unknown
		>;
		expect(user.display_name).toBe("Bob");

		const entry = db.query("SELECT * FROM change_log WHERE row_id = ?").get(userId) as Record<
			string,
			unknown
		>;

		expect(entry).toBeDefined();
		expect(entry.table_name).toBe("users");
	});

	it("updates row and creates change log entry with modified_at", () => {
		const userId = randomUUID();
		const now = new Date().toISOString();

		// Insert initial user
		const userData = {
			id: userId,
			display_name: "Charlie",
			first_seen_at: now,
			modified_at: now,
			deleted: 0,
		};

		insertRow(db, "users", userData, siteId);

		// Update the user
		updateRow(db, "users", userId, { display_name: "Charles" }, siteId);

		const user = db.query("SELECT * FROM users WHERE id = ?").get(userId) as Record<
			string,
			unknown
		>;
		expect(user.display_name).toBe("Charles");

		// Check that change_log has 2 entries (insert + update)
		const entries = db
			.query("SELECT * FROM change_log WHERE row_id = ? ORDER BY seq")
			.all(userId) as Array<Record<string, unknown>>;

		expect(entries.length).toBe(2);

		const updateEntry = entries[1];
		const rowData = JSON.parse(updateEntry.row_data as string);
		expect(rowData.display_name).toBe("Charles");
		expect(rowData.modified_at).toBeDefined();
	});

	it("soft deletes row and creates change log entry", () => {
		const userId = randomUUID();
		const now = new Date().toISOString();

		// Insert user
		const userData = {
			id: userId,
			display_name: "Diana",
			first_seen_at: now,
			modified_at: now,
			deleted: 0,
		};

		insertRow(db, "users", userData, siteId);

		// Soft delete
		softDelete(db, "users", userId, siteId);

		// User should still exist but be marked deleted
		const user = db.query("SELECT * FROM users WHERE id = ?").get(userId) as Record<
			string,
			unknown
		>;
		expect(user.deleted).toBe(1);

		// Change log should have delete entry
		const entries = db
			.query("SELECT * FROM change_log WHERE row_id = ? ORDER BY seq")
			.all(userId) as Array<Record<string, unknown>>;

		expect(entries.length).toBe(2); // insert + delete
		const deleteEntry = entries[1];
		expect(deleteEntry.table_name).toBe("users");

		const rowData = JSON.parse(deleteEntry.row_data as string);
		expect(rowData.deleted).toBe(1);
	});

	it("auto-increments change log sequence number", () => {
		const user1Id = randomUUID();
		const user2Id = randomUUID();
		const now = new Date().toISOString();

		const user1 = {
			id: user1Id,
			display_name: "User1",
			first_seen_at: now,
			modified_at: now,
			deleted: 0,
		};

		const user2 = {
			id: user2Id,
			display_name: "User2",
			first_seen_at: now,
			modified_at: now,
			deleted: 0,
		};

		insertRow(db, "users", user1, siteId);
		insertRow(db, "users", user2, siteId);

		const entries = db.query("SELECT seq FROM change_log ORDER BY seq").all() as Array<{
			seq: number;
		}>;

		expect(entries.length).toBe(2);
		expect(entries[0].seq).toBe(1);
		expect(entries[1].seq).toBe(2);
	});

	it("preserves originating site_id in change log", () => {
		const userId = randomUUID();
		const now = new Date().toISOString();
		const originatingSiteId = "originating-host-123";

		const userData = {
			id: userId,
			display_name: "Eve",
			first_seen_at: now,
			modified_at: now,
			deleted: 0,
		};

		insertRow(db, "users", userData, originatingSiteId);

		const entry = db.query("SELECT * FROM change_log WHERE row_id = ?").get(userId) as Record<
			string,
			unknown
		>;

		expect(entry.site_id).toBe(originatingSiteId);
	});

	it("stores full row data snapshot as JSON", () => {
		const userId = randomUUID();
		const now = new Date().toISOString();

		const userData = {
			id: userId,
			display_name: "Frank",
			platform_ids: JSON.stringify({ discord: "discord-123" }),
			first_seen_at: now,
			modified_at: now,
			deleted: 0,
		};

		insertRow(db, "users", userData, siteId);

		const entry = db.query("SELECT row_data FROM change_log WHERE row_id = ?").get(userId) as {
			row_data: string;
		};

		const rowData = JSON.parse(entry.row_data);
		expect(rowData.id).toBe(userId);
		expect(rowData.display_name).toBe("Frank");
		expect(rowData.platform_ids).toBe(JSON.stringify({ discord: "discord-123" }));
		expect(rowData.first_seen_at).toBe(now);
	});

	it("handles complex row data with JSON fields", () => {
		const taskId = randomUUID();
		const now = new Date().toISOString();

		const taskData = {
			id: taskId,
			type: "cron",
			status: "pending",
			trigger_spec: "0 * * * *",
			payload: JSON.stringify({ action: "check_status" }),
			created_at: now,
			created_by: "user-123",
			thread_id: randomUUID(),
			claimed_by: null,
			claimed_at: null,
			lease_id: null,
			next_run_at: now,
			last_run_at: null,
			run_count: 0,
			max_runs: null,
			requires: JSON.stringify(["github"]),
			model_hint: null,
			no_history: 0,
			inject_mode: "results",
			depends_on: null,
			require_success: 0,
			alert_threshold: 1,
			consecutive_failures: 0,
			event_depth: 0,
			no_quiescence: 0,
			heartbeat_at: null,
			result: null,
			error: null,
			modified_at: now,
			deleted: 0,
		};

		insertRow(db, "tasks", taskData, siteId);

		const entry = db.query("SELECT row_data FROM change_log WHERE row_id = ?").get(taskId) as {
			row_data: string;
		};

		const rowData = JSON.parse(entry.row_data);
		expect(rowData.id).toBe(taskId);
		expect(rowData.payload).toBe(JSON.stringify({ action: "check_status" }));
		expect(rowData.requires).toBe(JSON.stringify(["github"]));
	});

	it("atomically inserts into business table and change_log with withChangeLog", () => {
		const userId = randomUUID();
		const now = new Date().toISOString();

		const result = withChangeLog(db, siteId, () => {
			const userData = {
				id: userId,
				display_name: "Grace",
				first_seen_at: now,
				modified_at: now,
				deleted: 0,
			};

			db.run(
				"INSERT INTO users (id, display_name, first_seen_at, modified_at, deleted) VALUES (?, ?, ?, ?, ?)",
				[
					userId,
					userData.display_name,
					userData.first_seen_at,
					userData.modified_at,
					userData.deleted,
				],
			);

			return {
				tableName: "users",
				rowId: userId,
				rowData: userData,
				result: "success",
			};
		});

		expect(result).toBe("success");

		// Verify user was inserted
		const user = db.query("SELECT * FROM users WHERE id = ?").get(userId) as Record<
			string,
			unknown
		>;
		expect(user.display_name).toBe("Grace");

		// Verify change_log entry was created
		const entry = db.query("SELECT * FROM change_log WHERE row_id = ?").get(userId) as Record<
			string,
			unknown
		>;
		expect(entry).toBeDefined();
		expect(entry.table_name).toBe("users");
	});

	it("rolls back both table and change_log on withChangeLog callback error", () => {
		const userId = randomUUID();
		const now = new Date().toISOString();

		let errorThrown = false;

		try {
			withChangeLog(db, siteId, () => {
				const userData = {
					id: userId,
					display_name: "Hank",
					first_seen_at: now,
					modified_at: now,
					deleted: 0,
				};

				db.run(
					"INSERT INTO users (id, display_name, first_seen_at, modified_at, deleted) VALUES (?, ?, ?, ?, ?)",
					[
						userId,
						userData.display_name,
						userData.first_seen_at,
						userData.modified_at,
						userData.deleted,
					],
				);

				throw new Error("Simulated transaction failure");
			});
		} catch (error) {
			if (error instanceof Error && error.message === "Simulated transaction failure") {
				errorThrown = true;
			}
		}

		expect(errorThrown).toBe(true);

		// Verify user was NOT inserted (rollback worked)
		const user = db.query("SELECT * FROM users WHERE id = ?").get(userId);
		expect(user).toBeNull();

		// Verify change_log entry was NOT created (rollback worked)
		const entry = db.query("SELECT * FROM change_log WHERE row_id = ?").get(userId);
		expect(entry).toBeNull();
	});
});
