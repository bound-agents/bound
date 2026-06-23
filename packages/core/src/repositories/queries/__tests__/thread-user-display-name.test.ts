import Database from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { Thread, User } from "@bound/shared";
import { applyMetricsSchema, applySchema, insertRow, softDelete, updateRow } from "../../../index";
import { getThreadUserDisplayName } from "../thread-user-display-name";

const SITE_ID = "site-test";
const TS = "2026-01-01T00:00:00.000Z";

function makeUser(overrides: Partial<User> & { id: string; display_name: string }): User {
	return {
		platform_ids: null,
		first_seen_at: TS,
		modified_at: TS,
		deleted: 0,
		...overrides,
	};
}

function makeThread(overrides: Partial<Thread> & { id: string; user_id: string }): Thread {
	return {
		interface: "web",
		host_origin: "host-a",
		color: 0,
		title: null,
		summary: null,
		summary_through: null,
		summary_model_id: null,
		extracted_through: null,
		created_at: TS,
		last_message_at: TS,
		modified_at: TS,
		deleted: 0,
		model_hint: null,
		...overrides,
	};
}

describe("getThreadUserDisplayName", () => {
	let db: Database;

	beforeEach(() => {
		db = new Database(":memory:");
		applySchema(db);
		applyMetricsSchema(db);
	});

	afterEach(() => {
		db.close();
	});

	it("resolves the owner display name via threads JOIN users (happy path)", () => {
		insertRow(db, "users", makeUser({ id: "u1", display_name: "Alice" }), SITE_ID);
		insertRow(db, "threads", makeThread({ id: "t1", user_id: "u1" }), SITE_ID);

		const row = getThreadUserDisplayName(db, "t1");

		// Oracle: hand-written expected projection.
		expect(row).not.toBeNull();
		expect(row).toEqual({ display_name: "Alice" });
	});

	it("projects EXACTLY the display_name column the interface declares", () => {
		insertRow(db, "users", makeUser({ id: "u1", display_name: "Bob" }), SITE_ID);
		insertRow(db, "threads", makeThread({ id: "t1", user_id: "u1" }), SITE_ID);

		const row = getThreadUserDisplayName(db, "t1");

		expect(row).not.toBeNull();
		// Only `display_name` is selected — no other thread/user columns leak in.
		expect(Object.keys(row as object).sort()).toEqual(["display_name"]);
		expect((row as { display_name: string }).display_name).toBe("Bob");
	});

	it("returns null for an absent thread id (miss path)", () => {
		insertRow(db, "users", makeUser({ id: "u1", display_name: "Alice" }), SITE_ID);
		insertRow(db, "threads", makeThread({ id: "t1", user_id: "u1" }), SITE_ID);

		const row = getThreadUserDisplayName(db, "does-not-exist");

		// bun:sqlite .get() returns null (not undefined) on empty reads.
		expect(row).toBeNull();
	});

	it("returns null when the thread exists but its user is absent (INNER JOIN drops the row)", () => {
		// Thread points at a user_id with no matching users row. The INNER JOIN
		// yields no row, so the call returns null rather than a partial projection.
		insertRow(db, "threads", makeThread({ id: "t-orphan", user_id: "ghost-user" }), SITE_ID);

		const row = getThreadUserDisplayName(db, "t-orphan");

		expect(row).toBeNull();
	});

	it("resolves the name for a SOFT-DELETED thread (deleted flag intentionally NOT filtered)", () => {
		// The finder deliberately omits a `deleted = 0` filter on threads so summary
		// generation can resolve the owner regardless of tombstone state. Pin that.
		insertRow(db, "users", makeUser({ id: "u1", display_name: "Carol" }), SITE_ID);
		insertRow(db, "threads", makeThread({ id: "t1", user_id: "u1" }), SITE_ID);
		softDelete(db, "threads", "t1", SITE_ID);

		const row = getThreadUserDisplayName(db, "t1");

		expect(row).toEqual({ display_name: "Carol" });
	});

	it("still joins to a soft-deleted user (users.deleted also NOT filtered)", () => {
		// Neither side of the join is filtered on `deleted`. A tombstoned user still
		// resolves so long as the row physically remains (soft delete keeps the row).
		insertRow(db, "users", makeUser({ id: "u1", display_name: "Dave" }), SITE_ID);
		insertRow(db, "threads", makeThread({ id: "t1", user_id: "u1" }), SITE_ID);
		softDelete(db, "users", "u1", SITE_ID);

		const row = getThreadUserDisplayName(db, "t1");

		expect(row).toEqual({ display_name: "Dave" });
	});

	it("resolves the owner of the queried thread, not a different user's thread", () => {
		insertRow(db, "users", makeUser({ id: "u1", display_name: "Alice" }), SITE_ID);
		insertRow(db, "users", makeUser({ id: "u2", display_name: "Eve" }), SITE_ID);
		insertRow(db, "threads", makeThread({ id: "t1", user_id: "u1" }), SITE_ID);
		insertRow(db, "threads", makeThread({ id: "t2", user_id: "u2" }), SITE_ID);

		expect(getThreadUserDisplayName(db, "t1")).toEqual({ display_name: "Alice" });
		expect(getThreadUserDisplayName(db, "t2")).toEqual({ display_name: "Eve" });
	});

	it("reflects an updated display_name after updateRow on the users side", () => {
		insertRow(db, "users", makeUser({ id: "u1", display_name: "Frank" }), SITE_ID);
		insertRow(db, "threads", makeThread({ id: "t1", user_id: "u1" }), SITE_ID);

		updateRow(db, "users", "u1", { display_name: "Franklin" }, SITE_ID);

		expect(getThreadUserDisplayName(db, "t1")).toEqual({ display_name: "Franklin" });
	});
});
