import type { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import { lookup } from "node:dns/promises";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import {
	DURABLE_INTAKE_ENABLED,
	insertDurableWork,
	insertInbox,
	listActiveRssFeeds,
	updateRow,
} from "@bound/core";
import {
	RSS_SEEN_GUIDS_CAP,
	counter,
	histogram,
	injectTraceContext,
	isBlockedAddress,
	isIpAddress,
} from "@bound/shared";
import type { RssFeed, TypedEventEmitter } from "@bound/shared";
import { SpanStatusCode, trace } from "@opentelemetry/api";

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

/** Bound redirects explicitly so every destination passes the SSRF guard. */
const MAX_REDIRECTS = 10;

/** Cap a feed document before parsing it into memory. */
const MAX_RSS_BODY_BYTES = 5 * 1024 * 1024;

/**
 * Retry window after a failed poll. A failed fetch used to wait the feed's
 * FULL cadence before retrying — observed in production: a 4h-cadence feed's
 * first fetch hiccuped once and the feed sat dark for the whole 4h. Failed
 * polls now become eligible again in min(cadence, this window).
 */
const FAILURE_RETRY_MS = 5 * 60_000;
const rssPollCounter = counter("bound.platform.rss.polls", { description: "RSS poll outcomes" });
const rssPollDuration = histogram("bound.platform.rss.poll.duration", {
	description: "RSS poll duration",
	unit: "ms",
});
const rssDeliveryCounter = counter("bound.platform.rss.deliveries", {
	description: "RSS items accepted for delivery",
});

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

export type ResolveHost = (hostname: string) => Promise<readonly string[]>;

/**
 * Fetch a URL through a connection pinned to a previously validated address.
 * Kept injectable so the poller test can assert the address reaching the
 * transport rather than merely the address returned by a DNS preflight.
 */
export type FetchValidatedUrl = (url: URL, address: string, init: RequestInit) => Promise<Response>;

const resolveHost: ResolveHost = async (hostname) =>
	(await lookup(hostname, { all: true, verbatim: true })).map(({ address }) => address);

function addressFamily(address: string): 4 | 6 {
	return address.includes(":") ? 6 : 4;
}

/**
 * Performs an HTTP GET while supplying the already validated DNS result to
 * Node's connection lookup. The request URL remains hostname-based, which
 * preserves the Host header and TLS SNI/certificate validation.
 */
export function fetchValidatedUrl(url: URL, address: string, init: RequestInit): Promise<Response> {
	return new Promise((resolve, reject) => {
		const requestFn = url.protocol === "https:" ? httpsRequest : httpRequest;
		const request = requestFn(
			url.href,
			{
				headers: Object.fromEntries(new Headers(init.headers).entries()),
				...(url.hostname === address
					? {}
					: {
							lookup: (_hostname: string, optionsOrCallback: unknown, maybeCallback?: unknown) => {
								const callback =
									typeof optionsOrCallback === "function" ? optionsOrCallback : maybeCallback;
								if (typeof callback === "function") callback(null, address, addressFamily(address));
							},
						}),
			},
			(response) => {
				const contentLength = Number(response.headers["content-length"]);
				if (Number.isFinite(contentLength) && contentLength > MAX_RSS_BODY_BYTES) {
					const error = new Error("RSS feed body exceeds size limit");
					response.destroy(error);
					reject(error);
					return;
				}

				const chunks: Buffer[] = [];
				let bytes = 0;
				response.on("data", (chunk: Buffer) => {
					bytes += chunk.length;
					if (bytes > MAX_RSS_BODY_BYTES) {
						response.destroy(new Error("RSS feed body exceeds size limit"));
						return;
					}
					chunks.push(chunk);
				});
				response.on("error", reject);
				response.on("end", () => {
					const headers = new Headers();
					for (const [name, value] of Object.entries(response.headers)) {
						if (Array.isArray(value)) {
							for (const entry of value) headers.append(name, entry);
						} else if (value !== undefined) {
							headers.set(name, String(value));
						}
					}
					resolve(
						new Response(Buffer.concat(chunks), { status: response.statusCode ?? 500, headers }),
					);
				});
			},
		);
		request.on("error", reject);
		const abort = () => request.destroy(init.signal?.reason);
		if (init.signal?.aborted) abort();
		else init.signal?.addEventListener("abort", abort, { once: true });
		request.end();
	});
}

async function readResponseBody(response: Response): Promise<string> {
	if (!response.body) return "";

	const reader = response.body.getReader();
	const chunks: Uint8Array[] = [];
	let bytes = 0;
	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			bytes += value.byteLength;
			if (bytes > MAX_RSS_BODY_BYTES) {
				const error = new Error("RSS feed body exceeds size limit");
				await reader.cancel(error);
				throw error;
			}
			chunks.push(value);
		}
	} finally {
		reader.releaseLock();
	}
	return new TextDecoder().decode(Buffer.concat(chunks));
}

function redirectLocation(resp: Response): string | null {
	return [301, 302, 303, 307, 308].includes(resp.status) ? resp.headers.get("location") : null;
}

interface ValidatedDestination {
	url: URL;
	address: string;
}

async function validateDestination(
	rawUrl: string,
	resolve: ResolveHost,
	signal?: AbortSignal,
): Promise<ValidatedDestination> {
	const url = new URL(rawUrl);
	if (url.protocol !== "http:" && url.protocol !== "https:") {
		throw new Error(`RSS feed URL must use http(s): ${url.protocol}`);
	}

	const hostname = url.hostname.replace(/^\[|\]$/g, "");
	// Race DNS resolution against the shared fetch deadline: a hostname whose
	// authoritative nameserver never answers would otherwise hold the poll open
	// indefinitely, past the whole-chain timeout that only guards the HTTP hops.
	const addresses = isIpAddress(hostname) ? [hostname] : await raceAbort(resolve(hostname), signal);
	if (addresses.length === 0 || addresses.some(isBlockedAddress)) {
		throw new Error(`RSS feed destination is not publicly routable: ${hostname}`);
	}
	return { url, address: addresses[0] };
}

/**
 * Reject as soon as `signal` aborts, otherwise resolve with the wrapped promise.
 * The underlying DNS lookup is not itself cancelable, but the poll no longer
 * waits on it: the deadline wins the race and the caller unwinds on schedule.
 */
function raceAbort<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
	if (!signal) return promise;
	if (signal.aborted) return Promise.reject(signal.reason ?? new Error("aborted"));
	return new Promise<T>((resolve, reject) => {
		const onAbort = () => reject(signal.reason ?? new Error("aborted"));
		signal.addEventListener("abort", onAbort, { once: true });
		promise.then(
			(value) => {
				signal.removeEventListener("abort", onAbort);
				resolve(value);
			},
			(err) => {
				signal.removeEventListener("abort", onAbort);
				reject(err);
			},
		);
	});
}

export interface RssPollerDeps {
	db: Database;
	siteId: string;
	eventBus?: TypedEventEmitter;
	logger?: PollerLogger;
	/** Injectable fetch for tests. Defaults to global fetch. */
	fetchImpl?: typeof fetch;
	/** Injectable DNS resolver for tests. Every resolved address must be public. */
	resolveHost?: ResolveHost;
	/** Injectable pinned transport for tests. Production uses the Node HTTP(S) transport below. */
	fetchValidatedUrl?: FetchValidatedUrl;
	/** Injectable full-chain deadline for deterministic tests. */
	createFetchDeadline?: (timeoutMs: number) => AbortSignal;
	/** Injectable clock for tests. */
	now?: () => number;
	/** Captures the active W3C context at durable intake time. */
	traceContext?: () => Record<string, string> | null;
	/** Injectable only for failure-path tests. */
	insertInbox?: typeof insertInbox;
	/** Injectable only for durable failure-path tests (mirrors the legacy insertInbox seam). */
	insertDurableWork?: typeof insertDurableWork;
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
		const span = trace.getTracer("bound.platforms").startSpan("rss.poll");
		const startedAt = performance.now();
		let outcome = "error";
		try {
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

				const resolve = this.deps.resolveHost ?? resolveHost;
				const deadline = (this.deps.createFetchDeadline ?? AbortSignal.timeout)(FETCH_TIMEOUT_MS);
				let nextUrl = feed.url;
				let resp: Response;
				for (let redirects = 0; ; redirects++) {
					deadline.throwIfAborted();
					const { url: destination, address } = await validateDestination(
						nextUrl,
						resolve,
						deadline,
					);
					const requestInit = {
						headers,
						redirect: "manual" as const,
						signal: deadline,
					};
					if (this.deps.fetchValidatedUrl) {
						resp = await this.deps.fetchValidatedUrl(destination, address, requestInit);
					} else if (this.deps.fetchImpl) {
						// Test seam only. Production must use the pinned transport below.
						resp = await this.deps.fetchImpl(destination, requestInit);
					} else {
						resp = await fetchValidatedUrl(destination, address, requestInit);
					}
					const location = redirectLocation(resp);
					if (!location) break;
					deadline.throwIfAborted();
					if (redirects >= MAX_REDIRECTS) throw new Error("RSS feed exceeded redirect limit");
					nextUrl = new URL(location, destination).href;
				}

				if (resp.status === 304) {
					outcome = "not_modified";
					span.setStatus({ code: SpanStatusCode.OK });
					return;
				} // validators say nothing changed
				if (!resp.ok) {
					this.deps.logger?.warn("[rss-poller] Feed fetch failed", {
						feed: feed.name,
						url: feed.url,
						status: resp.status,
					});
					this.scheduleRetry(state, nowMs, intervalMs);
					outcome = "http_error";
					span.setStatus({ code: SpanStatusCode.ERROR });
					return;
				}

				state.etag = resp.headers.get("etag");
				state.lastModified = resp.headers.get("last-modified");
				body = await readResponseBody(resp);
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
				outcome = "network_error";
				throw error;
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
				outcome = "empty";
				span.setStatus({ code: SpanStatusCode.OK });
				return;
			}

			let seen: string[];
			try {
				const parsed: unknown = feed.seen_guids ? JSON.parse(feed.seen_guids) : [];
				seen = Array.isArray(parsed)
					? parsed.filter((g): g is string => typeof g === "string")
					: [];
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
			const persistIntake = this.deps.insertInbox ?? insertInbox;
			const persistDurable = this.deps.insertDurableWork ?? insertDurableWork;
			const persistTransaction = this.deps.db.transaction(() => {
				if (!isFirstPoll) {
					for (const item of fresh) {
						const id = randomUUID();
						const idempotencyKey = `rss-${feed.name}-${item.guid}`;
						const payload = JSON.stringify({ feed: feed.name, url: feed.url, ...item });
						const receivedAt = new Date(nowMs).toISOString();
						const expiresAt = new Date(nowMs + 7 * 24 * 60 * 60 * 1000).toISOString();
						const inserted =
							DURABLE_INTAKE_ENABLED && !this.deps.insertInbox
								? persistDurable(this.deps.db, {
										id,
										target_site_id: this.deps.siteId,
										kind: "rss_intake",
										payload,
										idempotency_key: idempotencyKey,
										expires_at: expiresAt,
										ref_id: feed.thread_id,
										source_site: this.deps.siteId,
										received_at: receivedAt,
									})
								: persistIntake(this.deps.db, {
										id,
										source_site_id: this.deps.siteId,
										kind: "rss_intake",
										ref_id: feed.thread_id,
										idempotency_key: idempotencyKey,
										stream_id: null,
										payload,
										expires_at: expiresAt,
										received_at: receivedAt,
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
			});
			persistTransaction();
			if (delivered > 0) rssDeliveryCounter.add(delivered);

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

			outcome = "success";
			span.setStatus({ code: SpanStatusCode.OK });

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
		} catch (error) {
			const exception = error instanceof Error ? error : new Error(String(error));
			span.recordException(exception);
			span.setStatus({ code: SpanStatusCode.ERROR, message: exception.message });
			if (outcome !== "network_error") throw error;
		} finally {
			rssPollCounter.add(1, { outcome });
			rssPollDuration.record(performance.now() - startedAt, { outcome });
			span.end();
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
