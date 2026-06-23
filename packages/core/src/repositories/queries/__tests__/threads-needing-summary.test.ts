import Database from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { Message, Thread } from "@bound/shared";
import { applyMetricsSchema, applySchema, insertRow, softDelete, updateRow } from "../../../index";
import { listThreadsNeedingSummary } from "../threads-needing-summary";

const SITE_ID = "site-test";

/** Build a fully-populated `threads` row; override what each test cares about. */
function makeThread(overrides: Partial<Thread> & { id: string }): Thread {
	return {
		id: overrides.id,
		user_id: "user-1",
		interface: "web",
		host_origin: "host-a",
		color: 0,
		title: null,
		// Default summary-less so the thread is a summary candidate unless overridden.
		summary: null,
		summary_through: null,
		summary_model_id: null,
		extracted_through: null,
		created_at: "2026-01-01T00:00:00.000Z",
		last_message_at: "2026-01-01T00:00:00.000Z",
		modified_at: "2026-01-01T00:00:00.000Z",
		deleted: 0,
		model_hint: null,
		...overrides,
	};
}

function seedThread(db: Database, overrides: Partial<Thread> & { id: string }): void {
	insertRow(db, "threads", makeThread(overrides), SITE_ID);
}

/** Build a fully-populated `messages` row. */
function makeMessage(overrides: Partial<Message> & { id: string; thread_id: string }): Message {
	return {
		id: overrides.id,
		thread_id: overrides.thread_id,
		role: "assistant",
		content: "hi",
		model_id: null,
		tool_name: null,
		created_at: "2026-01-01T00:00:00.000Z",
		modified_at: null,
		host_origin: "host-a",
		deleted: 0,
		exit_code: null,
		metadata: null,
		...overrides,
	};
}

function seedMessage(
	db: Database,
	overrides: Partial<Message> & { id: string; thread_id: string },
): void {
	insertRow(db, "messages", makeMessage(overrides), SITE_ID);
}

describe("threads-needing-summary finder", () => {
	let db: Database;

	beforeEach(() => {
		db = new Database(":memory:");
		applySchema(db);
		applyMetricsSchema(db);
	});

	afterEach(() => {
		db.close();
	});

	describe("listThreadsNeedingSummary — happy path + projection shape", () => {
		it("returns a summary-less live thread that has a live assistant message", () => {
			seedThread(db, { id: "t-1" });
			seedMessage(db, { id: "m-1", thread_id: "t-1", role: "assistant" });

			const rows = listThreadsNeedingSummary(db, 50);
			// Hand-written oracle: exactly one row, exactly this id.
			expect(rows).toEqual([{ id: "t-1" }]);
		});

		it("projects only the `id` column (exact key set the call site destructures)", () => {
			seedThread(db, { id: "t-1", title: "ignored", summary: null });
			seedMessage(db, { id: "m-1", thread_id: "t-1", role: "assistant" });

			const rows = listThreadsNeedingSummary(db, 50);
			expect(rows).toHaveLength(1);
			expect(Object.keys(rows[0])).toEqual(["id"]);
			expect(rows[0]).toEqual({ id: "t-1" });
		});

		it("returns [] when there are no threads", () => {
			expect(listThreadsNeedingSummary(db, 50)).toEqual([]);
		});
	});

	describe("EXISTS subquery — the right side (messages) gates inclusion", () => {
		it("excludes a thread with NO messages at all (EXISTS false)", () => {
			seedThread(db, { id: "t-empty" });
			// No messages seeded for this thread.
			expect(listThreadsNeedingSummary(db, 50)).toEqual([]);
		});

		it("excludes a thread whose only messages are non-assistant roles", () => {
			seedThread(db, { id: "t-user-only" });
			seedMessage(db, { id: "m-u", thread_id: "t-user-only", role: "user" });
			seedMessage(db, { id: "m-t", thread_id: "t-user-only", role: "tool_result" });
			// No assistant message → EXISTS is false → excluded.
			expect(listThreadsNeedingSummary(db, 50)).toEqual([]);
		});

		it("includes a thread that has at least one assistant message among others", () => {
			seedThread(db, { id: "t-mixed" });
			seedMessage(db, { id: "m-u", thread_id: "t-mixed", role: "user" });
			seedMessage(db, { id: "m-a", thread_id: "t-mixed", role: "assistant" });
			seedMessage(db, { id: "m-d", thread_id: "t-mixed", role: "developer" });

			expect(listThreadsNeedingSummary(db, 50)).toEqual([{ id: "t-mixed" }]);
		});

		it("does not match an assistant message that belongs to a DIFFERENT thread", () => {
			seedThread(db, { id: "t-target" });
			seedThread(db, { id: "t-other" });
			// The assistant message lives under t-other, not t-target.
			seedMessage(db, { id: "m-a", thread_id: "t-other", role: "assistant" });

			const rows = listThreadsNeedingSummary(db, 50);
			// Only t-other qualifies; t-target has no assistant message of its own.
			expect(rows).toEqual([{ id: "t-other" }]);
		});

		it("excludes a thread whose only assistant message is soft-deleted (right-side deleted=0 filter)", () => {
			seedThread(db, { id: "t-deadmsg" });
			seedMessage(db, { id: "m-a", thread_id: "t-deadmsg", role: "assistant" });
			softDelete(db, "messages", "m-a", SITE_ID);

			// The lone assistant message is tombstoned → EXISTS false → excluded.
			expect(listThreadsNeedingSummary(db, 50)).toEqual([]);
		});

		it("includes a thread that has a live assistant message alongside a soft-deleted one", () => {
			seedThread(db, { id: "t-onelive" });
			seedMessage(db, { id: "m-dead", thread_id: "t-onelive", role: "assistant" });
			seedMessage(db, { id: "m-live", thread_id: "t-onelive", role: "assistant" });
			softDelete(db, "messages", "m-dead", SITE_ID);

			expect(listThreadsNeedingSummary(db, 50)).toEqual([{ id: "t-onelive" }]);
		});
	});

	describe("left-side (threads) predicate filtering", () => {
		it("excludes a thread that already has a summary (summary IS NOT NULL)", () => {
			seedThread(db, { id: "t-summarized", summary: "already done" });
			seedMessage(db, { id: "m-a", thread_id: "t-summarized", role: "assistant" });

			expect(listThreadsNeedingSummary(db, 50)).toEqual([]);
		});

		it("excludes a thread whose summary was set to a non-null value via updateRow", () => {
			seedThread(db, { id: "t-late-summary" });
			seedMessage(db, { id: "m-a", thread_id: "t-late-summary", role: "assistant" });
			// Before summarizing, it is a candidate.
			expect(listThreadsNeedingSummary(db, 50)).toEqual([{ id: "t-late-summary" }]);

			updateRow(
				db,
				"threads",
				"t-late-summary",
				{ summary: "now summarized", modified_at: "2026-02-02T00:00:00.000Z" },
				SITE_ID,
			);
			// After summarizing, it drops out.
			expect(listThreadsNeedingSummary(db, 50)).toEqual([]);
		});

		it("excludes a soft-deleted thread even with a live assistant message (left-side deleted=0)", () => {
			seedThread(db, { id: "t-dead" });
			seedMessage(db, { id: "m-a", thread_id: "t-dead", role: "assistant" });
			softDelete(db, "threads", "t-dead", SITE_ID);

			expect(listThreadsNeedingSummary(db, 50)).toEqual([]);
		});

		it("treats empty-string summary as a present summary (only NULL qualifies)", () => {
			// summary IS NULL is strict — an empty string is non-null and excludes the row.
			seedThread(db, { id: "t-empty-summary", summary: "" });
			seedMessage(db, { id: "m-a", thread_id: "t-empty-summary", role: "assistant" });

			expect(listThreadsNeedingSummary(db, 50)).toEqual([]);
		});
	});

	describe("LIMIT cap", () => {
		it("caps the number of returned rows at `limit`", () => {
			// Seed 5 qualifying threads, each with a live assistant message.
			for (let i = 0; i < 5; i++) {
				const id = `t-${i}`;
				seedThread(db, { id });
				seedMessage(db, { id: `m-${i}`, thread_id: id, role: "assistant" });
			}

			const rows = listThreadsNeedingSummary(db, 3);
			expect(rows).toHaveLength(3);
			// Every returned row carries the bare id projection.
			for (const r of rows) {
				expect(Object.keys(r)).toEqual(["id"]);
			}
			// The returned ids are a subset of the seeded set (no fabricated rows).
			const seeded = new Set(["t-0", "t-1", "t-2", "t-3", "t-4"]);
			for (const r of rows) {
				expect(seeded.has(r.id)).toBe(true);
			}
		});

		it("returns all qualifying rows when the cap exceeds the candidate count", () => {
			seedThread(db, { id: "t-a" });
			seedMessage(db, { id: "m-a", thread_id: "t-a", role: "assistant" });
			seedThread(db, { id: "t-b" });
			seedMessage(db, { id: "m-b", thread_id: "t-b", role: "assistant" });

			const rows = listThreadsNeedingSummary(db, 100);
			expect(rows).toHaveLength(2);
			expect(rows.map((r) => r.id).sort()).toEqual(["t-a", "t-b"]);
		});

		it("returns [] when limit is 0", () => {
			seedThread(db, { id: "t-a" });
			seedMessage(db, { id: "m-a", thread_id: "t-a", role: "assistant" });
			expect(listThreadsNeedingSummary(db, 0)).toEqual([]);
		});
	});

	describe("mixed-population integration", () => {
		it("returns exactly the qualifying threads out of a mixed seed set", () => {
			// Qualifies: live, summary NULL, has live assistant message.
			seedThread(db, { id: "q-1" });
			seedMessage(db, { id: "qm-1", thread_id: "q-1", role: "assistant" });

			seedThread(db, { id: "q-2" });
			seedMessage(db, { id: "qm-2u", thread_id: "q-2", role: "user" });
			seedMessage(db, { id: "qm-2a", thread_id: "q-2", role: "assistant" });

			// Disqualified: already summarized.
			seedThread(db, { id: "x-summary", summary: "done" });
			seedMessage(db, { id: "xm-s", thread_id: "x-summary", role: "assistant" });

			// Disqualified: no assistant message.
			seedThread(db, { id: "x-nouser" });
			seedMessage(db, { id: "xm-u", thread_id: "x-nouser", role: "user" });

			// Disqualified: soft-deleted thread.
			seedThread(db, { id: "x-dead" });
			seedMessage(db, { id: "xm-d", thread_id: "x-dead", role: "assistant" });
			softDelete(db, "threads", "x-dead", SITE_ID);

			// Disqualified: only assistant message is soft-deleted.
			seedThread(db, { id: "x-deadmsg" });
			seedMessage(db, { id: "xm-dm", thread_id: "x-deadmsg", role: "assistant" });
			softDelete(db, "messages", "xm-dm", SITE_ID);

			const rows = listThreadsNeedingSummary(db, 100);
			expect(rows.map((r) => r.id).sort()).toEqual(["q-1", "q-2"]);
		});
	});
});
