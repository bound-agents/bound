import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { randomBytes, randomUUID } from "node:crypto";
import { applySchema, type insertDurableWork, insertRow } from "@bound/core";
import type { TypedEventEmitter } from "@bound/shared";
import { RssPoller, fetchValidatedUrl, parseFeed } from "../rss-poller.js";

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

const resolvePublicHost = async (): Promise<readonly string[]> => ["93.184.216.34"];

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

	const pollerDeps = { resolveHost: resolvePublicHost };

	// After the release N+1 demolition, intake is unconditionally durable: RSS
	// items land as rss_intake durable_work rows. The former relay_inbox helper
	// now reads the durable store so the delivery-count assertions still hold.
	function inboxRows(): Array<{ ref_id: string; kind: string; payload: string }> {
		return db
			.query(
				"SELECT ref_id, kind, payload FROM durable_work WHERE kind = 'rss_intake' ORDER BY received_at ASC",
			)
			.all() as Array<{ ref_id: string; kind: string; payload: string }>;
	}

	function durableRows(): Array<{
		ref_id: string;
		kind: string;
		payload: string;
		idempotency_key: string;
		source_site: string;
		received_at: string;
		expires_at: string;
		claim_state: string;
	}> {
		return db
			.query(
				"SELECT ref_id, kind, payload, idempotency_key, source_site, received_at, expires_at, claim_state FROM durable_work ORDER BY received_at ASC",
			)
			.all() as ReturnType<typeof durableRows>;
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
			...pollerDeps,
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

	// Trace-context persistence on the intake row was retired at release N+1: the
	// durable_work intake row has no trace_context column, and rss-poller no longer
	// stamps a carrier onto the row. (The poll still opens an OTel span.)

	it("delivers only unseen items as rss_intake rows and emits connector:event", async () => {
		const feed = seedFeed({ seen_guids: JSON.stringify(["guid-1"]) });
		const poller = new RssPoller({
			...pollerDeps,
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
			...pollerDeps,
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
			...pollerDeps,
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

	it("refuses a private feed URL before fetching", async () => {
		seedFeed({ url: "http://169.254.169.254/latest/meta-data" });
		let fetches = 0;
		const poller = new RssPoller({
			...pollerDeps,
			db,
			siteId,
			eventBus,
			fetchImpl: (async () => {
				fetches++;
				return new Response(RSS_DOC);
			}) as unknown as typeof fetch,
		});

		await poller.tick();
		expect(fetches).toBe(0);
		expect(inboxRows()).toEqual([]);
	});

	it("refuses a redirect to a private address", async () => {
		seedFeed({ seen_guids: JSON.stringify([]) });
		let fetches = 0;
		const poller = new RssPoller({
			...pollerDeps,
			db,
			siteId,
			eventBus,
			fetchImpl: (async () => {
				fetches++;
				return new Response(null, {
					status: 302,
					headers: { location: "http://127.0.0.1/internal" },
				});
			}) as unknown as typeof fetch,
		});

		await poller.tick();
		expect(fetches).toBe(1);
		expect(inboxRows()).toEqual([]);
	});

	it("pins a resolved public address so DNS rebinding cannot change the connection target", async () => {
		seedFeed({ seen_guids: JSON.stringify([]), url: "https://rebind.example/feed.xml" });
		const connectedAddresses: string[] = [];
		let resolutions = 0;
		const poller = new RssPoller({
			db,
			siteId,
			eventBus,
			resolveHost: async () => {
				resolutions++;
				return [resolutions === 1 ? "93.184.216.34" : "127.0.0.1"];
			},
			fetchValidatedUrl: async (_url, address) => {
				connectedAddresses.push(address);
				return new Response(RSS_DOC);
			},
		});

		await poller.tick();
		expect(resolutions).toBe(1);
		expect(connectedAddresses).toEqual(["93.184.216.34"]);
	});

	it("refuses an oversized response body in the pinned Node transport", async () => {
		let clientDisconnected = false;
		const server = Bun.serve({
			port: 0,
			fetch() {
				return new Response(
					new ReadableStream({
						start(controller) {
							controller.enqueue(new Uint8Array(5 * 1024 * 1024 + 1));
						},
						cancel() {
							clientDisconnected = true;
						},
					}),
				);
			},
		});
		try {
			await expect(
				fetchValidatedUrl(new URL(`http://127.0.0.1:${server.port}/feed.xml`), "127.0.0.1", {}),
			).rejects.toThrow("RSS feed body exceeds size limit");
			await new Promise((resolve) => setTimeout(resolve, 0));
			expect(clientDisconnected).toBe(true);
		} finally {
			server.stop(true);
		}
	});

	it("does not start a redirect hop after the shared deadline expires", async () => {
		seedFeed({ seen_guids: JSON.stringify([]) });
		const controller = new AbortController();
		let fetches = 0;
		const poller = new RssPoller({
			...pollerDeps,
			db,
			siteId,
			eventBus,
			createFetchDeadline: () => controller.signal,
			fetchImpl: (async () => {
				fetches++;
				controller.abort(new Error("test deadline elapsed"));
				return new Response(null, {
					status: 302,
					headers: { location: "https://example.com/redirected.xml" },
				});
			}) as unknown as typeof fetch,
		});

		await poller.tick();
		expect(fetches).toBe(1);
		expect(inboxRows()).toEqual([]);
	});

	it("survives a failing fetch without delivering or crashing", async () => {
		seedFeed({ seen_guids: JSON.stringify([]) });
		const poller = new RssPoller({
			...pollerDeps,
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

	it("retries a failed fetch after FAILURE_RETRY_MS instead of a full cadence", async () => {
		// 4h cadence feed — the production case where one transient failure
		// used to cost the entire interval.
		seedFeed({ seen_guids: JSON.stringify(["guid-1"]), poll_interval_seconds: 14400 });
		let fetches = 0;
		let failFirst = true;
		const flakyFetch = (async () => {
			fetches++;
			if (failFirst) {
				failFirst = false;
				throw new Error("connection refused");
			}
			return new Response(RSS_DOC, { status: 200 });
		}) as unknown as typeof fetch;

		let t = 1_000_000_000_000;
		const poller = new RssPoller({
			...pollerDeps,
			db,
			siteId,
			eventBus,
			fetchImpl: flakyFetch,
			now: () => t,
		});

		await poller.tick();
		expect(fetches).toBe(1); // failed

		// 4 minutes later — still inside the 5-minute retry window, no fetch.
		t += 4 * 60_000;
		await poller.tick();
		expect(fetches).toBe(1);

		// 5+ minutes after the failure — eligible again, long before the 4h cadence.
		t += 90_000;
		await poller.tick();
		expect(fetches).toBe(2);
		expect(inboxRows().length).toBe(1); // the retry delivered
	});

	it("warns and retries soon when an unseeded feed's body parses to zero items", async () => {
		const feed = seedFeed({ poll_interval_seconds: 14400 }); // seen_guids null
		const warns: string[] = [];
		let serveHtml = true;
		const flakyBody = (async () => {
			if (serveHtml) {
				serveHtml = false;
				return new Response("<html><body>challenge page</body></html>", { status: 200 });
			}
			return new Response(RSS_DOC, { status: 200 });
		}) as unknown as typeof fetch;

		let t = 1_000_000_000_000;
		const poller = new RssPoller({
			...pollerDeps,
			db,
			siteId,
			eventBus,
			fetchImpl: flakyBody,
			now: () => t,
			logger: {
				info: () => {},
				warn: (msg) => warns.push(msg),
			},
		});

		await poller.tick();
		expect(warns.some((w) => w.includes("parsed to zero items"))).toBe(true);
		// Cursor untouched — the HTML poll must not count as the seeding poll.
		let row = db.query("SELECT seen_guids FROM rss_feeds WHERE id = ?").get(feed.id) as {
			seen_guids: string | null;
		};
		expect(row.seen_guids).toBeNull();

		// 5+ minutes later the retry fires (not 4h) and seeds the cursor.
		t += 5 * 60_000 + 30_000;
		await poller.tick();
		row = db.query("SELECT seen_guids FROM rss_feeds WHERE id = ?").get(feed.id) as {
			seen_guids: string | null;
		};
		expect(row.seen_guids).not.toBeNull();
		expect(inboxRows().length).toBe(0); // seeding still delivers nothing
	});

	it("preserves accepted deliveries when a later cursor write throws", async () => {
		seedFeed({ seen_guids: JSON.stringify([]) });
		const originalRun = db.run.bind(db);
		let intakeInserts = 0;
		(db as unknown as { run: typeof db.run }).run = ((sql: string, ...args: unknown[]) => {
			if (sql.includes("durable_work")) intakeInserts++;
			if (sql.includes("UPDATE rss_feeds")) throw new Error("cursor write failed");
			return originalRun(
				sql,
				...(args as Parameters<typeof db.run> extends [unknown, ...infer R] ? R : never),
			);
		}) as typeof db.run;

		const poller = new RssPoller({
			...pollerDeps,
			db,
			siteId,
			eventBus,
			fetchImpl: fetchReturning(RSS_DOC),
		});
		await expect(poller.tick()).rejects.toThrow("cursor write failed");
		expect(intakeInserts).toBe(2);
		// Intake and synced cursor are one transaction: an interrupted cursor
		// write cannot consume GUIDs while leaving durable rows behind.
		expect(inboxRows()).toEqual([]);
		const row = db.query("SELECT seen_guids FROM rss_feeds").get() as { seen_guids: string };
		expect(JSON.parse(row.seen_guids)).toEqual([]);
	});

	it("dedupes repeated guids within a single document", async () => {
		// Bluesky-style: a repost re-lists the original post's URI in the same doc.
		const doc = `<rss><channel>
			<item><title>repost</title><guid>guid-dup</guid></item>
			<item><title>original</title><guid>guid-dup</guid></item>
			<item><title>other</title><guid>guid-other</guid></item>
		</channel></rss>`;
		const feed = seedFeed({ seen_guids: JSON.stringify([]) });
		const poller = new RssPoller({
			...pollerDeps,
			db,
			siteId,
			eventBus,
			fetchImpl: fetchReturning(doc),
		});

		await poller.tick();

		// One intake row per DISTINCT guid, and the cursor stores each once.
		expect(inboxRows().length).toBe(2);
		const row = db.query("SELECT seen_guids FROM rss_feeds WHERE id = ?").get(feed.id) as {
			seen_guids: string;
		};
		const cursor = JSON.parse(row.seen_guids) as string[];
		expect(cursor.filter((g) => g === "guid-dup").length).toBe(1);
		expect(cursor.length).toBe(2);
	});

	describe("durable intake", () => {
		it("writes rss_intake durable_work rows keyed rss-<name>-<guid> and no relay twin", async () => {
			const feed = seedFeed({ seen_guids: JSON.stringify(["guid-1"]) });
			const poller = new RssPoller({
				...pollerDeps,
				db,
				siteId,
				eventBus,
				fetchImpl: fetchReturning(RSS_DOC),
			});

			await poller.tick();

			const rows = durableRows();
			expect(rows.length).toBe(1);
			expect(rows[0].kind).toBe("rss_intake");
			expect(rows[0].idempotency_key).toBe("rss-test-feed-https://example.com/2");
			expect(rows[0].ref_id).toBe(feed.thread_id);
			expect(rows[0].source_site).toBe(siteId);
			expect(rows[0].received_at).toEqual(expect.any(String));
			expect(rows[0].claim_state).toBe("pending");
			expect(Date.parse(rows[0].expires_at) - Date.parse(rows[0].received_at)).toBeGreaterThan(
				6 * 24 * 60 * 60 * 1000,
			);
			const payload = JSON.parse(rows[0].payload) as Record<string, unknown>;
			expect(payload.feed).toBe("test-feed");
			expect(payload.guid).toBe("https://example.com/2");

			// Second poll with the same document: guid skip preserved, no new rows.
			await poller.tick();
			expect(durableRows().length).toBe(1);
		});

		it("preserves distinct GUIDs that differ after a 512-character common prefix", async () => {
			const sharedGuidPrefix = "a".repeat(513);
			const firstGuid = `${sharedGuidPrefix}-first`;
			const secondGuid = `${sharedGuidPrefix}-second`;
			const doc = `<rss><channel>
			<item><title>first</title><guid>${firstGuid}</guid></item>
			<item><title>second</title><guid>${secondGuid}</guid></item>
		</channel></rss>`;
			const feed = seedFeed({ seen_guids: JSON.stringify([]) });
			const poller = new RssPoller({
				...pollerDeps,
				db,
				siteId,
				eventBus,
				fetchImpl: fetchReturning(doc),
			});

			await poller.tick();

			const rows = durableRows();
			expect(rows).toHaveLength(2);
			expect(rows.map((row) => row.idempotency_key)).toEqual(
				expect.arrayContaining([`rss-test-feed-${firstGuid}`, `rss-test-feed-${secondGuid}`]),
			);
			const row = db.query("SELECT seen_guids FROM rss_feeds WHERE id = ?").get(feed.id) as {
				seen_guids: string;
			};
			expect(JSON.parse(row.seen_guids)).toEqual(expect.arrayContaining([firstGuid, secondGuid]));
		});

		it("a durable insert failure leaves seen_guids unadvanced", async () => {
			const feed = seedFeed({ seen_guids: JSON.stringify([]) });
			let durableAttempts = 0;
			const poller = new RssPoller({
				...pollerDeps,
				db,
				siteId,
				eventBus,
				fetchImpl: fetchReturning(RSS_DOC),
				// Force the durable intake write to throw, mirroring the legacy
				// #219 rollback test. The intake write and the seen_guids cursor
				// advance share one transaction, so a failed intake must not
				// consume GUIDs.
				insertDurableWork: (() => {
					durableAttempts++;
					throw new Error("durable intake write failed");
				}) as typeof insertDurableWork,
			});

			await expect(poller.tick()).rejects.toThrow("durable intake write failed");
			expect(durableAttempts).toBeGreaterThan(0);
			// No durable rows and the cursor stayed empty.
			expect(durableRows()).toEqual([]);
			const row = db.query("SELECT seen_guids FROM rss_feeds WHERE id = ?").get(feed.id) as {
				seen_guids: string;
			};
			expect(JSON.parse(row.seen_guids)).toEqual([]);
		});

		it("fires durable_work:written ONLY after the poll transaction commits", async () => {
			// Invariant #6: insertDurableWork suppresses its emit while db.inTransaction
			// is true; the poller flushes the event post-commit via emitDurableWorkWritten.
			// A listener observing the event must therefore see the transaction closed AND
			// the row already visible via SELECT. emitDurableWorkWritten drives the
			// module-level durable-work bus (setDurableWorkEventBus), so observe there —
			// the poller's pollerDeps.eventBus (connector:event sink) is a separate stub.
			const { setDurableWorkEventBus } = await import("@bound/core");
			seedFeed({ seen_guids: JSON.stringify(["guid-1"]) });
			const observations: Array<{ inTransaction: boolean; visible: boolean }> = [];
			const durableBus = {
				emit: (_event: string, e: { id: string; target_site_id: string }) => {
					const row = db.query("SELECT id FROM durable_work WHERE id = ?").get(e.id);
					observations.push({ inTransaction: db.inTransaction, visible: row !== null });
				},
			} as unknown as TypedEventEmitter;
			setDurableWorkEventBus(durableBus);
			try {
				const poller = new RssPoller({
					...pollerDeps,
					db,
					siteId,
					eventBus,
					fetchImpl: fetchReturning(RSS_DOC),
				});
				await poller.tick();
			} finally {
				setDurableWorkEventBus(null);
			}

			// Exactly one durable row inserted this poll → exactly one post-commit event,
			// fired with the transaction closed and the row already durable.
			expect(observations).toHaveLength(1);
			expect(observations[0]).toEqual({ inTransaction: false, visible: true });
		});

		it("fires NO durable_work:written when the poll transaction rolls back", async () => {
			const { setDurableWorkEventBus } = await import("@bound/core");
			seedFeed({ seen_guids: JSON.stringify([]) });
			const events: unknown[] = [];
			const durableBus = {
				emit: (_event: string, e: unknown) => events.push(e),
			} as unknown as TypedEventEmitter;
			setDurableWorkEventBus(durableBus);
			try {
				const poller = new RssPoller({
					...pollerDeps,
					db,
					siteId,
					eventBus,
					fetchImpl: fetchReturning(RSS_DOC),
					// Throw inside the transaction so the enclosing wrapper rolls back.
					insertDurableWork: (() => {
						throw new Error("durable intake write failed");
					}) as typeof insertDurableWork,
				});
				await expect(poller.tick()).rejects.toThrow("durable intake write failed");
			} finally {
				setDurableWorkEventBus(null);
			}

			// The insert never became durable (it threw), so no id was collected and
			// the post-commit flush has nothing to emit.
			expect(events).toEqual([]);
			expect(durableRows()).toEqual([]);
		});
	});
});
