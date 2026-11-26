import type { Database } from "bun:sqlite";

/**
 * Hosts whose `modified_at` (or `online_at` fallback) is older than this are
 * stale. Heartbeat cadence is 2 minutes (`HOST_HEARTBEAT_INTERVAL`), so 5
 * minutes absorbs ~2 missed heartbeats before a peer is dropped.
 */
export const PLATFORM_HOST_STALE_THRESHOLD_MS = 5 * 60 * 1000;

interface HostFreshnessRow {
	modified_at: string | null;
	online_at: string | null;
}

/**
 * `modified_at` is the heartbeat-bumped column and the canonical signal;
 * `online_at` covers legacy rows that never received a `modified_at`.
 */
export function isHostFresh(
	row: HostFreshnessRow,
	now: number = Date.now(),
	thresholdMs: number = PLATFORM_HOST_STALE_THRESHOLD_MS,
): boolean {
	const ts = row.modified_at ?? row.online_at;
	if (!ts) return false;
	return now - new Date(ts).getTime() <= thresholdMs;
}

interface PlatformHostRow {
	site_id: string;
	platforms: string;
	modified_at: string | null;
	online_at: string | null;
}

/**
 * Fresh remote hosts with a parseable `platforms` array, most recently beating
 * first. Hosts with corrupted platforms JSON are skipped so an offline or
 * upgrading peer never masks a healthy peer's tools.
 */
function listFreshPlatformHosts(
	db: Database,
	localSiteId: string,
	now: number,
): Array<{ siteId: string; platforms: string[] }> {
	const rows = db
		.query(
			`SELECT site_id, platforms, modified_at, online_at FROM hosts
			 WHERE deleted = 0 AND platforms IS NOT NULL AND site_id != ?
			 ORDER BY COALESCE(modified_at, online_at) DESC`,
		)
		.all(localSiteId) as PlatformHostRow[];

	const hosts: Array<{ siteId: string; platforms: string[] }> = [];
	for (const row of rows) {
		if (!isHostFresh(row, now)) continue;
		try {
			const platforms = JSON.parse(row.platforms) as unknown;
			if (Array.isArray(platforms)) hosts.push({ siteId: row.site_id, platforms });
		} catch {
			// corrupted platforms JSON
		}
	}
	return hosts;
}

/**
 * Site id of a fresh remote host advertising `platformName`, or `null`. A
 * crashed peer's `hosts.platforms` advertisement stays live in synced state,
 * so without the freshness filter every platform request to it would poll
 * the relay until timeout. Multiple advertisers resolve to the most recent
 * heartbeat, which stays deterministic if leader election briefly disagrees.
 */
export function findFreshPlatformHost(
	db: Database,
	platformName: string,
	localSiteId: string,
	now: number = Date.now(),
): string | null {
	const host = listFreshPlatformHosts(db, localSiteId, now).find((h) =>
		h.platforms.includes(platformName),
	);
	return host?.siteId ?? null;
}

/** Platform names advertised by at least one fresh remote host. */
export function listFreshRemotePlatforms(
	db: Database,
	localSiteId: string,
	now: number = Date.now(),
): Set<string> {
	const fresh = new Set<string>();
	for (const host of listFreshPlatformHosts(db, localSiteId, now)) {
		for (const p of host.platforms) fresh.add(p);
	}
	return fresh;
}
