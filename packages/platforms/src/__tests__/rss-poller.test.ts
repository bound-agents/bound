import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { randomBytes, randomUUID } from "node:crypto";
import { applySchema, insertRow } from "@bound/core";
import type { TypedEventEmitter } from "@bound/shared";
import { RssPoller, parseFeed } from "../rss-poller.js";

const RSS_DOC = `<?xml version="1.0"?>
<rss version="2.0">
	<channel>
		<title>Test Feed</title>
		<item>
			<title>Second post</title>
			<link>https://example.com/2</link>
			<guid>https://example.com/2</guid>
			<pubDate>Tue, 14 Jul 2026 12:00:00 GMT</pubDate>
			<description><![CDATA[Body of <b>second</b> post]]></description>
		</item>
		<item>
			<title>First post &amp; friends</title>
			<link>https://example.com/1</link>
			<guid>guid-1</guid>
			<pubDate>Mon, 13 Jul 2026 12:00:00 GMT</pubDate>
			<description>Body of first post</description>
		</item>
	</channel>
</rss>`;

const ATOM_DOC = `<?xml version="1.0"?>
<feed xmlns="http://www.w3.org/2005/Atom">
	<title>Atom Feed</title>
	<entry>
		<title>Atom entry</title>
		<id>urn:uuid:entry-1</id>
		<link rel="alternate" href="https://example.com/atom/1"/>
		<published>2026-07-14T10:00:00Z</published>
		<summary>Atom summary</summary>
	</entry>
</feed>`;

describe("parseFeed", () => {
	it("parses RSS 2.0 items with guid, CDATA, entities, and tag stripping", () => {
		const items = parseFeed(RSS_DOC);
		expect(items.length).toBe(2);
		expect(items[0].guid).toBe("https://example.com/2");
		expect(items[0].title).toBe("Second post");
		expect(items[0].summary).toBe("Body of second post");
		expect(items[1].guid).toBe("guid-1");
		expect(items[1].title).toBe("First post & friends");
		expect(items[1].published).toBe("Mon, 13 Jul 2026 12:00:00 GMT");
	});

	it("parses Atom entries with id and alternate link", () => {
		const items = parseFeed(ATOM_DOC);
		expect(items.length).toBe(1);
		expect(items[0].guid).toBe("urn:uuid:entry-1");
		expect(items[0].link).toBe("https://example.com/atom/1");
		expect(items[0].published).toBe("2026-07-14T10:00:00Z");
		expect(items[0].summary).toBe("Atom summary");
	});

	it("falls back to link as guid when RSS guid is absent", () => {
		const doc =
			"<rss><channel><item><title>t</title><link>https://x/1</link></item></channel></rss>";
		const items = parseFeed(doc);
		expect(items.length).toBe(1);
		expect(items[0].guid).toBe("https://x/1");
	});

	it("returns [] for non-feed input", () => {
		expect(parseFeed("not xml at all")).toEqual([]);
		expect(parseFeed("<html><body>hi</body></html>")).toEqual([]);
	});
});

describe("RssPoller", () => {
	let db: Database;
	let siteId: string;
	let emitted: Array<Record<string, unknown>>;
	let eventBus: TypedEventEmitter;

	function seedFeed(overrides: Record<string, unknown> = {}): {
		id: string;
		thread_id: string;
		task_id: string;
	} {
		const now = new Date().toISOString();
		const id = randomUUID();
		const threadId = randomUUID();
		const taskId = randomUUID();
		insertRow(
			db,
			"rss_feeds",
			{
				id,
				name: "test-feed",
				url: "https://example.com/feed.xml",
				description: null,
				poll_interval_seconds: 900,
				seen_guids: null,
				task_id: taskId,
				thread_id: threadId,
				created_at: now,
				deleted: 0,
				modified_at: now,
				...overrides,
			},
			siteId,
		);
		return { id, thread_id: threadId, task_id: taskId };
	}

	function fetchReturning(body: string, status = 200): typeof fetch {
		return (async () =>
			new Response(status === 304 ? null : body, { status })) as unknown as typeof fetch;
	}

	function inboxRows(): Array<{ ref_id: string; kind: string; payload: string }> {
		return db
			.query("SELECT ref_id, kind, payload FROM relay_inbox ORDER BY received_at ASC")
			.all() as Array<{ ref_id: string; kind: string; payload: string }>;
	}

	beforeEach(() => {
		db = new Database(":memory:");
		applySchema(db);
		siteId = `test-site-${randomBytes(4).toString("hex")}`;
		db.prepare("INSERT INTO host_meta (key, value) VALUES (?, ?)").run("site_id", siteId);
		emitted = [];
		eventBus = {
			emit: (event: string, payload: unknown) => {
				emitted.push({ event, payload } as Record<string, unknown>);
			},
		} as unknown as TypedEventEmitter;
	});

	afterEach(() => {
		db.close();
	});

	it("first poll seeds the cursor without delivering the backlog", async () => {
		const feed = seedFeed();
		const poller = new RssPoller({
			db,
			siteId,
			eventBus,
			fetchImpl: fetchReturning(RSS_DOC),
		});

		await poller.tick();

		expect(inboxRows().length).toBe(0);
		expect(emitted.length).toBe(0);

		const row = db.query("SELECT seen_guids FROM rss_feeds WHERE id = ?").get(feed.id) as {
			seen_guids: string;
		};
		const seen = JSON.parse(row.seen_guids) as string[];
		expect(seen).toContain("https://example.com/2");
		expect(seen).toContain("guid-1");
	});

	it("delivers only unseen items as rss_intake rows and emits connector:event", async () => {
		const feed = seedFeed({ seen_guids: JSON.stringify(["guid-1"]) });
		const poller = new RssPoller({
			db,
			siteId,
			eventBus,
			fetchImpl: fetchReturning(RSS_DOC),
		});

		await poller.tick();

		const rows = inboxRows();
		expect(rows.length).toBe(1);
		expect(rows[0].kind).toBe("rss_intake");
		expect(rows[0].ref_id).toBe(feed.thread_id);
		const payload = JSON.parse(rows[0].payload) as Record<string, unknown>;
		expect(payload.feed).toBe("test-feed");
		expect(payload.guid).toBe("https://example.com/2");
		expect(payload.title).toBe("Second post");

		expect(emitted.length).toBe(1);
		const evt = emitted[0].payload as Record<string, unknown>;
		expect(emitted[0].event).toBe("connector:event");
		expect(evt.trigger_key).toBe("rss:test-feed");
		expect(evt.task_id).toBe(feed.task_id);
		expect(evt.batch_size).toBe(1);
	});

	it("re-polling the same document delivers nothing (cursor + idempotency)", async () => {
		seedFeed({ seen_guids: JSON.stringify([]) });
		const poller = new RssPoller({
			db,
			siteId,
			eventBus,
			fetchImpl: fetchReturning(RSS_DOC),
			// Force both ticks past the cadence gate.
			now: (() => {
				let t = 1_000_000_000_000;
				return () => {
					t += 3_600_000;
					return t;
				};
			})(),
		});

		await poller.tick();
		expect(inboxRows().length).toBe(2);

		await poller.tick();
		expect(inboxRows().length).toBe(2);
		expect(emitted.length).toBe(1);
	});

	it("respects per-feed cadence between ticks", async () => {
		seedFeed({ seen_guids: JSON.stringify([]) });
		let fetches = 0;
		const countingFetch = (async () => {
			fetches++;
			return new Response(RSS_DOC, { status: 200 });
		}) as unknown as typeof fetch;

		let t = 1_000_000_000_000;
		const poller = new RssPoller({
			db,
			siteId,
			eventBus,
			fetchImpl: countingFetch,
			now: () => t,
		});

		await poller.tick();
		expect(fetches).toBe(1);

		// 60s later — inside the 900s cadence, no fetch.
		t += 60_000;
		await poller.tick();
		expect(fetches).toBe(1);

		// 900s later — due again.
		t += 900_000;
		await poller.tick();
		expect(fetches).toBe(2);
	});

	it("survives a failing fetch without delivering or crashing", async () => {
		seedFeed({ seen_guids: JSON.stringify([]) });
		const poller = new RssPoller({
			db,
			siteId,
			eventBus,
			fetchImpl: (async () => {
				throw new Error("connection refused");
			}) as unknown as typeof fetch,
		});

		await poller.tick();
		expect(inboxRows().length).toBe(0);
		expect(emitted.length).toBe(0);
	});
});
