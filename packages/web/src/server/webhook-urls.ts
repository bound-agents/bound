/**
 * Helper that enumerates webhook delivery URLs across the cluster.
 *
 * Webhook ingestion is at `POST /webhook/:name` on the SYNC server
 * (port 3000), not on the web API (port 3001). The web UI used to render a
 * URL derived from `window.location.origin`, which on most setups points at
 * the web port and the wrong route shape. Issue #36 reopens that — Kara
 * wants every valid URL surfaced so the operator can pick the one that
 * matches their deployment topology, public/private classification left to
 * the operator.
 *
 * Sources of URLs (in display order):
 *   1. Hub URL — `sync.hub` config, if this node is a spoke. This is
 *      typically the public surface external services should use.
 *   2. Local URL(s) — built from this node's sync server bind config.
 *      `0.0.0.0` / `::` expand to `localhost`; otherwise the bind host
 *      is emitted verbatim plus a `localhost` entry as a convenience.
 *   3. Cluster URLs — one per peer host with a non-empty `sync_url`,
 *      excluding the local site_id (already covered by Local URL).
 *
 * URL transformation: WS schemes are mapped to HTTP (`ws://` → `http://`,
 * `wss://` → `https://`); the path is replaced with `/webhook/<name>` so
 * any sync-specific suffix like `/sync/ws` is stripped. Inputs that do not
 * parse as URLs are dropped silently — they tend to be empty strings (the
 * common case in practice; `hosts.sync_url` is unset on most spokes).
 *
 * Output is de-duplicated on URL string. Same URL appearing in multiple
 * sources (e.g. local + cluster on a hub serving itself) keeps only the
 * first source label per the order above.
 */

export type WebhookUrlSource = "hub" | "local" | "cluster";

export interface WebhookUrlEntry {
	url: string;
	source: WebhookUrlSource;
	/** Cluster source: the peer host's display name. Local: this host's name. */
	host_name?: string;
	/** Cluster source: the peer host's site_id. */
	site_id?: string;
}

export interface ClusterHostRow {
	site_id: string;
	host_name: string;
	sync_url: string | null;
}

export interface BuildWebhookUrlsInput {
	/** Webhook name path segment, e.g. "github". */
	name: string;
	/** This host's sync server bind host. e.g. "localhost", "0.0.0.0", "192.168.1.10". */
	syncBindHost: string;
	/** This host's sync server bind port. e.g. 3000. */
	syncPort: number;
	/** This host's display name (hosts.host_name). */
	localHostName?: string;
	/** This host's site_id; used to skip self when joining cluster rows. */
	localSiteId?: string;
	/** sync.hub from config, if this node is a spoke. */
	hubUrl?: string;
	/** Non-deleted rows from the hosts table. */
	clusterHosts?: readonly ClusterHostRow[];
}

const ANY_BIND_HOSTS = new Set(["0.0.0.0", "::", ""]);

/**
 * Convert an arbitrary base URL plus webhook name to a webhook delivery URL.
 * Returns null when the input cannot be parsed (e.g. empty string).
 */
export function webhookUrlFromBase(baseUrl: string, name: string): string | null {
	if (!baseUrl) return null;
	let parsed: URL;
	try {
		parsed = new URL(baseUrl);
	} catch {
		return null;
	}

	// ws:// → http://, wss:// → https://. Other schemes pass through unchanged
	// so an http(s) sync_url renders as itself.
	if (parsed.protocol === "ws:") {
		parsed.protocol = "http:";
	} else if (parsed.protocol === "wss:") {
		parsed.protocol = "https:";
	}

	parsed.pathname = `/webhook/${name}`;
	parsed.search = "";
	parsed.hash = "";
	// URL serialization keeps a trailing slash on origin-only inputs; pathname
	// assignment above replaces it cleanly.
	return parsed.toString();
}

export function buildWebhookUrls(input: BuildWebhookUrlsInput): WebhookUrlEntry[] {
	const { name, syncBindHost, syncPort, localHostName, localSiteId, hubUrl, clusterHosts } = input;

	const out: WebhookUrlEntry[] = [];
	const seen = new Set<string>();

	const push = (entry: WebhookUrlEntry): void => {
		if (seen.has(entry.url)) return;
		seen.add(entry.url);
		out.push(entry);
	};

	// 1. Hub URL — if this node is a spoke, this is the public surface.
	if (hubUrl) {
		const url = webhookUrlFromBase(hubUrl, name);
		if (url) {
			push({ url, source: "hub" });
		}
	}

	// 2. Local URL(s).
	const port = syncPort;
	const isAnyBind = ANY_BIND_HOSTS.has(syncBindHost);
	const localHosts: string[] = [];
	if (isAnyBind) {
		localHosts.push("localhost");
	} else {
		localHosts.push(syncBindHost);
		// Convenience: also surface localhost when bound to a non-loopback
		// address — most operator workflows want both for local testing.
		if (syncBindHost !== "localhost" && syncBindHost !== "127.0.0.1") {
			localHosts.push("localhost");
		}
	}
	for (const host of localHosts) {
		// IPv6 literals need bracketing in URLs.
		const formattedHost = host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
		const base = `http://${formattedHost}:${port}`;
		const url = webhookUrlFromBase(base, name);
		if (url) {
			push({
				url,
				source: "local",
				host_name: localHostName,
				site_id: localSiteId,
			});
		}
	}

	// 3. Cluster URLs from peer hosts with a sync_url.
	if (clusterHosts) {
		for (const row of clusterHosts) {
			if (!row.sync_url) continue;
			if (localSiteId && row.site_id === localSiteId) continue;
			const url = webhookUrlFromBase(row.sync_url, name);
			if (!url) continue;
			push({
				url,
				source: "cluster",
				host_name: row.host_name,
				site_id: row.site_id,
			});
		}
	}

	return out;
}
