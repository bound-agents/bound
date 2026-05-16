import type { Database } from "bun:sqlite";

/**
 * Hosts whose `modified_at` (or `online_at` fallback) is older than this are
 * considered stale and excluded from platform routing decisions.
 *
 * Heartbeat cadence is 2 minutes (see `host-heartbeat.ts`), so 5 minutes
 * absorbs ~2 missed heartbeats before we drop a peer. Same threshold used by
 * `relay-router.ts`, `model-resolution.ts`, and `web/status.ts` — keep them
 * in sync if you change this.
 */
export const PLATFORM_HOST_STALE_THRESHOLD_MS = 5 * 60 * 1000;

interface HostFreshnessRow {
	modified_at: string | null;
	online_at: string | null;
}

/**
 * True when the host's most recent freshness signal (`modified_at`, falling
 * back to `online_at`) is within `PLATFORM_HOST_STALE_THRESHOLD_MS` of `now`.
 *
 * `modified_at` is the heartbeat-bumped column and is the canonical signal.
 * `online_at` is the fallback for legacy/upgrade rows that may not yet have a
 * `modified_at`.
 */
export function isHostFresh(row: HostFreshnessRow, now: number = Date.now()): boolean {
	const ts = row.modified_at ?? row.online_at;
	if (!ts) return false;
	return now - new Date(ts).getTime() <= PLATFORM_HOST_STALE_THRESHOLD_MS;
}

interface PlatformHostRow {
	site_id: string;
	platforms: string;
	modified_at: string | null;
	online_at: string | null;
}

/**
 * Returns the site_id of a fresh remote host that advertises `platformName`,
 * or `null` if no such host exists. Used by the platform-request relay path
 * (`mcp-registry.discoverRemoteTools` and the `connectorCtx.remotePlatformRequest`
 * factories in `cli/start/server.ts` and `cli/start/scheduler.ts`) to avoid
 * firing relay requests at hosts that are no longer beating.
 *
 * Why we filter staleness here: previously, a remote daemon that crashed
 * shortly after boot would leave its `hosts.platforms` advertisement live in
 * the synced cluster state. The discovery loop (60s cadence) and any
 * dispatched platform tool call would then fire a `platform_request` outbox
 * entry, poll for 15 seconds, and time out — once per minute, indefinitely,
 * with a logged ERROR each cycle. The other relay paths
 * (`relay-router.findEligibleHosts`, `model-resolution.resolveRemoteModel`)
 * already filter on the same threshold; this helper closes that gap for the
 * platform-request path.
 *
 * When multiple fresh hosts advertise the same platform, returns the one with
 * the most recent `modified_at` (deterministic, defends against the rare case
 * where leader election briefly disagrees).
 */
export function findFreshPlatformHost(
	db: Database,
	platformName: string,
	localSiteId: string,
	now: number = Date.now(),
): string | null {
	const rows = db
		.query(
			`SELECT site_id, platforms, modified_at, online_at FROM hosts
			 WHERE deleted = 0 AND platforms IS NOT NULL AND site_id != ?
			 ORDER BY COALESCE(modified_at, online_at) DESC`,
		)
		.all(localSiteId) as PlatformHostRow[];

	for (const row of rows) {
		if (!isHostFresh(row, now)) continue;
		try {
			const platforms = JSON.parse(row.platforms) as string[];
			if (Array.isArray(platforms) && platforms.includes(platformName)) {
				return row.site_id;
			}
		} catch {
			// Skip hosts with corrupted platforms JSON; an offline/upgrading peer
			// should never mask a healthy peer's tools.
		}
	}
	return null;
}

/**
 * Returns the set of platform server names advertised by at least one fresh
 * remote host (excluding the local site). Used by `discoverRemoteTools` to
 * decide which platforms to probe via `tools/list` — skipping platforms whose
 * only advertiser is stale prevents the discovery loop from spamming
 * timeout-errors at unreachable hosts.
 */
export function listFreshRemotePlatforms(
	db: Database,
	localSiteId: string,
	now: number = Date.now(),
): Set<string> {
	const rows = db
		.query(
			`SELECT site_id, platforms, modified_at, online_at FROM hosts
			 WHERE deleted = 0 AND platforms IS NOT NULL AND site_id != ?`,
		)
		.all(localSiteId) as PlatformHostRow[];

	const fresh = new Set<string>();
	for (const row of rows) {
		if (!isHostFresh(row, now)) continue;
		try {
			const platforms = JSON.parse(row.platforms) as string[];
			if (Array.isArray(platforms)) {
				for (const p of platforms) fresh.add(p);
			}
		} catch {
			// Skip hosts with corrupted platforms JSON.
		}
	}
	return fresh;
}
