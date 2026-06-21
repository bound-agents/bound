import type { Database } from "bun:sqlite";
import { beforeEach, describe, expect, it } from "bun:test";
import { applyMetricsSchema, applySchema, createDatabase } from "@bound/core";
import type { Hono } from "hono";
import { createThreadsRoutes } from "../routes/threads";

type ListedThread = {
	id: string;
	title: string | null;
	last_message_at: string;
	messageCount: number;
	active: boolean;
	attachedSessionHosts: string[];
};

describe("GET /api/threads cursor-based pagination", () => {
	let db: Database;
	let app: Hono;
	const operatorId = "test-operator";

	function insertThread(id: string, lastMessageAt: string, title = id): void {
		db.prepare(
			"INSERT INTO threads (id, user_id, interface, host_origin, color, title, created_at, last_message_at, modified_at, deleted) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0)",
		).run(
			id,
			operatorId,
			"web",
			"localhost:3000",
			0,
			title,
			lastMessageAt,
			lastMessageAt,
			lastMessageAt,
		);
		// Give every thread a user message so they aren't filtered out by the
		// empty-thread predicate (which is orthogonal to pagination).
		db.prepare(
			"INSERT INTO messages (id, thread_id, role, content, created_at, modified_at, host_origin, deleted) VALUES (?, ?, ?, ?, ?, ?, ?, 0)",
		).run(`${id}-user-msg`, id, "user", "x", lastMessageAt, lastMessageAt, "localhost:3000");
	}

	beforeEach(() => {
		db = createDatabase(":memory:");
		applySchema(db);
		applyMetricsSchema(db);
		app = createThreadsRoutes(db, operatorId);
	});

	async function fetchPage(query: string): Promise<ListedThread[]> {
		const res = await app.fetch(new Request(`http://localhost/${query}`));
		expect(res.status).toBe(200);
		return (await res.json()) as ListedThread[];
	}

	async function fetchTotalCount(query: string): Promise<number> {
		const res = await app.fetch(new Request(`http://localhost/${query}`));
		expect(res.status).toBe(200);
		const header = res.headers.get("X-Total-Count");
		expect(header).not.toBeNull();
		return Number.parseInt(header as string, 10);
	}

	function attachSession(threadId: string, siteId: string, hostName?: string): void {
		const now = "2026-05-20T00:30:00Z";
		if (hostName) {
			db.prepare(
				"INSERT INTO hosts (site_id, host_name, online_at, modified_at, deleted) VALUES (?, ?, ?, ?, 0)",
			).run(siteId, hostName, now, now);
		}
		db.prepare(
			"INSERT INTO client_sessions (id, connection_id, thread_id, site_id, created_at, modified_at, deleted) VALUES (?, ?, ?, ?, ?, ?, 0)",
		).run(`${siteId}::${threadId}`, `conn-${siteId}`, threadId, siteId, now, now);
	}

	it("respects ?limit=N and returns the most-recent N", async () => {
		// Insert 10 threads with strictly-decreasing timestamps; t-1 newest, t-10 oldest.
		for (let i = 1; i <= 10; i++) {
			const ts = `2026-05-20T00:0${i < 10 ? `0:0${i}` : "0:10"}Z`;
			insertThread(`t-${i}`, ts);
		}
		const page = await fetchPage("?limit=3");
		expect(page).toHaveLength(3);
		// Most recent first — t-10 has the latest timestamp.
		expect(page.map((t) => t.id)).toEqual(["t-10", "t-9", "t-8"]);
	});

	it("returns next page via before_ts + before_id cursor", async () => {
		for (let i = 1; i <= 10; i++) {
			const ts = `2026-05-20T00:0${i < 10 ? `0:0${i}` : "0:10"}Z`;
			insertThread(`t-${i}`, ts);
		}
		const page1 = await fetchPage("?limit=4");
		expect(page1.map((t) => t.id)).toEqual(["t-10", "t-9", "t-8", "t-7"]);

		const last = page1[page1.length - 1];
		const cursor = `before_ts=${encodeURIComponent(last.last_message_at)}&before_id=${last.id}`;
		const page2 = await fetchPage(`?limit=4&${cursor}`);
		expect(page2.map((t) => t.id)).toEqual(["t-6", "t-5", "t-4", "t-3"]);

		const last2 = page2[page2.length - 1];
		const cursor2 = `before_ts=${encodeURIComponent(last2.last_message_at)}&before_id=${last2.id}`;
		const page3 = await fetchPage(`?limit=4&${cursor2}`);
		expect(page3.map((t) => t.id)).toEqual(["t-2", "t-1"]);

		// Cursor past the end returns empty.
		const last3 = page3[page3.length - 1];
		const cursor3 = `before_ts=${encodeURIComponent(last3.last_message_at)}&before_id=${last3.id}`;
		const page4 = await fetchPage(`?limit=4&${cursor3}`);
		expect(page4).toEqual([]);
	});

	it("breaks ties on identical last_message_at using id (DESC)", async () => {
		// Three threads share the exact same timestamp — id ordering must be
		// deterministic and the cursor must walk through them all.
		const ts = "2026-05-20T00:00:00Z";
		insertThread("t-aaa", ts);
		insertThread("t-bbb", ts);
		insertThread("t-ccc", ts);

		const page1 = await fetchPage("?limit=2");
		// id DESC means t-ccc, then t-bbb, then t-aaa.
		expect(page1.map((t) => t.id)).toEqual(["t-ccc", "t-bbb"]);

		const last = page1[page1.length - 1];
		const cursor = `before_ts=${encodeURIComponent(last.last_message_at)}&before_id=${last.id}`;
		const page2 = await fetchPage(`?limit=2&${cursor}`);
		expect(page2.map((t) => t.id)).toEqual(["t-aaa"]);
	});

	it("composes with include_empty=true so paged empty-only threads are visible", async () => {
		// Two threads with user messages, two with system-only messages.
		insertThread("t-with-user-1", "2026-05-20T00:00:01Z");
		insertThread("t-with-user-2", "2026-05-20T00:00:02Z");

		// System-only threads — bypass the user-msg insert in insertThread.
		const systemOnly = (id: string, ts: string) => {
			db.prepare(
				"INSERT INTO threads (id, user_id, interface, host_origin, color, title, created_at, last_message_at, modified_at, deleted) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0)",
			).run(id, operatorId, "web", "localhost:3000", 0, id, ts, ts, ts);
			db.prepare(
				"INSERT INTO messages (id, thread_id, role, content, created_at, modified_at, host_origin, deleted) VALUES (?, ?, ?, ?, ?, ?, ?, 0)",
			).run(`${id}-system`, id, "system", "x", ts, ts, "localhost:3000");
		};
		systemOnly("t-empty-1", "2026-05-20T00:00:03Z");
		systemOnly("t-empty-2", "2026-05-20T00:00:04Z");

		// Without include_empty: only the two user threads come back.
		const noEmpty = await fetchPage("?limit=10");
		expect(noEmpty.map((t) => t.id).sort()).toEqual(["t-with-user-1", "t-with-user-2"].sort());

		// With include_empty: all four, paginated.
		const page1 = await fetchPage("?include_empty=true&limit=2");
		expect(page1.map((t) => t.id)).toEqual(["t-empty-2", "t-empty-1"]);
		const last = page1[page1.length - 1];
		const cursor = `before_ts=${encodeURIComponent(last.last_message_at)}&before_id=${last.id}`;
		const page2 = await fetchPage(`?include_empty=true&limit=2&${cursor}`);
		expect(page2.map((t) => t.id)).toEqual(["t-with-user-2", "t-with-user-1"]);
	});

	it("returns full set when no limit is given (back-compat)", async () => {
		for (let i = 1; i <= 5; i++) {
			insertThread(`t-${i}`, `2026-05-20T00:00:0${i}Z`);
		}
		const all = await fetchPage("");
		expect(all).toHaveLength(5);
	});

	it("ignores partial cursor (only one of before_ts / before_id) gracefully", async () => {
		for (let i = 1; i <= 3; i++) {
			insertThread(`t-${i}`, `2026-05-20T00:00:0${i}Z`);
		}
		// Just before_ts, no id — cursor is incomplete, treat as no cursor.
		const onlyTs = await fetchPage("?before_ts=2026-05-20T00:00:02Z");
		expect(onlyTs).toHaveLength(3);

		// Just before_id, no timestamp — same.
		const onlyId = await fetchPage("?before_id=t-2");
		expect(onlyId).toHaveLength(3);
	});

	it("rejects nonsensical limit values", async () => {
		insertThread("t-1", "2026-05-20T00:00:01Z");
		const negative = await app.fetch(new Request("http://localhost/?limit=-1"));
		expect(negative.status).toBe(400);
		const zero = await app.fetch(new Request("http://localhost/?limit=0"));
		expect(zero.status).toBe(400);
		const huge = await app.fetch(new Request("http://localhost/?limit=99999"));
		expect(huge.status).toBe(400);
		const garbage = await app.fetch(new Request("http://localhost/?limit=abc"));
		expect(garbage.status).toBe(400);
	});

	describe("X-Total-Count header", () => {
		it("reports the full matching total on an unpaginated request", async () => {
			for (let i = 1; i <= 7; i++) {
				insertThread(`t-${i}`, `2026-05-20T00:00:0${i}Z`);
			}
			const all = await fetchPage("");
			expect(all).toHaveLength(7);
			expect(await fetchTotalCount("")).toBe(7);
		});

		it("reports the full total even when a page is limited", async () => {
			for (let i = 1; i <= 10; i++) {
				const ts = `2026-05-20T00:0${i < 10 ? `0:0${i}` : "0:10"}Z`;
				insertThread(`t-${i}`, ts);
			}
			// Only 3 rows come back, but the count is the full set.
			const page = await fetchPage("?limit=3");
			expect(page).toHaveLength(3);
			expect(await fetchTotalCount("?limit=3")).toBe(10);
		});

		it("reports the full total on a cursor page, not the page length", async () => {
			for (let i = 1; i <= 10; i++) {
				const ts = `2026-05-20T00:0${i < 10 ? `0:0${i}` : "0:10"}Z`;
				insertThread(`t-${i}`, ts);
			}
			const page1 = await fetchPage("?limit=4");
			const last = page1[page1.length - 1];
			const cursor = `before_ts=${encodeURIComponent(last.last_message_at)}&before_id=${last.id}`;
			// Second page returns 4 rows but the header still reflects all 10.
			expect(await fetchTotalCount(`?limit=4&${cursor}`)).toBe(10);
		});

		it("reflects the include_empty filter", async () => {
			insertThread("t-with-user-1", "2026-05-20T00:00:01Z");
			insertThread("t-with-user-2", "2026-05-20T00:00:02Z");
			const systemOnly = (id: string, ts: string) => {
				db.prepare(
					"INSERT INTO threads (id, user_id, interface, host_origin, color, title, created_at, last_message_at, modified_at, deleted) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0)",
				).run(id, operatorId, "web", "localhost:3000", 0, id, ts, ts, ts);
				db.prepare(
					"INSERT INTO messages (id, thread_id, role, content, created_at, modified_at, host_origin, deleted) VALUES (?, ?, ?, ?, ?, ?, ?, 0)",
				).run(`${id}-system`, id, "system", "x", ts, ts, "localhost:3000");
			};
			systemOnly("t-empty-1", "2026-05-20T00:00:03Z");
			systemOnly("t-empty-2", "2026-05-20T00:00:04Z");

			// Default filter hides empty threads → 2.
			expect(await fetchTotalCount("")).toBe(2);
			// include_empty surfaces all 4.
			expect(await fetchTotalCount("?include_empty=true")).toBe(4);
		});
	});

	it("includes active attached-session host labels", async () => {
		insertThread("t-attached", "2026-05-20T00:00:01Z");
		insertThread("t-plain", "2026-05-20T00:00:02Z");
		attachSession("t-attached", "site-beta", "Beta Host");
		attachSession("t-attached", "site-alpha", "Alpha Host");
		attachSession("t-attached", "site-unknown");

		const threads = await fetchPage("?limit=10");
		const attached = threads.find((t) => t.id === "t-attached");
		const plain = threads.find((t) => t.id === "t-plain");

		expect(attached?.attachedSessionHosts).toEqual(["Alpha Host", "Beta Host", "site-unknown"]);
		expect(plain?.attachedSessionHosts).toEqual([]);
	});
});
