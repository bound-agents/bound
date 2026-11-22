import type { Database } from "bun:sqlite";
import { findModelRoutingRule, findRouteDrain, listDrainedRouteIds } from "@bound/core";

/**
 * Pure composition of the synced routing preferences (model_routing_rules,
 * route_drains) over a candidate route pool, plus thread-sticky route
 * resolution and hard-pin parsing (2026-11-21-model-routing.md §5.2–5.4, §6.2).
 *
 * These helpers are deliberately pure over their explicit inputs (the DB reads
 * are isolated to thin wrappers at the top) so the ranking, stickiness, and pin
 * rules can be unit-tested without a live router or relay. The router and
 * resolveModel wire them in; see model-resolution.ts.
 */

/** A route eligible for selection, as seen by ranking. */
export interface RankableRoute {
	/** `RouteId` (`${siteId}:${provider}:${backendId}`). */
	routeId: string;
	/** True when the route is served by the local host (locality tie-breaker). */
	local: boolean;
}

/**
 * Deterministic candidate ranking (§5.2). Input routes are assumed already
 * filtered for health, readiness, and capability — this function applies only
 * the preference-and-identity ordering and the drain exclusion:
 *
 *   1. per-model route_order (listed RouteIds in declared order) first;
 *   2. locality tie-breaker (local before remote) for unlisted routes;
 *   3. stable lexical RouteId tie-breaker.
 *
 * Heartbeat freshness never enters here (R-RT8). A drained route (§6.2) is
 * removed entirely — it is a candidate for neither normal selection nor a
 * half-open trial.
 */
export function rankRoutes(
	routes: RankableRoute[],
	opts: { routeOrder?: string[] | null; drainedRouteIds?: ReadonlySet<string> },
): RankableRoute[] {
	const drained = opts.drainedRouteIds ?? new Set<string>();
	const order = opts.routeOrder ?? [];
	// Rank index within the declared route_order; Infinity for unlisted routes.
	const orderIndex = new Map<string, number>();
	order.forEach((id, i) => {
		if (!orderIndex.has(id)) orderIndex.set(id, i);
	});

	return routes
		.filter((r) => !drained.has(r.routeId))
		.slice()
		.sort((a, b) => {
			const ai = orderIndex.get(a.routeId) ?? Number.POSITIVE_INFINITY;
			const bi = orderIndex.get(b.routeId) ?? Number.POSITIVE_INFINITY;
			if (ai !== bi) return ai - bi;
			// Both unlisted (or impossibly equal): local before remote.
			if (a.local !== b.local) return a.local ? -1 : 1;
			// Stable identity tie-breaker.
			return a.routeId < b.routeId ? -1 : a.routeId > b.routeId ? 1 : 0;
		});
}

/** Minimum stickiness window floor (§5.3): `max(route.cache_ttl_ms, 5m)`. */
export const STICKY_MIN_WINDOW_MS = 5 * 60 * 1000;

/** Parse a cache-TTL hint ("5m" / "1h") to milliseconds, or null if unset/unknown. */
export function cacheTtlToMs(ttl: string | null | undefined): number | null {
	if (ttl === "5m") return 5 * 60 * 1000;
	if (ttl === "1h") return 60 * 60 * 1000;
	return null;
}

/** The latest ok turn's sticky projection for a thread (§5.3). */
export interface StickyTurn {
	modelId: string;
	routeId: string | null;
	substitutedFrom: string | null;
	createdAt: string;
}

/**
 * Compute the sticky window end for a turn (§5.3):
 * `created_at + max(route.cache_ttl_ms, 5m)`. `cacheTtlMs` is the advertised
 * TTL of the route that served the turn (null when unknown → the 5m floor).
 */
export function stickyUntilMs(createdAtIso: string, cacheTtlMs: number | null): number {
	const base = new Date(createdAtIso).getTime();
	const window = Math.max(cacheTtlMs ?? 0, STICKY_MIN_WINDOW_MS);
	return base + window;
}

/** Outcome of the thread-sticky resolution step (§5.3). */
export type StickyDecision =
	| {
			/** Reuse the thread's prior route directly — it is eligible and warm. */
			kind: "sticky";
			routeId: string;
	  }
	| {
			/** No sticky route applies — select from the ranked list starting at #1. */
			kind: "ranked";
			/** Why stickiness did not apply (for logging/tests). */
			reason: "no-prior-turn" | "different-model" | "route-ineligible" | "window-cold";
	  };

/**
 * Decide whether a thread stays on its prior turn's route (§5.3).
 *
 * The caller supplies the thread's latest ok turn (or null), the logical model
 * the upcoming turn targets, the set of currently-eligible RouteIds (live,
 * healthy, not drained, meeting the turn's capability requirements), a lookup
 * of each eligible route's advertised cache TTL, and `now`.
 *
 * Stickiness holds when the prior turn targeted the same logical model (or
 * carried a refusal substitution the operator has not cleared), its route is
 * still eligible, and `now < sticky_until`. Otherwise the caller selects from
 * the ranked list.
 */
export function resolveStickyRoute(input: {
	priorTurn: StickyTurn | null;
	requestedModel: string;
	eligibleRouteIds: ReadonlySet<string>;
	cacheTtlMsByRoute: (routeId: string) => number | null;
	nowMs: number;
}): StickyDecision {
	const { priorTurn, requestedModel, eligibleRouteIds, cacheTtlMsByRoute, nowMs } = input;
	if (!priorTurn || !priorTurn.routeId) {
		return { kind: "ranked", reason: "no-prior-turn" };
	}

	// The prior turn applies to this request when it served the same logical
	// model, or when it carried a refusal substitution still targeting the same
	// originally-requested model (sticky substitution persists until cleared).
	const servedSameModel = priorTurn.modelId === requestedModel;
	const inheritsSubstitution =
		priorTurn.substitutedFrom !== null && priorTurn.substitutedFrom === requestedModel;
	if (!servedSameModel && !inheritsSubstitution) {
		return { kind: "ranked", reason: "different-model" };
	}

	// If the prior route is no longer advertised or eligible, skip it immediately.
	if (!eligibleRouteIds.has(priorTurn.routeId)) {
		return { kind: "ranked", reason: "route-ineligible" };
	}

	const until = stickyUntilMs(priorTurn.createdAt, cacheTtlMsByRoute(priorTurn.routeId));
	if (nowMs >= until) {
		return { kind: "ranked", reason: "window-cold" };
	}

	return { kind: "sticky", routeId: priorTurn.routeId };
}

/**
 * A parsed hard route pin (§5.4). The `model_hint` carrier encodes a pin as
 * `logical_model@RouteId` (the decision recorded for this slice): a thread,
 * task, or aux invocation whose effective model hint contains an `@` pins the
 * segment after it as the sole candidate RouteId, disabling both failover and
 * refusal substitution so any error surfaces raw.
 */
export interface RoutePin {
	/** Logical model requested (the part before `@`), or null when the hint is `@RouteId`. */
	logicalModel: string | null;
	/** The pinned `RouteId` — the only route selection may consider. */
	routeId: string;
}

/**
 * Parse a `model_hint` into its logical model and optional hard pin.
 *
 * A RouteId is `${siteId}:${provider}:${backendId}` — it contains colons but
 * never an `@`, and a logical model id never contains `@`, so `@` is an
 * unambiguous pin separator. `"opus@site-a:bedrock:opus"` pins; `"opus"` and
 * `"default"` do not. A leading `@` (`"@site-a:bedrock:opus"`) pins a route
 * with no explicit logical model (the route's own logical model applies).
 */
export function parseModelHint(hint: string | undefined): {
	logicalModel: string | undefined;
	pin: RoutePin | null;
} {
	if (!hint) return { logicalModel: hint, pin: null };
	const at = hint.indexOf("@");
	if (at === -1) return { logicalModel: hint, pin: null };
	const before = hint.slice(0, at);
	const routeId = hint.slice(at + 1);
	if (routeId.length === 0) {
		// Trailing `@` with no RouteId — treat as a plain (malformed) model hint.
		return { logicalModel: before.length > 0 ? before : undefined, pin: null };
	}
	const logicalModel = before.length > 0 ? before : null;
	return {
		logicalModel: logicalModel ?? undefined,
		pin: { logicalModel, routeId },
	};
}

// --- Thin DB-read wrappers (the only impure surface) -----------------------

/** Set of every currently-drained RouteId (deleted = 0). */
export function loadDrainedRouteIds(db: Database): Set<string> {
	return new Set(listDrainedRouteIds(db));
}

/** True when `routeId` is drained (§6.2). */
export function isRouteDrained(db: Database, routeId: string): boolean {
	return findRouteDrain(db, routeId) !== null;
}

/** The per-model `route_order` (parsed RouteId[]), or null when unset/invalid. */
export function loadRouteOrder(db: Database, logicalModel: string): string[] | null {
	const rule = findModelRoutingRule(db, logicalModel);
	if (!rule || rule.route_order === null) return null;
	try {
		const parsed = JSON.parse(rule.route_order);
		if (Array.isArray(parsed) && parsed.every((x) => typeof x === "string")) {
			return parsed as string[];
		}
	} catch {
		// Malformed route_order JSON — treat as unset (dormant no-op).
	}
	return null;
}
