import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { randomBytes, randomUUID } from "node:crypto";
import { applySchema, insertRow } from "@bound/core";
import type { TypedEventEmitter } from "@bound/shared";
import { RssPoller, fetchValidatedUrl } from "../rss-poller.js";

const RSS_DOC = `<?xml version="1.0"?>
<rss version="2.0">
	<channel>
		<title>Transport Feed</title>
		<item>
			<title>Only post</title>
			<link>https://example.com/only</link>
			<guid>guid-only</guid>
			<pubDate>Tue, 14 Jul 2026 12:00:00 GMT</pubDate>
			<description>Body</description>
		</item>
	</channel>
</rss>`;

// The pinned Node HTTP(S) transport (fetchValidatedUrl) is the production
// default path. The rest of rss-poller.test.ts injects fetchImpl/fetchValidatedUrl
// seams; this file drives the REAL transport against a loopback Bun.serve so the
// node:http request/response plumbing (streaming, headers, size cap) runs.
describe("fetchValidatedUrl (pinned Node transport)", () => {
	let server: ReturnType<typeof Bun.serve> | null = null;

	afterEach(() => {
		server?.stop(true);
		server = null;
	});

	it("GETs through a loopback server, preserving status and headers", async () => {
		server = Bun.serve({
			port: 0,
			fetch(req) {
				// Host header must survive the pinned-address rewrite.
				expect(req.headers.get("host")).toContain("127.0.0.1");
				return new Response(RSS_DOC, {
					status: 200,
					headers: { etag: '"v1"', "content-type": "application/rss+xml" },
				});
			},
		});
		const url = new URL(`http://127.0.0.1:${server.port}/feed.xml`);
		const resp = await fetchValidatedUrl(url, "127.0.0.1", {
			headers: { "user-agent": "bound-rss-poller" },
		});
		expect(resp.status).toBe(200);
		expect(resp.headers.get("etag")).toBe('"v1"');
		expect(await resp.text()).toContain("Transport Feed");
	});

	it("connects a hostname URL through the pinned address, keeping the Host header (#300)", async () => {
		// An IP-literal URL bypasses the custom lookup entirely; only a hostname
		// exercises it. `.invalid` never resolves in real DNS, so a 200 proves the
		// connection used the pinned address rather than a fresh lookup.
		let hostHeader: string | null = null;
		server = Bun.serve({
			port: 0,
			fetch(req) {
				hostHeader = req.headers.get("host");
				return new Response(RSS_DOC, { status: 200 });
			},
		});
		const url = new URL(`http://feed.example.invalid:${server.port}/rss`);
		const resp = await fetchValidatedUrl(url, "127.0.0.1", {
			headers: {},
			signal: AbortSignal.timeout(5000),
		});
		expect(resp.status).toBe(200);
		expect(await resp.text()).toContain("Transport Feed");
		expect(hostHeader).toBe(`feed.example.invalid:${server.port}`);
	});

	it("rejects a streamed body that grows past the limit without a content-length", async () => {
		const bigChunk = "y".repeat(1024 * 1024);
		server = Bun.serve({
			port: 0,
			fetch() {
				const stream = new ReadableStream({
					start(controller) {
						// 6 x 1MiB chunks, chunked (no content-length) — the per-chunk
						// accumulator must trip the cap mid-stream.
						for (let i = 0; i < 6; i++) controller.enqueue(new TextEncoder().encode(bigChunk));
						controller.close();
					},
				});
				return new Response(stream, { status: 200 });
			},
		});
		const url = new URL(`http://127.0.0.1:${server.port}/`);
		await expect(fetchValidatedUrl(url, "127.0.0.1", { headers: {} })).rejects.toThrow(
			/size limit/,
		);
	});

	it("aborts in-flight when the signal fires", async () => {
		server = Bun.serve({
			port: 0,
			async fetch() {
				await new Promise((r) => setTimeout(r, 2000));
				return new Response("late", { status: 200 });
			},
		});
		const url = new URL(`http://127.0.0.1:${server.port}/`);
		const controller = new AbortController();
		const promise = fetchValidatedUrl(url, "127.0.0.1", {
			headers: {},
			signal: controller.signal,
		});
		controller.abort(new Error("deadline"));
		await expect(promise).rejects.toThrow();
	});

	it("rejects immediately when the signal is already aborted", async () => {
		server = Bun.serve({
			port: 0,
			fetch() {
				return new Response("never", { status: 200 });
			},
		});
		const url = new URL(`http://127.0.0.1:${server.port}/`);
		const signal = AbortSignal.abort(new Error("pre-aborted"));
		await expect(fetchValidatedUrl(url, "127.0.0.1", { headers: {}, signal })).rejects.toThrow();
	});
});

describe("RssPoller lifecycle + real-transport integration", () => {
	let db: Database;
	let siteId: string;
	let emitted: Array<Record<string, unknown>>;
	let eventBus: TypedEventEmitter;
	let server: ReturnType<typeof Bun.serve> | null = null;

	function seedFeed(url: string, overrides: Record<string, unknown> = {}): string {
		const now = new Date().toISOString();
		const id = randomUUID();
		insertRow(
			db,
			"rss_feeds",
			{
				id,
				name: "lifecycle-feed",
				url,
				description: null,
				poll_interval_seconds: 900,
				seen_guids: null,
				task_id: randomUUID(),
				thread_id: randomUUID(),
				created_at: now,
				deleted: 0,
				modified_at: now,
				...overrides,
			},
			siteId,
		);
		return id;
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
		server?.stop(true);
		server = null;
	});

	it("connect() runs an immediate tick and disconnect() clears runtime", async () => {
		server = Bun.serve({
			port: 0,
			fetch() {
				return new Response(RSS_DOC, { status: 200 });
			},
		});
		const port = server.port;
		// Feed URL carries a public hostname so validateDestination's SSRF guard
		// passes; the fetchValidatedUrl seam connects to loopback instead.
		seedFeed("https://feed.example.com/feed.xml");
		const poller = new RssPoller({
			db,
			siteId,
			eventBus,
			resolveHost: async () => ["93.184.216.34"],
			fetchValidatedUrl: (url, _address, init) =>
				fetch(`http://127.0.0.1:${port}${url.pathname}`, init as RequestInit),
		});

		await poller.connect();
		// connect() kicks an immediate tick (void) — let it settle.
		await new Promise((r) => setTimeout(r, 50));
		// First poll seeds the cursor without delivering.
		const row = db.query("SELECT seen_guids FROM rss_feeds LIMIT 1").get() as {
			seen_guids: string | null;
		};
		expect(row.seen_guids).not.toBeNull();

		await poller.disconnect();
		// Re-connect after disconnect is idempotent: a second connect() while the
		// timer is already live is a no-op, so guard the already-running branch.
		await poller.connect();
		await poller.connect();
		await poller.disconnect();
	});

	it("handles a 304 Not Modified via conditional headers without delivering", async () => {
		let hits = 0;
		server = Bun.serve({
			port: 0,
			fetch(req) {
				hits++;
				if (req.headers.get("if-none-match")) {
					return new Response(null, { status: 304 });
				}
				return new Response(RSS_DOC, { status: 200, headers: { etag: '"abc"' } });
			},
		});
		const port = server.port;
		seedFeed("https://feed.example.com/feed.xml", { seen_guids: JSON.stringify([]) });
		let fakeNow = 1_000_000;
		const poller = new RssPoller({
			db,
			siteId,
			eventBus,
			resolveHost: async () => ["93.184.216.34"],
			fetchValidatedUrl: (url, _address, init) =>
				fetch(`http://127.0.0.1:${port}${url.pathname}`, init as RequestInit),
			now: () => fakeNow,
		});

		await poller.tick();
		// Advance past cadence so the second tick actually re-polls.
		fakeNow += 2_000_000;
		await poller.tick();
		expect(hits).toBe(2);
	});

	it("warns and schedules a retry on an HTTP error status", async () => {
		const warns: string[] = [];
		server = Bun.serve({
			port: 0,
			fetch() {
				return new Response("boom", { status: 500 });
			},
		});
		const port = server.port;
		seedFeed("https://feed.example.com/feed.xml", { seen_guids: JSON.stringify([]) });
		const poller = new RssPoller({
			db,
			siteId,
			eventBus,
			resolveHost: async () => ["93.184.216.34"],
			fetchValidatedUrl: (url, _address, init) =>
				fetch(`http://127.0.0.1:${port}${url.pathname}`, init as RequestInit),
			logger: {
				info: () => {},
				warn: (msg) => warns.push(msg),
			},
		});

		await poller.tick();
		expect(warns.some((w) => w.includes("Feed fetch failed"))).toBe(true);
		// No delivery on an error.
		const durable = db.query("SELECT COUNT(*) as n FROM durable_work").get() as { n: number };
		expect(durable.n).toBe(0);
	});
});
