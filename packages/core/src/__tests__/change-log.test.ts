import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { randomUUID } from "node:crypto";
import { randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TypedEventEmitter } from "@bound/shared";
import {
	createChangeLogEntry,
	insertRow,
	setChangelogEventBus,
	softDelete,
	updateRow,
	updateRowIf,
	withChangeLog,
	withTx,
} from "../change-log";
import { createDatabase } from "../database";
import { applySchema } from "../schema";

describe("Change Log Producer", () => {
	let dbPath: string;
	let db: ReturnType<typeof createDatabase>;
	const siteId = "site-123";
	const userRow = <T extends Record<string, unknown> = Record<never, never>>(
		id: string,
		displayName: string,
		now: string,
		extra?: T,
	) => ({
		id,
		display_name: displayName,
		first_seen_at: now,
		modified_at: now,
		deleted: 0,
		...extra,
	});

	beforeEach(() => {
		dbPath = join(tmpdir(), `bound-test-${randomBytes(4).toString("hex")}.db`);
		db = createDatabase(dbPath);
		applySchema(db);
	});

	afterEach(() => {
		setChangelogEventBus(null);
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

		const rowData = userRow(userId, "Alice", now);

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

		const userData = userRow(userId, "Bob", now);

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
		const userData = userRow(userId, "Charlie", now);

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
			.query("SELECT * FROM change_log WHERE row_id = ? ORDER BY hlc")
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
		const userData = userRow(userId, "Diana", now);

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
			.query("SELECT * FROM change_log WHERE row_id = ? ORDER BY hlc")
			.all(userId) as Array<Record<string, unknown>>;

		expect(entries.length).toBe(2); // insert + delete
		const deleteEntry = entries[1];
		expect(deleteEntry.table_name).toBe("users");

		const rowData = JSON.parse(deleteEntry.row_data as string);
		expect(rowData.deleted).toBe(1);
	});

	it("generates monotonically increasing HLC values", () => {
		const user1Id = randomUUID();
		const user2Id = randomUUID();
		const now = new Date().toISOString();

		const user1 = userRow(user1Id, "User1", now);
		const user2 = userRow(user2Id, "User2", now);

		insertRow(db, "users", user1, siteId);
		insertRow(db, "users", user2, siteId);

		const entries = db.query("SELECT hlc FROM change_log ORDER BY hlc").all() as Array<{
			hlc: string;
		}>;

		expect(entries.length).toBe(2);
		expect(entries[1].hlc > entries[0].hlc).toBe(true);
	});

	it("preserves originating site_id in change log", () => {
		const userId = randomUUID();
		const now = new Date().toISOString();
		const originatingSiteId = "originating-host-123";

		const userData = userRow(userId, "Eve", now);

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

		const userData = userRow(userId, "Frank", now, {
			platform_ids: JSON.stringify({ discord: "discord-123" }),
		});

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
			const userData = userRow(userId, "Grace", now);

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
				const userData = userRow(userId, "Hank", now);

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

	it("rejects role='system' inserts into the messages table", () => {
		// Invariant #19: role='system' is reserved for the LLM driver layer
		// (stable-prefix system prompt). It must never be persisted into the
		// messages table — Stage 2.5 of context assembly strips such rows, so
		// anything written with role:'system' is silently invisible to the
		// agent. Enforce at insertRow() so the failure is loud and immediate.
		const userId = randomUUID();
		const threadId = randomUUID();
		const now = new Date().toISOString();

		// Minimal fixture: a user + thread that satisfies FK-free STRICT inserts.
		insertRow(db, "users", userRow(userId, "Invariant", now), siteId);
		insertRow(
			db,
			"threads",
			{
				id: threadId,
				user_id: userId,
				interface: "discord",
				host_origin: "test",
				color: 0,
				title: "t",
				summary: null,
				created_at: now,
				last_message_at: now,
				modified_at: now,
				deleted: 0,
			},
			siteId,
		);

		const messageId = randomUUID();
		expect(() =>
			insertRow(
				db,
				"messages",
				{
					id: messageId,
					thread_id: threadId,
					role: "system",
					content: "should be rejected",
					model_id: null,
					tool_name: null,
					created_at: now,
					modified_at: now,
					host_origin: "test",
					deleted: 0,
				},
				siteId,
			),
		).toThrow(/role.*system.*messages/i);

		// And the row must NOT have landed in the DB.
		const row = db.query("SELECT * FROM messages WHERE id = ?").get(messageId);
		expect(row).toBeNull();
	});

	it("accepts role='developer' inserts into the messages table", () => {
		// Sibling assertion to the invariant above: the intended replacement
		// for injected system-generated context is role='developer', which
		// passes Stage 2.5 and reaches the LLM.
		const userId = randomUUID();
		const threadId = randomUUID();
		const now = new Date().toISOString();

		insertRow(db, "users", userRow(userId, "Dev", now), siteId);
		insertRow(
			db,
			"threads",
			{
				id: threadId,
				user_id: userId,
				interface: "discord",
				host_origin: "test",
				color: 0,
				title: "t",
				summary: null,
				created_at: now,
				last_message_at: now,
				modified_at: now,
				deleted: 0,
			},
			siteId,
		);

		const messageId = randomUUID();
		insertRow(
			db,
			"messages",
			{
				id: messageId,
				thread_id: threadId,
				role: "developer",
				content: "injected context",
				model_id: null,
				tool_name: null,
				created_at: now,
				modified_at: now,
				host_origin: "test",
				deleted: 0,
			},
			siteId,
		);

		const row = db.query("SELECT role, content FROM messages WHERE id = ?").get(messageId) as {
			role: string;
			content: string;
		};
		expect(row.role).toBe("developer");
		expect(row.content).toBe("injected context");
	});

	describe("updateRowIf (CAS)", () => {
		it("updates and writes change_log when precondition matches", () => {
			const taskId = randomUUID();
			const now = new Date().toISOString();

			insertRow(
				db,
				"tasks",
				{
					id: taskId,
					type: "deferred",
					status: "running",
					trigger_spec: "{}",
					payload: null,
					created_at: now,
					modified_at: now,
					deleted: 0,
					run_count: 0,
					error: "evicted due to heartbeat timeout",
				},
				siteId,
			);

			const wrote = updateRowIf(
				db,
				"tasks",
				taskId,
				{ status: "running" },
				{ status: "completed", error: "", run_count: 1 },
				siteId,
			);

			expect(wrote).toBe(true);

			const row = db.query("SELECT * FROM tasks WHERE id = ?").get(taskId) as Record<
				string,
				unknown
			>;
			expect(row.status).toBe("completed");
			expect(row.error).toBe("");
			expect(row.run_count).toBe(1);

			const entries = db
				.query("SELECT * FROM change_log WHERE row_id = ? ORDER BY hlc")
				.all(taskId) as Array<Record<string, unknown>>;
			expect(entries.length).toBe(2); // insert + update
		});

		it("returns false and does not write when precondition fails", () => {
			const taskId = randomUUID();
			const now = new Date().toISOString();

			// Task already evicted to status='failed' — completion racing must lose.
			insertRow(
				db,
				"tasks",
				{
					id: taskId,
					type: "deferred",
					status: "failed",
					trigger_spec: "{}",
					payload: null,
					created_at: now,
					modified_at: now,
					deleted: 0,
					run_count: 0,
					error: "evicted due to heartbeat timeout",
				},
				siteId,
			);

			const insertModifiedAt = (
				db.query("SELECT modified_at FROM tasks WHERE id = ?").get(taskId) as {
					modified_at: string;
				}
			).modified_at;

			const wrote = updateRowIf(
				db,
				"tasks",
				taskId,
				{ status: "running" },
				{ status: "completed", error: "", run_count: 1 },
				siteId,
			);

			expect(wrote).toBe(false);

			const row = db.query("SELECT * FROM tasks WHERE id = ?").get(taskId) as Record<
				string,
				unknown
			>;
			// State preserved — eviction wins the race.
			expect(row.status).toBe("failed");
			expect(row.error).toBe("evicted due to heartbeat timeout");
			expect(row.run_count).toBe(0);
			// modified_at must NOT be bumped on a failed CAS.
			expect(row.modified_at).toBe(insertModifiedAt);

			// Only the insert change_log entry — no update written.
			const entries = db.query("SELECT * FROM change_log WHERE row_id = ?").all(taskId) as Array<
				Record<string, unknown>
			>;
			expect(entries.length).toBe(1);
		});

		it("validates column names in both updates and where clauses", () => {
			const taskId = randomUUID();
			const now = new Date().toISOString();

			insertRow(
				db,
				"tasks",
				{
					id: taskId,
					type: "deferred",
					status: "running",
					trigger_spec: "{}",
					payload: null,
					created_at: now,
					modified_at: now,
					deleted: 0,
					run_count: 0,
				},
				siteId,
			);

			expect(() =>
				updateRowIf(
					db,
					"tasks",
					taskId,
					{ "status; DROP TABLE tasks --": "running" } as never,
					{ status: "completed" },
					siteId,
				),
			).toThrow(/Invalid column name/);

			expect(() =>
				updateRowIf(
					db,
					"tasks",
					taskId,
					{ status: "running" },
					{ "status; DROP TABLE tasks --": "completed" } as never,
					siteId,
				),
			).toThrow(/Invalid column name/);
		});
	});

	describe("changelog:written events", () => {
		function recordEvents() {
			const events: Array<{ hlc: string; tableName: string; userCount: number }> = [];
			const eventBus = new TypedEventEmitter();
			eventBus.on("changelog:written", ({ hlc, tableName }) => {
				const userCount = (
					db.query("SELECT COUNT(*) AS count FROM users").get() as { count: number }
				).count;
				events.push({ hlc, tableName, userCount });
			});
			setChangelogEventBus(eventBus);
			return events;
		}

		function insertUser(id: string, displayName: string): void {
			const now = new Date().toISOString();
			insertRow(db, "users", userRow(id, displayName, now), siteId);
		}

		function eventRowIds(events: ReadonlyArray<{ hlc: string }>): string[] {
			return events.map(
				({ hlc }) =>
					(db.query("SELECT row_id FROM change_log WHERE hlc = ?").get(hlc) as { row_id: string })
						.row_id,
			);
		}

		it("emits standalone writes and skips a failed CAS", () => {
			const events = recordEvents();
			const userId = randomUUID();
			insertUser(userId, "Events");
			expect(
				updateRowIf(db, "users", userId, { deleted: 1 }, { display_name: "Nope" }, siteId),
			).toBe(false);
			updateRow(db, "users", userId, { display_name: "Updated" }, siteId);
			expect(events.map(({ tableName }) => tableName)).toEqual(["users", "users"]);
		});

		it("delivers nested writes after the outer commit in original write order", () => {
			const events = recordEvents();
			const firstId = randomUUID();
			const secondId = randomUUID();
			withTx(db, () => {
				insertUser(firstId, "First");
				withTx(db, () => insertUser(secondId, "Second"));
				updateRow(db, "users", firstId, { display_name: "First updated" }, siteId);
				expect(events).toEqual([]);
			});
			expect(eventRowIds(events)).toEqual([firstId, secondId, firstId]);
			expect(events.map(({ userCount }) => userCount)).toEqual([2, 2, 2]);
			expect(db.query("SELECT display_name FROM users WHERE id = ?").get(firstId)).toEqual({
				display_name: "First updated",
			});
		});

		it("discards all events when the outer transaction rolls back", () => {
			const events = recordEvents();
			const userId = randomUUID();
			expect(() =>
				withTx(db, () => {
					insertUser(userId, "Rollback");
					throw new Error("outer rollback");
				}),
			).toThrow("outer rollback");
			expect(events).toEqual([]);
			expect(db.query("SELECT * FROM users WHERE id = ?").get(userId)).toBeNull();
		});

		it("discards rolled-back savepoint writes without losing surviving outer writes", () => {
			const events = recordEvents();
			const beforeId = randomUUID();
			const rolledBackId = randomUUID();
			const afterId = randomUUID();
			withTx(db, () => {
				insertUser(beforeId, "Before");
				expect(() =>
					withTx(db, () => {
						insertUser(rolledBackId, "Rolled back");
						throw new Error("savepoint rollback");
					}),
				).toThrow("savepoint rollback");
				insertUser(afterId, "After");
			});
			expect(eventRowIds(events)).toEqual([beforeId, afterId]);
			expect(db.query("SELECT * FROM users WHERE id = ?").get(rolledBackId)).toBeNull();
		});

		it("drains a, b, then a listener's reentrant committed write in HLC order", () => {
			const events: Array<{ hlc: string; rowId: string }> = [];
			const ids = [randomUUID(), randomUUID(), randomUUID()];
			const eventBus = new TypedEventEmitter();
			eventBus.on("changelog:written", ({ hlc }) => {
				const rowId = (
					db.query("SELECT row_id FROM change_log WHERE hlc = ?").get(hlc) as {
						row_id: string;
					}
				).row_id;
				events.push({ hlc, rowId });
				if (rowId === ids[0]) insertUser(ids[2], "Reentrant");
			});
			setChangelogEventBus(eventBus);
			withTx(db, () => {
				insertUser(ids[0], "A");
				insertUser(ids[1], "B");
			});
			expect(events.map(({ rowId }) => rowId)).toEqual(ids);
			expect(events.map(({ hlc }) => hlc)).toEqual([...events.map(({ hlc }) => hlc)].sort());
			expect(db.query("SELECT COUNT(*) AS count FROM users").get()).toEqual({ count: 3 });
		});

		it("attempts every committed event before propagating the first listener failure", () => {
			const delivered: string[] = [];
			const eventBus = new TypedEventEmitter();
			eventBus.on("changelog:written", ({ hlc }) => {
				delivered.push(hlc);
				if (delivered.length === 1) throw new Error("listener failed");
			});
			setChangelogEventBus(eventBus);
			expect(() =>
				withTx(db, () => {
					insertUser(randomUUID(), "A");
					insertUser(randomUUID(), "B");
				}),
			).toThrow("listener failed");
			expect(delivered).toHaveLength(2);
			// A later standalone write still propagates its listener error directly.
			const standaloneBus = new TypedEventEmitter();
			standaloneBus.on("changelog:written", () => {
				throw new Error("standalone listener failed");
			});
			setChangelogEventBus(standaloneBus);
			expect(() => insertUser(randomUUID(), "C")).toThrow("standalone listener failed");
		});
	});
});
