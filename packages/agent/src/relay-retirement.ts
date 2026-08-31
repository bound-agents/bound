import type { Database } from "bun:sqlite";
import {
	DURABLE_RELAY_ENABLED,
	dropLegacyRelayTables,
	findHostWorkSpoolCapabilityById,
	hasDroppedLegacyRelayTables,
	insertDurableWork,
	legacyRelayTablesEmpty,
	listHostsWithLiveness,
	markDeliveredForTarget,
	readUndelivered,
} from "@bound/core";
import { emitDurableWorkWritten } from "@bound/core";
import type { Logger, RelayOutboxEntry, TypedEventEmitter } from "@bound/shared";
import { RELAY_RESPONSE_KINDS } from "@bound/shared";
import { counter } from "@bound/shared";
import { shouldRouteRelayDurable } from "./relay-router";
import type { TopologyRole } from "./topology";

/**
 * Legacy-relay-table retirement (slice 4E, release N — the ordering-invariant
 * migration release). This module runs the per-host drain-then-gated-drop that
 * lets a host retire `relay_outbox`/`relay_inbox` once every live peer speaks
 * the spool protocol (R-DW14) and its own legacy tables are empty. Release N+1
 * (deleting the legacy writers/readers, refusing startup on populated legacy
 * tables) is out of scope; every legacy code path still runs, guarded by
 * {@link hasDroppedLegacyRelayTables} so a dropped host degrades to spool-only.
 *
 * See docs/design/specs/2026-08-31-durable-work-consolidation.md §7 and #253.
 */

/**
 * Liveness horizon for the gated drop. A peer that has been silent longer than
 * this is treated as permanently gone and excluded from the must-advertise set;
 * a peer seen within it MUST advertise spool support before this host may drop,
 * because it might return still expecting legacy delivery. Deliberately far
 * wider than the 5-minute routing-staleness threshold: a host restart, a deploy
 * gap, or an overnight-offline laptop must still count. Twelve hours is
 * conservative — a peer offline that long is operationally dead, and if it does
 * return it re-reads this host's synced advertisement and sends spool-only (the
 * only residual hole, a peer with a stale hosts snapshot, is handled on the
 * receive side by the RELAY_SEND refusal, not by widening this window further).
 */
export const DROP_LIVENESS_HORIZON_MS = 12 * 60 * 60 * 1000;

const drainReenqueuedCounter = counter("bound.relay.legacy_drain.reenqueued", {
	description: "Legacy relay_outbox rows re-enqueued onto the durable work spool during 4E drain",
});
const legacyTablesDroppedCounter = counter("bound.relay.legacy_tables.dropped", {
	description: "Hosts that dropped their legacy relay tables after the 4E gate passed (one-way)",
});

const RESPONSE_KIND_SET = new Set<string>(RELAY_RESPONSE_KINDS);

export interface RelayRetirementContext {
	db: Database;
	/** This host's own site id. */
	localSiteId: string;
	/** Cluster role, for the spoke hub-hop capability gate (mirrors the router). */
	topologyRole: TopologyRole | undefined;
	logger?: Logger;
	/** Threaded through for the durable_work:written push-on-insert emit. */
	eventBus?: TypedEventEmitter;
}

export interface DrainOutcome {
	/** Undelivered legacy outbox rows re-enqueued onto the durable spool and marked delivered. */
	reenqueued: number;
	/** Undelivered legacy outbox rows left for the legacy transport (non-advertising path). */
	leftLegacy: number;
}

/**
 * Deterministic idempotency key for a re-enqueued legacy outbox row. A row that
 * already carries a key rides it VERBATIM (preserving the #254 contracts); a
 * null-keyed legacy row gets `legacy-relay:<row-id>`, which is stable across
 * drain re-runs so the (kind, idempotency_key) fence dedupes a repeated drain.
 */
export function legacyDrainIdempotencyKey(entry: RelayOutboxEntry): string {
	return entry.idempotency_key ?? `legacy-relay:${entry.id}`;
}

/**
 * Drain this host's own undelivered legacy `relay_outbox` rows onto the durable
 * work spool where the target's path resolves durable (the same decision the
 * router makes: toggle on + per-hop capability). A re-routed row is inserted as
 * a peer-targeted PENDING durable_work row carrying the row's key verbatim (or
 * `legacy-relay:<id>` for a null-keyed row), then the legacy row is marked
 * delivered — its content now lives in the spool. A row whose target does NOT
 * resolve durable is LEFT UNTOUCHED for the legacy transport, which still runs.
 *
 * `relay_inbox` unprocessed rows need no re-enqueue: their ordinary consumers
 * (the legacy readers, the 4D-D union awaits, the scheduler fold) still run; the
 * gated drop only observes emptiness. So the drain touches the outbox only.
 *
 * Idempotent: the (kind, idempotency_key) fence + delivered-marking make a
 * re-run a no-op. Only response kinds that are peer-targeted are re-routable via
 * the request insert path; a response row uses `insertDurableWork` directly with
 * its verbatim/derived key. Self-targeted rows are left legacy (loopback is
 * unchanged this slice).
 *
 * Rows re-enqueued inside no transaction here, so `insertDurableWork` emits
 * `durable_work:written` inline for each newly-inserted peer-targeted row,
 * waking the transport's spool drain. A no-op fence insert emits nothing.
 */
export function drainLegacyRelayOutbox(ctx: RelayRetirementContext): DrainOutcome {
	// A dropped host has no legacy outbox to drain.
	if (hasDroppedLegacyRelayTables(ctx.db)) return { reenqueued: 0, leftLegacy: 0 };

	let undelivered: RelayOutboxEntry[];
	try {
		undelivered = readUndelivered(ctx.db);
	} catch {
		// Table absent (dropped between the guard and here) — nothing to drain.
		return { reenqueued: 0, leftLegacy: 0 };
	}

	const reenqueuedIds: string[] = [];
	const writtenPeerRows: Array<{ id: string; target_site_id: string }> = [];
	let leftLegacy = 0;

	for (const entry of undelivered) {
		// Self-targeted rows stay on the legacy loopback path (unchanged this slice).
		if (entry.target_site_id === ctx.localSiteId) {
			leftLegacy++;
			continue;
		}
		const durable = shouldRouteRelayDurable(ctx.db, {
			targetSiteId: entry.target_site_id,
			localSiteId: ctx.localSiteId,
			topologyRole: ctx.topologyRole,
		});
		if (!durable) {
			leftLegacy++;
			continue;
		}

		// Re-enqueue as a peer-targeted PENDING durable_work row. The key rides
		// verbatim when present; a null-keyed legacy row gets a deterministic
		// legacy-relay:<id> key so a re-run dedupes on the fence.
		const id = crypto.randomUUID();
		const isResponse = RESPONSE_KIND_SET.has(entry.kind);
		const inserted = insertDurableWork(ctx.db, {
			id,
			target_site_id: entry.target_site_id,
			kind: entry.kind,
			payload: entry.payload,
			idempotency_key: legacyDrainIdempotencyKey(entry),
			expires_at: entry.expires_at,
			// Responses correlate by ref_id; requests carry ref_id when present.
			ref_id: entry.ref_id ?? null,
			stream_id: entry.stream_id ?? null,
			source_site: entry.source_site_id ?? ctx.localSiteId,
		});
		if (inserted) writtenPeerRows.push({ id, target_site_id: entry.target_site_id });
		// Whether newly inserted OR deduped on the fence, the row's content is now
		// durable in the spool, so retire the legacy copy either way — a deduped
		// insert means a prior drain already carried it.
		reenqueuedIds.push(entry.id);
		void isResponse; // kept for clarity; both request+response reroute identically.
	}

	if (reenqueuedIds.length > 0) {
		// Mark exactly the drained rows delivered so the legacy transport never
		// re-sends them; grouped by target for the target-scoped marker.
		const byTarget = new Map<string, string[]>();
		for (const entry of undelivered) {
			if (reenqueuedIds.includes(entry.id)) {
				const list = byTarget.get(entry.target_site_id) ?? [];
				list.push(entry.id);
				byTarget.set(entry.target_site_id, list);
			}
		}
		for (const [target, ids] of byTarget) {
			markDeliveredForTarget(ctx.db, ids, target);
		}
	}

	// Wake the transport's spool drain for each newly-durable peer-targeted row.
	if (writtenPeerRows.length > 0 && ctx.eventBus) {
		emitDurableWorkWritten(writtenPeerRows);
	}

	if (reenqueuedIds.length > 0) {
		drainReenqueuedCounter.add(reenqueuedIds.length);
		ctx.logger?.info("[relay-retirement] Drained legacy outbox rows onto spool", {
			reenqueued: reenqueuedIds.length,
			leftLegacy,
		});
	}

	return { reenqueued: reenqueuedIds.length, leftLegacy };
}

/**
 * Whether every LIVE peer advertises spool support (R-DW14). "Live" is
 * conservative: a non-deleted peer seen within {@link DROP_LIVENESS_HORIZON_MS}
 * (by COALESCE(modified_at, online_at)) counts and MUST advertise; a peer with
 * no liveness timestamp at all counts too (it might come back with legacy
 * expectations). Only a peer silent longer than the horizon is excluded as
 * permanently gone. A single live peer lacking the capability bit blocks the
 * drop. Excludes self.
 */
export function allLivePeersAdvertiseSpool(db: Database, localSiteId: string): boolean {
	const now = Date.now();
	const peers = listHostsWithLiveness(db).filter((h) => h.site_id !== localSiteId);
	for (const peer of peers) {
		const ts = peer.modified_at ?? peer.online_at;
		// A peer silent longer than the horizon is treated as permanently gone.
		if (ts) {
			const age = now - new Date(ts).getTime();
			if (age > DROP_LIVENESS_HORIZON_MS) continue;
		}
		// Live (or timestamp-less): must advertise, else block the drop.
		const cap = findHostWorkSpoolCapabilityById(db, peer.site_id);
		if (!cap?.work_spool_capable) return false;
	}
	return true;
}

/**
 * Run one gated-drop check. IFF every live peer advertises spool support AND
 * this host's legacy tables are both empty (zero rows — processed/delivered rows
 * must already have been pruned by the 300s prune), drop `relay_outbox` and
 * `relay_inbox` and set the one-way local marker. `relay_cycles` (telemetry) is
 * retained. Returns true if this call performed the drop. Idempotent: a
 * previously-dropped host returns false immediately.
 */
export function maybeDropLegacyRelayTables(ctx: RelayRetirementContext): boolean {
	if (hasDroppedLegacyRelayTables(ctx.db)) return false;
	if (!allLivePeersAdvertiseSpool(ctx.db, ctx.localSiteId)) return false;
	if (!legacyRelayTablesEmpty(ctx.db)) return false;

	const dropped = dropLegacyRelayTables(
		ctx.db,
		"slice 4E gated drop: all live peers advertise work_spool_capable and local legacy relay tables are empty",
	);
	if (dropped) {
		legacyTablesDroppedCounter.add(1);
		// A significant one-way event — structured warn so it stands out in logs.
		ctx.logger?.warn("[relay-retirement] Dropped legacy relay tables (one-way)", {
			site_id: ctx.localSiteId,
			relay_cycles_retained: true,
			event: "relay_legacy_tables_dropped",
		});
	}
	return dropped;
}

/**
 * One retirement pass: drain the legacy outbox onto the spool, then run the
 * gated-drop check. Safe to call repeatedly (both halves are idempotent). Wired
 * at startup (boot recovery) and on the relay processor's periodic cadence.
 */
export function runRelayRetirementPass(ctx: RelayRetirementContext): {
	drain: DrainOutcome;
	dropped: boolean;
} {
	// A rollback flip (BOUND_DURABLE_RELAY=0) on a NOT-yet-dropped host disables
	// re-routing (shouldRouteRelayDurable returns false), so the drain leaves
	// everything legacy and the gate never advances — legacy keeps working. On a
	// host that HAS dropped, the toggle cannot resurrect legacy; the guarded call
	// sites no-op with a warning (see hasDroppedLegacyRelayTables guards).
	const drain = drainLegacyRelayOutbox(ctx);
	const dropped = maybeDropLegacyRelayTables(ctx);
	void DURABLE_RELAY_ENABLED; // referenced for the rollback-posture doc above.
	return { drain, dropped };
}
