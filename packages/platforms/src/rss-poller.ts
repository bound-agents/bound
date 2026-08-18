import type { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import { insertInbox, listActiveRssFeeds, updateRow } from "@bound/core";
import { RSS_SEEN_GUIDS_CAP, injectTraceContext } from "@bound/shared";
import type { RssFeed, TypedEventEmitter } from "@bound/shared";

/**
 * Leader-gated RSS/Atom feed poller.
 *
 * The pull-side counterpart of the webhook intake pipeline: where webhooks
 * are pushed to `/webhook/:name` and land in `relay_inbox` as passive
 * `webhook_intake` rows, this poller PULLS feeds on a per-feed cadence and
 * writes one passive `rss_intake` row per new item, then emits
 * `connector:event` with `trigger_key: rss:<name>` so the scheduler wakes the
 * feed's bound event task and folds the items into its wakeup via
 * `buildEventWakeupContent`. Everything downstream of the inbox row is the
 * existing webhook/connector delivery track — this module only walks the
 * platform and checks the arrival boards.
 *
 * Runs on exactly one host: gated by `PlatformLeaderElection` under
 * `platform_leader:rss` (see packages/cli/src/commands/start/server.ts).
 * Dedup state (`rss_feeds.seen_guids`) lives on the synced row, so a
 * failed-over leader resumes without re-delivering the backlog; the
 * per-delivery `idempotency_key` (`rss-<name>-<guid>`) is a second,
 * local-only fence while the inbox row is alive.
 */

export interface RssItem {
	/** Stable item identity: <guid>/<id>, falling back to link, then title+date. */
	guid: string;
	title: string | null;
	link: string | null;
	/** pubDate (RSS) / published / updated (Atom), verbatim from the feed. */
	published: string | null;
	/** description (RSS) / summary|content (Atom), tag-stripped and capped. */
	summary: string | null;
}

/** Cap per-item summary text so a full-content feed can't bloat the wakeup. */
const MAX_ITEM_SUMMARY_CHARS = 4096;

/** Floor on per-feed cadence — protects feed hosts from misconfigured rows. */
export const MIN_POLL_INTERVAL_SECONDS = 60;

/** How often the poller scans for due feeds. */
const TICK_INTERVAL_MS = 30_000;

/** Per-fetch timeout. */
const FETCH_TIMEOUT_MS = 30_000;

/**
 * Retry window after a failed poll. A failed fetch used to wait the feed's
 * FULL cadence before retrying — observed in production: a 4h-cadence feed's
 * first fetch hiccuped once and the feed sat dark for the whole 4h. Failed
 * polls now become eligible again in min(cadence, this window).
 */
const FAILURE_RETRY_MS = 5 * 60_000;

function decodeEntities(text: string): string {
	return text
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/&quot;/g, '"')
		.replace(/&apos;/g, "'")
		.replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
		.replace(/&#x([0-9a-fA-F]+);/g, (_, code) => String.fromCodePoint(Number.parseInt(code, 16)))
		.replace(/&amp;/g, "&");
}

/** Extract the text content of the FIRST occurrence of `tag` within `xml`. */
function firstTagText(xml: string, tag: string): string | null {
	// <tag ...>content</tag> — non-greedy, tolerant of attributes and CDATA.
	const m = xml.match(new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, "i"));
	if (!m) return null;
	let text = m[1].trim();
	const cdata = text.match(/^<!\[CDATA\[([\s\S]*?)\]\]>$/);
	if (cdata) text = cdata[1].trim();
	return decodeEntities(text.replace(/<[^>]+>/g, "").trim()) || null;
}

/** Atom `<link href="..."/>` — prefer rel="alternate", fall back to first href. */
function atomLinkHref(xml: string): string | null {
	const alternate = xml.match(
		/<link[^>]*rel=["']alternate["'][^>]*href=["']([^"']+)["'][^>]*\/?>/i,
	);
	if (alternate) return decodeEntities(alternate[1]);
	const reversed = xml.match(/<link[^>]*href=["']([^"']+)["'][^>]*rel=["']alternate["'][^>]*\/?>/i);
	if (reversed) return decodeEntities(reversed[1]);
	const any = xml.match(/<link[^>]*href=["']([^"']+)["'][^>]*\/?>/i);
	return any ? decodeEntities(any[1]) : null;
}

function capSummary(text: string | null): string | null {
	if (text === null) return null;
	if (text.length <= MAX_ITEM_SUMMARY_CHARS) return text;
	return `${text.slice(0, MAX_ITEM_SUMMARY_CHARS)}…`;
}

/**
 * Parse an RSS 2.0 or Atom document into items, newest-first as ordered in
 * the document. Deliberately dependency-free: both formats reduce to the
 * same five fields, and feeds in the wild are messy enough that a lenient
 * regex extraction outperforms a strict XML parse for this purpose. Returns
 * `[]` for anything unrecognizable — the poller treats that as "no items",
 * never as an error worth crashing over.
 */
export function parseFeed(xml: string): RssItem[] {
	const items: RssItem[] = [];

	// RSS 2.0: <item>...</item>. Atom: <entry>...</entry>.
	const blocks = [
		...xml.matchAll(/<item(?:\s[^>]*)?>([\s\S]*?)<\/item>/gi),
		...xml.matchAll(/<entry(?:\s[^>]*)?>([\s\S]*?)<\/entry>/gi),
	];

	for (const block of blocks) {
		const body = block[1];
		const isAtom = block[0].startsWith("<entry");

		const title = firstTagText(body, "title");
		const link = isAtom ? atomLinkHref(body) : firstTagText(body, "link");
		const published = isAtom
			? (firstTagText(body, "published") ?? firstTagText(body, "updated"))
			: (firstTagText(body, "pubDate") ?? firstTagText(body, "dc:date"));
		const summary = capSummary(
			isAtom
				? (firstTagText(body, "summary") ?? firstTagText(body, "content"))
				: firstTagText(body, "description"),
		);
		const guid = isAtom
			? (firstTagText(body, "id") ?? link ?? `${title ?? ""}|${published ?? ""}`)
			: (firstTagText(body, "guid") ?? link ?? `${title ?? ""}|${published ?? ""}`);

		// A block with no usable identity at all is noise, not an item.
		if (!guid || guid === "|") continue;

		items.push({ guid, title, link, published, summary });
	}

	return items;
}

/** Logger surface this module needs. */
interface PollerLogger {
	info: (msg: string, meta?: Record<string, unknown>) => void;
	warn: (msg: string, meta?: Record<string, unknown>) => void;
}

export interface RssPollerDeps {
	db: Database;
	siteId: string;
	eventBus?: TypedEventEmitter;
	logger?: PollerLogger;
	/** Injectable fetch for tests. Defaults to global fetch. */
	fetchImpl?: typeof fetch;
	/** Injectable clock for tests. */
	now?: () => number;
	/** Captures the active W3C context at durable intake time. */
	traceContext?: () => Record<string, string> | null;
}

interface FeedRuntimeState {
	lastPolledMs: number;
	etag: string | null;
	lastModified: string | null;
}

export class RssPoller {
	private timer: ReturnType<typeof setInterval> | null = null;
	/** Per-feed cadence + HTTP validator cache. In-memory by design: a fresh
	 * leader simply re-fetches once and the seen_guids cursor absorbs it. */
	private runtime = new Map<string, FeedRuntimeState>();
	private tickInFlight = false;

	constructor(private readonly deps: RssPollerDeps) {}

	/** PlatformLeaderElection connector-shape adapter: called on leadership gain. */
	async connect(): Promise<void> {
		if (this.timer) return;
		this.deps.logger?.info("[rss-poller] Leadership gained — starting poll loop");
		// First tick immediately so a fresh leader doesn't wait a full interval.
		void this.tick();
		this.timer = setInterval(() => void this.tick(), TICK_INTERVAL_MS);
	}

	/** PlatformLeaderElection connector-shape adapter: called on leadership loss/shutdown. */
	async disconnect(): Promise<void> {
		if (this.timer) {
			clearInterval(this.timer);
			this.timer = null;
		}
		this.runtime.clear();
		this.deps.logger?.info("[rss-poller] Stopped");
	}

	/** One scan over all live feeds, polling those past their cadence. */
	async tick(): Promise<void> {
		// Ticks are cheap but fetches aren't; if a slow feed pushes a tick past
		// the interval, skip the overlap rather than stacking fetches.
		if (this.tickInFlight) return;
		this.tickInFlight = true;
		try {
			const nowMs = (this.deps.now ?? Date.now)();
			const feeds = listActiveRssFeeds(this.deps.db);

			// Drop runtime state for feeds that no longer exist.
			const liveIds = new Set(feeds.map((f) => f.id));
			for (const id of this.runtime.keys()) {
				if (!liveIds.has(id)) this.runtime.delete(id);
			}

			for (const feed of feeds) {
				const intervalMs = Math.max(feed.poll_interval_seconds, MIN_POLL_INTERVAL_SECONDS) * 1000;
				const state = this.runtime.get(feed.id);
				if (state && nowMs - state.lastPolledMs < intervalMs) continue;
				await this.pollFeed(feed, nowMs, intervalMs);
			}
		} finally {
			this.tickInFlight = false;
		}
	}

	private async pollFeed(feed: RssFeed, nowMs: number, intervalMs: number): Promise<void> {
		const state = this.runtime.get(feed.id) ?? {
			lastPolledMs: 0,
			etag: null,
			lastModified: null,
		};
		state.lastPolledMs = nowMs;
		this.runtime.set(feed.id, state);

		let body: string;
		try {
			const headers: Record<string, string> = {
				accept: "application/rss+xml, application/atom+xml, application/xml, text/xml",
				"user-agent": "bound-rss-poller",
			};
			if (state.etag) headers["if-none-match"] = state.etag;
			if (state.lastModified) headers["if-modified-since"] = state.lastModified;

			const fetchImpl = this.deps.fetchImpl ?? fetch;
			const resp = await fetchImpl(feed.url, {
				headers,
				signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
			});

			if (resp.status === 304) return; // validators say nothing changed
			if (!resp.ok) {
				this.deps.logger?.warn("[rss-poller] Feed fetch failed", {
					feed: feed.name,
					url: feed.url,
					status: resp.status,
				});
				this.scheduleRetry(state, nowMs, intervalMs);
				return;
			}

			state.etag = resp.headers.get("etag");
			state.lastModified = resp.headers.get("last-modified");
			body = await resp.text();
		} catch (error) {
			// Transient network failure — retry sooner than a long cadence (see
			// scheduleRetry). Observed in production: a 4h-cadence feed's first
			// fetch hiccuped once and the feed sat dark for the full 4h.
			this.deps.logger?.warn("[rss-poller] Feed fetch threw", {
				feed: feed.name,
				url: feed.url,
				error: error instanceof Error ? error.message : String(error),
			});
			this.scheduleRetry(state, nowMs, intervalMs);
			return;
		}

		const items = parseFeed(body);
		if (items.length === 0) {
			// A 2xx body that parses to zero items is usually a wrong URL or a
			// challenge/HTML page, not a legitimately empty feed — and this path
			// used to return in total silence (production: it ate the first 4h of
			// the first real feed with nothing in the logs). Warn with enough of
			// the body to diagnose, and while the feed has never seeded (null
			// cursor) retry soon; an established feed stays on its cadence.
			this.deps.logger?.warn("[rss-poller] Feed body parsed to zero items", {
				feed: feed.name,
				url: feed.url,
				bytes: body.length,
				head: body.slice(0, 160),
			});
			if (feed.seen_guids === null) {
				this.scheduleRetry(state, nowMs, intervalMs);
			}
			return;
		}

		let seen: string[];
		try {
			const parsed: unknown = feed.seen_guids ? JSON.parse(feed.seen_guids) : [];
			seen = Array.isArray(parsed) ? parsed.filter((g): g is string => typeof g === "string") : [];
		} catch {
			seen = [];
		}
		const seenSet = new Set(seen);

		// First poll of a brand-new feed (no cursor yet): seed the cursor
		// WITHOUT delivering. Dumping a feed's entire current contents as
		// "new items" on creation is noise, not events — deliveries start
		// with the first item that appears after the binding exists.
		const isFirstPoll = feed.seen_guids === null;

		// Feed documents are newest-first; deliver oldest-first so the folded
		// wakeup reads chronologically. Dedupe within the batch as well — a
		// single document can list the same guid twice (e.g. Bluesky reposts
		// re-list the original post's URI), which would otherwise store
		// duplicate cursor entries and burn idempotency-key inserts.
		const fresh: RssItem[] = [];
		const batchSeen = new Set<string>();
		for (const item of items.filter((i) => !seenSet.has(i.guid)).reverse()) {
			if (batchSeen.has(item.guid)) continue;
			batchSeen.add(item.guid);
			fresh.push(item);
		}

		let delivered = 0;
		const traceContext = this.deps.traceContext?.() ?? injectTraceContext();
		const serializedTraceContext = traceContext ? JSON.stringify(traceContext) : null;
		if (!isFirstPoll) {
			for (const item of fresh) {
				const inserted = insertInbox(this.deps.db, {
					id: randomUUID(),
					source_site_id: this.deps.siteId,
					kind: "rss_intake",
					ref_id: feed.thread_id,
					idempotency_key: `rss-${feed.name}-${item.guid}`.slice(0, 512),
					stream_id: null,
					payload: JSON.stringify({ feed: feed.name, url: feed.url, ...item }),
					expires_at: new Date(nowMs + 7 * 24 * 60 * 60 * 1000).toISOString(),
					received_at: new Date(nowMs).toISOString(),
					processed: 0,
					trace_context: serializedTraceContext,
				});
				if (inserted) delivered++;
			}
		}

		if (fresh.length > 0 || isFirstPoll) {
			// Persist the advanced cursor (newest last, capped). Synced write —
			// deliberately so, since the cursor must survive leader failover.
			const advanced = [...seen, ...fresh.map((i) => i.guid)].slice(-RSS_SEEN_GUIDS_CAP);
			updateRow(
				this.deps.db,
				"rss_feeds",
				feed.id,
				{ seen_guids: JSON.stringify(advanced) },
				this.deps.siteId,
			);
		}

		if (isFirstPoll) {
			// Leave a visible trace of the seeding poll. Without this, a freshly
			// created feed's entire setup phase is silent and "it doesn't seem to
			// be working" is indistinguishable from "nothing new has been
			// published since creation" (observed in production, 2026-07-15).
			this.deps.logger?.info(
				"[rss-poller] Seeded feed cursor (first poll delivers nothing by design)",
				{ feed: feed.name, items: fresh.length },
			);
		}

		if (delivered > 0) {
			this.deps.logger?.info("[rss-poller] Delivered new feed items", {
				feed: feed.name,
				items: delivered,
			});
			this.deps.eventBus?.emit("connector:event", {
				trigger_key: `rss:${feed.name}`,
				handle_id: feed.id,
				task_id: feed.task_id,
				batch_size: delivered,
			});
		}
	}

	/**
	 * Back-date a failed poll's cadence stamp so the feed becomes eligible
	 * again in min(cadence, FAILURE_RETRY_MS) instead of a full interval.
	 * A transient fetch failure on a long-cadence feed otherwise costs the
	 * whole interval — observed: a 4h feed's first fetch hiccuped once and
	 * the feed sat dark, silently, for 4 hours.
	 */
	private scheduleRetry(state: FeedRuntimeState, nowMs: number, intervalMs: number): void {
		state.lastPolledMs = nowMs - Math.max(0, intervalMs - FAILURE_RETRY_MS);
	}
}
