import Database from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { Message, Thread } from "@bound/shared";
import { applyMetricsSchema, applySchema, insertRow, softDelete } from "../../../index";
import {
	type RecentThreadWithMessagesRow,
	listRecentThreadsWithMessages,
} from "../recent-threads-with-messages";

const SITE_ID = "site-test";
const USER = "user-1";

/**
 * Seed a `threads` row. Only columns the schema actually declares are written —
 * the `Thread` type carries a `model_hint` field that the schema does NOT, so it
 * is omitted (writing it would fail the INSERT). Nullable columns default to null.
 */
function seedThread(db: Database, overrides: Partial<Thread> & { id: string }): void {
	const base = {
		id: overrides.id,
		user_id: USER,
		interface: "web",
		host_origin: SITE_ID,
		color: 0,
		title: null,
		summary: null,
		summary_through: null,
		summary_model_id: null,
		extracted_through: null,
		created_at: "2026-01-01T00:00:00.000Z",
		last_message_at: "2026-01-01T00:00:00.000Z",
		modified_at: "2026-01-01T00:00:00.000Z",
		deleted: 0,
		...overrides,
	};
	insertRow(db, "threads", base as unknown as Thread, SITE_ID);
}

/**
 * Seed a `messages` row. The schema declares columns only through `deleted` (no
 * `exit_code` / `metadata`), so those `Message` fields are omitted.
 */
function seedMessage(
	db: Database,
	overrides: Partial<Message> & { id: string; thread_id: string },
): void {
	const base = {
		id: overrides.id,
		thread_id: overrides.thread_id,
		role: "user",
		content: "hi",
		model_id: null,
		tool_name: null,
		created_at: "2026-01-01T00:00:00.000Z",
		modified_at: null,
		host_origin: SITE_ID,
		deleted: 0,
		...overrides,
	};
	insertRow(db, "messages", base as unknown as Message, SITE_ID);
}

describe("recent-threads-with-messages finder", () => {
	let db: Database;

	beforeEach(() => {
		db = new Database(":memory:");
		applySchema(db);
		applyMetricsSchema(db);
	});

	afterEach(() => {
		db.close();
	});

	describe("listRecentThreadsWithMessages — happy path + projection shape", () => {
		it("projects the exact declared column set for a live thread with a message", () => {
			seedThread(db, {
				id: "t-1",
				title: "Deploy chat",
				color: 3,
				summary: "discussed the deploy",
				last_message_at: "2026-02-02T00:00:00.000Z",
			});
			seedMessage(db, { id: "m-1", thread_id: "t-1" });

			const rows = listRecentThreadsWithMessages(db, USER);
			expect(rows).toHaveLength(1);
			// Hand-written oracle: the EXACT projection call sites destructure.
			expect(rows[0]).toEqual({
				id: "t-1",
				title: "Deploy chat",
				color: 3,
				last_message_at: "2026-02-02T00:00:00.000Z",
				summary: "discussed the deploy",
			} satisfies RecentThreadWithMessagesRow);
			// Exact key set — guards against projection drift.
			expect(Object.keys(rows[0]).sort()).toEqual(
				["color", "id", "last_message_at", "summary", "title"].sort(),
			);
		});

		it("surfaces null title and summary when those columns are null", () => {
			seedThread(db, { id: "t-null", title: null, summary: null });
			seedMessage(db, { id: "m-null", thread_id: "t-null" });

			const rows = listRecentThreadsWithMessages(db, USER);
			expect(rows).toHaveLength(1);
			expect(rows[0].title).toBeNull();
			expect(rows[0].summary).toBeNull();
			expect(rows[0].id).toBe("t-null");
		});

		it("returns [] when the user has no threads", () => {
			expect(listRecentThreadsWithMessages(db, "nobody")).toEqual([]);
		});
	});

	describe("EXISTS(messages) gate — threads with no message are excluded", () => {
		it("omits a live thread that has zero messages", () => {
			seedThread(db, { id: "t-empty", title: "empty" });
			// No messages seeded for t-empty.
			expect(listRecentThreadsWithMessages(db, USER)).toEqual([]);
		});

		it("keeps a thread whose ONLY message is soft-deleted (gate ignores deleted)", () => {
			// The EXISTS gate intentionally does NOT filter messages.deleted, so a
			// thread whose every message is tombstoned still qualifies.
			seedThread(db, { id: "t-softmsg", title: "soft" });
			seedMessage(db, { id: "m-soft", thread_id: "t-softmsg" });
			softDelete(db, "messages", "m-soft", SITE_ID);

			const rows = listRecentThreadsWithMessages(db, USER);
			expect(rows.map((r) => r.id)).toEqual(["t-softmsg"]);
		});

		it("does not match a thread whose only messages belong to a different thread id", () => {
			seedThread(db, { id: "t-a", title: "a" });
			seedThread(db, { id: "t-b", title: "b" });
			// Message belongs to t-b only.
			seedMessage(db, { id: "m-b", thread_id: "t-b" });

			const rows = listRecentThreadsWithMessages(db, USER);
			expect(rows.map((r) => r.id)).toEqual(["t-b"]);
		});
	});

	describe("deleted=0 filter on the thread (left side)", () => {
		it("excludes a soft-deleted thread even though it has a message", () => {
			seedThread(db, { id: "t-live", title: "live" });
			seedMessage(db, { id: "m-live", thread_id: "t-live" });
			seedThread(db, { id: "t-dead", title: "dead" });
			seedMessage(db, { id: "m-dead", thread_id: "t-dead" });
			softDelete(db, "threads", "t-dead", SITE_ID);

			const rows = listRecentThreadsWithMessages(db, USER);
			expect(rows.map((r) => r.id)).toEqual(["t-live"]);
		});
	});

	describe("user_id scoping", () => {
		it("returns only threads owned by the requested user", () => {
			seedThread(db, { id: "t-mine", user_id: USER, title: "mine" });
			seedMessage(db, { id: "m-mine", thread_id: "t-mine" });
			seedThread(db, { id: "t-theirs", user_id: "other-user", title: "theirs" });
			seedMessage(db, { id: "m-theirs", thread_id: "t-theirs" });

			const rows = listRecentThreadsWithMessages(db, USER);
			expect(rows.map((r) => r.id)).toEqual(["t-mine"]);
		});
	});

	describe("excludeThreadId — conditional id != ? clause", () => {
		it("omits the excluded thread while keeping the others", () => {
			seedThread(db, {
				id: "t-current",
				title: "current",
				last_message_at: "2026-05-05T00:00:00.000Z",
			});
			seedMessage(db, { id: "m-current", thread_id: "t-current" });
			seedThread(db, {
				id: "t-other",
				title: "other",
				last_message_at: "2026-04-04T00:00:00.000Z",
			});
			seedMessage(db, { id: "m-other", thread_id: "t-other" });

			const rows = listRecentThreadsWithMessages(db, USER, "t-current");
			expect(rows.map((r) => r.id)).toEqual(["t-other"]);
		});

		it("without excludeThreadId, no thread is omitted", () => {
			seedThread(db, { id: "t-1", title: "one" });
			seedMessage(db, { id: "m-1", thread_id: "t-1" });
			seedThread(db, { id: "t-2", title: "two" });
			seedMessage(db, { id: "m-2", thread_id: "t-2" });

			const rows = listRecentThreadsWithMessages(db, USER);
			expect(rows.map((r) => r.id).sort()).toEqual(["t-1", "t-2"].sort());
		});
	});

	describe("ordering by last_message_at DESC + LIMIT 5 cap", () => {
		it("orders most-recently-active first", () => {
			seedThread(db, {
				id: "t-old",
				last_message_at: "2026-01-01T00:00:00.000Z",
			});
			seedMessage(db, { id: "m-old", thread_id: "t-old" });
			seedThread(db, {
				id: "t-new",
				last_message_at: "2026-06-06T00:00:00.000Z",
			});
			seedMessage(db, { id: "m-new", thread_id: "t-new" });
			seedThread(db, {
				id: "t-mid",
				last_message_at: "2026-03-03T00:00:00.000Z",
			});
			seedMessage(db, { id: "m-mid", thread_id: "t-mid" });

			const rows = listRecentThreadsWithMessages(db, USER);
			expect(rows.map((r) => r.id)).toEqual(["t-new", "t-mid", "t-old"]);
		});

		it("caps the result at 5 and keeps the 5 most recent", () => {
			// Seed 7 qualifying threads with distinct last_message_at values.
			const stamps: Array<[string, string]> = [
				["t-1", "2026-01-01T00:00:00.000Z"],
				["t-2", "2026-02-02T00:00:00.000Z"],
				["t-3", "2026-03-03T00:00:00.000Z"],
				["t-4", "2026-04-04T00:00:00.000Z"],
				["t-5", "2026-05-05T00:00:00.000Z"],
				["t-6", "2026-06-06T00:00:00.000Z"],
				["t-7", "2026-07-07T00:00:00.000Z"],
			];
			for (const [id, last] of stamps) {
				seedThread(db, { id, last_message_at: last });
				seedMessage(db, { id: `msg-${id}`, thread_id: id });
			}

			const rows = listRecentThreadsWithMessages(db, USER);
			expect(rows).toHaveLength(5);
			// The 5 newest, newest-first; t-1 and t-2 fall off the cap.
			expect(rows.map((r) => r.id)).toEqual(["t-7", "t-6", "t-5", "t-4", "t-3"]);
		});
	});
});
