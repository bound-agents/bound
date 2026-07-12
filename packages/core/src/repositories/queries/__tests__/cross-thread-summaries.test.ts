import Database from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { Message, Thread } from "@bound/shared";
import { applyMetricsSchema, applySchema, insertRow, softDelete } from "../../../index";
import { listCrossThreadSummaries } from "../cross-thread-summaries";

const SITE_ID = "site-test";
const USER = "user-1";

function seedThread(db: Database, overrides: Partial<Thread> & { id: string }): void {
	const base: Thread = {
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
		model_hint: null,
		...overrides,
	};
	insertRow(db, "threads", base, SITE_ID);
}

function seedMessage(
	db: Database,
	overrides: Partial<Message> & { id: string; thread_id: string },
): void {
	const base: Message = {
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
		exit_code: null,
		metadata: null,
		...overrides,
	};
	insertRow(db, "messages", base, SITE_ID);
}

describe("listCrossThreadSummaries", () => {
	let db: Database;

	beforeEach(() => {
		db = new Database(":memory:");
		applySchema(db);
		applyMetricsSchema(db);
	});

	afterEach(() => {
		db.close();
	});

	it("returns sibling threads with summaries within the recency window", () => {
		const cutoff = "2026-07-01T00:00:00.000Z";

		seedThread(db, {
			id: "sibling-a",
			title: "Thread A",
			summary: "Summary A content",
			summary_through: "2026-07-02T00:00:00.000Z",
			last_message_at: "2026-07-02T12:00:00.000Z",
		});
		seedMessage(db, { id: "m-a", thread_id: "sibling-a" });

		seedThread(db, {
			id: "sibling-b",
			title: "Thread B",
			summary: "Summary B content",
			summary_through: "2026-07-01T06:00:00.000Z",
			last_message_at: "2026-07-01T08:00:00.000Z",
		});
		seedMessage(db, { id: "m-b", thread_id: "sibling-b" });

		const rows = listCrossThreadSummaries(db, USER, "current-thread", cutoff);

		expect(rows).toHaveLength(2);
		expect(rows[0]).toEqual({
			id: "sibling-a",
			title: "Thread A",
			summary: "Summary A content",
			summary_through: "2026-07-02T00:00:00.000Z",
			last_message_at: "2026-07-02T12:00:00.000Z",
		});
		// Ordered by last_message_at DESC — sibling-a is more recent
		expect(rows[0].id).toBe("sibling-a");
		expect(rows[1].id).toBe("sibling-b");
	});

	it("excludes the current thread", () => {
		const cutoff = "2026-07-01T00:00:00.000Z";

		seedThread(db, {
			id: "current-thread",
			title: "Current",
			summary: "Should not appear",
			summary_through: "2026-07-02T00:00:00.000Z",
			last_message_at: "2026-07-02T12:00:00.000Z",
		});
		seedMessage(db, { id: "m-c", thread_id: "current-thread" });

		seedThread(db, {
			id: "sibling-a",
			title: "Thread A",
			summary: "Summary A",
			summary_through: "2026-07-02T00:00:00.000Z",
			last_message_at: "2026-07-01T12:00:00.000Z",
		});
		seedMessage(db, { id: "m-a", thread_id: "sibling-a" });

		const rows = listCrossThreadSummaries(db, USER, "current-thread", cutoff);

		expect(rows).toHaveLength(1);
		expect(rows[0].id).toBe("sibling-a");
	});

	it("excludes threads whose summary_through is older than the cutoff", () => {
		const cutoff = "2026-07-01T00:00:00.000Z";

		seedThread(db, {
			id: "recent",
			title: "Recent",
			summary: "Recent summary",
			summary_through: "2026-07-01T12:00:00.000Z",
			last_message_at: "2026-07-01T18:00:00.000Z",
		});
		seedMessage(db, { id: "m-r", thread_id: "recent" });

		seedThread(db, {
			id: "stale",
			title: "Stale",
			summary: "Stale summary",
			summary_through: "2026-06-15T00:00:00.000Z",
			last_message_at: "2026-06-15T12:00:00.000Z",
		});
		seedMessage(db, { id: "m-s", thread_id: "stale" });

		const rows = listCrossThreadSummaries(db, USER, "current-thread", cutoff);

		expect(rows).toHaveLength(1);
		expect(rows[0].id).toBe("recent");
	});

	it("excludes threads with null summaries", () => {
		const cutoff = "2026-07-01T00:00:00.000Z";

		seedThread(db, {
			id: "no-summary",
			title: "No Summary",
			summary: null,
			summary_through: "2026-07-02T00:00:00.000Z",
			last_message_at: "2026-07-02T12:00:00.000Z",
		});
		seedMessage(db, { id: "m-n", thread_id: "no-summary" });

		seedThread(db, {
			id: "has-summary",
			title: "Has Summary",
			summary: "Real summary",
			summary_through: "2026-07-02T00:00:00.000Z",
			last_message_at: "2026-07-01T12:00:00.000Z",
		});
		seedMessage(db, { id: "m-h", thread_id: "has-summary" });

		const rows = listCrossThreadSummaries(db, USER, "current-thread", cutoff);

		expect(rows).toHaveLength(1);
		expect(rows[0].id).toBe("has-summary");
	});

	it("excludes deleted threads", () => {
		const cutoff = "2026-07-01T00:00:00.000Z";

		seedThread(db, {
			id: "alive",
			title: "Alive",
			summary: "Alive summary",
			summary_through: "2026-07-02T00:00:00.000Z",
			last_message_at: "2026-07-02T12:00:00.000Z",
		});
		seedMessage(db, { id: "m-al", thread_id: "alive" });

		seedThread(db, {
			id: "dead",
			title: "Dead",
			summary: "Dead summary",
			summary_through: "2026-07-02T00:00:00.000Z",
			last_message_at: "2026-07-02T18:00:00.000Z",
		});
		seedMessage(db, { id: "m-de", thread_id: "dead" });
		softDelete(db, "threads", "dead", SITE_ID);

		const rows = listCrossThreadSummaries(db, USER, "current-thread", cutoff);

		expect(rows).toHaveLength(1);
		expect(rows[0].id).toBe("alive");
	});

	it("caps at 5 most-recent results", () => {
		const cutoff = "2026-06-01T00:00:00.000Z";

		for (let i = 0; i < 7; i++) {
			seedThread(db, {
				id: `sibling-${i}`,
				title: `Thread ${i}`,
				summary: `Summary ${i}`,
				summary_through: `2026-07-${10 + i}T00:00:00.000Z`,
				last_message_at: `2026-07-${10 + i}T12:00:00.000Z`,
			});
			seedMessage(db, { id: `m-${i}`, thread_id: `sibling-${i}` });
		}

		const rows = listCrossThreadSummaries(db, USER, "current-thread", cutoff);

		expect(rows).toHaveLength(5);
		// Most recent first (highest date = most recent)
		expect(rows[0].id).toBe("sibling-6");
		expect(rows[4].id).toBe("sibling-2");
	});

	it("projects only the declared column set", () => {
		const cutoff = "2026-07-01T00:00:00.000Z";

		seedThread(db, {
			id: "sibling-a",
			title: "Thread A",
			color: 3,
			summary: "Summary A",
			summary_through: "2026-07-02T00:00:00.000Z",
			last_message_at: "2026-07-02T12:00:00.000Z",
		});
		seedMessage(db, { id: "m-a", thread_id: "sibling-a" });

		const rows = listCrossThreadSummaries(db, USER, "current-thread", cutoff);

		expect(rows).toHaveLength(1);
		expect(Object.keys(rows[0]).sort()).toEqual(
			["id", "last_message_at", "summary", "summary_through", "title"].sort(),
		);
	});

	it("returns empty array when no siblings have summaries", () => {
		seedThread(db, {
			id: "no-summary",
			title: "No Summary",
			summary: null,
			last_message_at: "2026-07-02T12:00:00.000Z",
		});
		seedMessage(db, { id: "m-n", thread_id: "no-summary" });

		const rows = listCrossThreadSummaries(db, USER, "current-thread", "2026-07-01T00:00:00.000Z");

		expect(rows).toEqual([]);
	});
});
