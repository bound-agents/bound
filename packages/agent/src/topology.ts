import type { Database } from "bun:sqlite";
import { getPeerSiteId } from "@bound/core";
import type { SyncConfig } from "@bound/shared";

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

	return getPeerSiteId(db);
}

/**
 * Derive this host's topology role from its loaded optional config, matching
 * the expression used in context assembly (`syncConfig?.hub ? "spoke" : "hub"`):
 * a host that names a hub URL in `sync.json` is a spoke; otherwise it is the
 * hub (or a standalone node, which behaves as a hub for routing purposes).
 * Returns `undefined` when sync config is absent or failed to load.
 */
export function resolveTopologyRole(optionalConfig: {
	sync?: { ok: boolean; value?: unknown };
}): TopologyRole | undefined {
	const syncResult = optionalConfig?.sync;
	if (!syncResult?.ok) return undefined;
	const syncConfig = syncResult.value as SyncConfig | undefined;
	return syncConfig?.hub ? "spoke" : "hub";
}
