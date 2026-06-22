import type { Database } from "bun:sqlite";

/** Cluster topology role of a host: the hub (others connect to it) or a spoke. */
export type TopologyRole = "hub" | "spoke";

/**
 * Resolve which node carries the hub role, from the perspective of the local
 * host. Returns the hub's `site_id`, or `undefined` when it cannot be
 * determined (role unknown, or a spoke with no sync peer yet).
 *
 * The result is gated on `topologyRole` and that gate is load-bearing:
 *
 * - `hub`   → this host IS the hub, so the answer is `localSiteId`.
 * - `spoke` → the hub is whichever peer this spoke connects to. A spoke peers
 *   with exactly one node (the hub), so the lone `sync_state` row names it.
 * - `undefined` → cannot determine; return `undefined`.
 *
 * Why the gate matters: a HUB holds a `sync_state` cursor row per connected
 * SPOKE (seeded in `seedNewPeer`), so an *ungated* `sync_state LIMIT 1` read
 * would surface one of its spokes as "the hub" — exactly the failure mode that
 * makes a hub misidentify itself. Only read `sync_state` once we know we are a
 * spoke. (`packages/web/src/server/routes/status.ts` predates this helper and
 * still does the ungated read; it should adopt this.)
 *
 * Reads only the slow-moving `peer_site_id` — never the flapping
 * `last_received` / `online_at` columns — so callers on the cache-stable
 * prefix stay byte-stable. Returns `undefined` on a synthetic DB lacking the
 * table, matching the graceful-degradation posture of the orientation blocks.
 */
export function resolveHubSiteId(
	db: Database,
	topologyRole: TopologyRole | undefined,
	localSiteId: string | undefined,
): string | undefined {
	if (!topologyRole) return undefined;
	if (topologyRole === "hub") return localSiteId;

	try {
		const peer = db.prepare("SELECT peer_site_id FROM sync_state LIMIT 1").get() as {
			peer_site_id: string;
		} | null;
		return peer?.peer_site_id ?? undefined;
	} catch {
		return undefined;
	}
}
