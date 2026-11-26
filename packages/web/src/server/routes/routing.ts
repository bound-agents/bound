/**
 * Settings › Models server surface (2026-11-21-model-routing.md §9.3,
 * 2026-11-21-model-catalog.md §9). This route backs the operator page that
 * manages cluster-synced routing PREFERENCES — route priority per logical
 * model, operator drains, refusal-fallback policy, cluster default fallback
 * list + roles, and alias overrides — against the read-only per-host route
 * SUPPLY advertised in `hosts.models`.
 *
 * Health is per-host and NOT synced: each host's {@link ModelRouter} keeps its
 * own in-memory `RouteHealth` registry. The assembly reads the local router for
 * routes this host serves, and asks every other live host for ITS snapshot over
 * the authenticated `route_health` durable-work kind ({@link RelayRouteHealth}).
 * Remote snapshots are observational only: they are cached in memory here for
 * display, never written to the circuit breaker, routing preferences, or
 * `hosts.models`. A route reports `"unknown"` when no fresh observation exists —
 * the peer is not live, did not answer in time, does not report that route, or
 * its last answer is older than the snapshot age limit. A fresh heartbeat never
 * stands in for an observation.
 *
 * All preference writes go through the change-log outbox (invariant #1): the
 * three tables are synced LWW, so an edit on any host propagates cluster-wide.
 */

import type { Database } from "bun:sqlite";
import {
	analyzeModelReferences,
	findClusterConfigKeyByKey,
	findClusterConfigValueByKey,
	findModelAliasIncludingDeleted,
	findModelRoutingRule,
	findModelRoutingRuleIncludingDeleted,
	findRouteDrainIncludingDeleted,
	getSiteId,
	insertRow,
	isHostFresh,
	listHostSiteIdNameAndModels,
	listHostsWithLiveness,
	listModelAliases,
	listModelRoutingRules,
	listRouteDrains,
	softDelete,
	updateRow,
} from "@bound/core";
import { type ModelRouter, normalizeModelKey } from "@bound/llm";
import {
	type ModelFallbackPolicy,
	ROUTING_DEFAULT_FALLBACK_MODELS_KEY,
	ROUTING_MODEL_ROLES_KEY,
	type RouteHealthSnapshot,
	isValidModelRoleName,
} from "@bound/shared";
import { Hono } from "hono";
import {
	type RouteSupply,
	collectSupply,
	disambiguateDisplayNames,
	resolveModelDisplayName,
} from "../lib/model-supply";

/**
 * A dormant `route_order` entry whose RouteId is advertised nowhere. The UI
 * labels it by host name and provider parsed from the RouteId, never by the
 * RouteId itself; `route_id` is kept only as the removal key.
 */
interface StaleRoute {
	route_id: string;
	/** Host name for the RouteId's site, or null when no hosts row knows it. */
	host_name: string | null;
	provider: string | null;
}

/** The per-model block the Settings page renders. */
interface ModelSettings {
	logical_model: string;
	/**
	 * The one user-facing name for this logical model (spec §2.1). Chosen across
	 * routes by {@link resolveModelDisplayName} so the UI never shows the internal
	 * grouping key; falls back to the logical model id only when no route names it.
	 */
	display_name: string;
	route_order: string[] | null;
	fallback_policy: ModelFallbackPolicy;
	routes: RouteSupply[];
	stale_routes: StaleRoute[];
}

function parseFallbackPolicy(raw: string | null): ModelFallbackPolicy {
	if (!raw) return { mode: "auto" };
	try {
		const parsed = JSON.parse(raw) as ModelFallbackPolicy;
		if (parsed && (parsed.mode === "auto" || parsed.mode === "never" || parsed.mode === "custom")) {
			return parsed;
		}
	} catch {
		// fall through
	}
	return { mode: "auto" };
}

function parseRouteOrder(raw: string | null): string[] | null {
	if (!raw) return null;
	try {
		const parsed = JSON.parse(raw);
		if (Array.isArray(parsed) && parsed.every((x) => typeof x === "string")) return parsed;
	} catch {
		// fall through
	}
	return null;
}

/** Validate a client-supplied fallback policy; null when the payload is malformed. */
function validateFallbackPolicy(body: unknown): ModelFallbackPolicy | null {
	if (!body || typeof body !== "object") return null;
	const mode = (body as { mode?: unknown }).mode;
	if (mode === "auto") return { mode: "auto" };
	if (mode === "never") return { mode: "never" };
	if (mode === "custom") {
		const models = (body as { models?: unknown }).models;
		if (!Array.isArray(models) || !models.every((m) => typeof m === "string")) return null;
		return { mode: "custom", models };
	}
	return null;
}

/**
 * Local health for a RouteId via the router, or `"unknown"` when the router has
 * no backend with that RouteId (remote-only route, or no router handle).
 */
function localHealth(
	router: ModelRouter | null,
	routeId: string,
): { health: RouteSupply["health"]; next_trial_at: number | null } {
	if (!router) return { health: "unknown", next_trial_at: null };
	for (const backend of router.listBackends()) {
		if (router.getRouteId(backend.id) !== routeId) continue;
		const state = router.getRouteHealthState(backend.id);
		if (state.status === "backoff") {
			return { health: "backoff", next_trial_at: state.next_trial_at };
		}
		return { health: state.status, next_trial_at: null };
	}
	return { health: "unknown", next_trial_at: null };
}

/**
 * Ask `targetSiteId` for its own route-health snapshot, bounded by `timeoutMs`.
 * Wired from the CLI start path over the `route_health` durable-work kind.
 * Throws on any failure; the caller reports the peer's routes as `unknown`.
 */
export type RelayRouteHealth = (
	targetSiteId: string,
	timeoutMs: number,
) => Promise<RouteHealthSnapshot>;

export interface RoutingRoutesOptions {
	/** Peer snapshot reader. Absent → every remote route reports `unknown`. */
	relayRouteHealth?: RelayRouteHealth;
	/** Injectable clock for tests. */
	clock?: () => number;
	/** Per-peer request bound. */
	remoteTimeoutMs?: number;
	/** A snapshot younger than this is reused instead of asking the peer again. */
	snapshotReuseMs?: number;
	/** A snapshot older than this is discarded; its routes report `unknown`. */
	snapshotMaxAgeMs?: number;
	/** Peers whose heartbeat is older than this are not asked (they cannot answer). */
	hostLivenessMs?: number;
}

/** Default per-peer request bound for a routing snapshot. */
export const REMOTE_HEALTH_TIMEOUT_MS = 4_000;
/** Default reuse window for a peer snapshot. */
export const REMOTE_HEALTH_REUSE_MS = 15_000;
/** Default maximum age of a peer snapshot before its routes read `unknown`. */
export const REMOTE_HEALTH_MAX_AGE_MS = 60_000;
/** Matches the relay router's liveness threshold (spec R-RT8). */
export const REMOTE_HEALTH_HOST_LIVENESS_MS = 5 * 60_000;

interface ObservedRouteHealth {
	health: "healthy" | "backoff" | "half_open";
	next_trial_at: number | null;
}

interface PeerObservation {
	/** Receipt time on THIS host's clock. */
	observedAt: number;
	routes: Map<string, ObservedRouteHealth>;
}

/**
 * In-memory, display-only cache of peer route-health snapshots. One request per
 * peer is in flight at a time; concurrent page loads share it. A peer is asked
 * at most once per `reuseMs`, measured from the last attempt whether it
 * succeeded, failed, or timed out, so an unreachable peer costs one relay per
 * window rather than one per page load. Failures keep the previous observation,
 * which still ages out at `maxAgeMs`.
 */
class PeerHealthCache {
	private observations = new Map<string, PeerObservation>();
	private lastAttemptAt = new Map<string, number>();
	private inflight = new Map<string, Promise<void>>();

	constructor(
		private relay: RelayRouteHealth,
		private clock: () => number,
		private timeoutMs: number,
		private reuseMs: number,
		private maxAgeMs: number,
	) {}

	async collect(siteIds: Iterable<string>): Promise<Map<string, PeerObservation>> {
		const ids = [...siteIds];
		const pending: Promise<void>[] = [];
		for (const id of ids) {
			const existing = this.inflight.get(id);
			if (existing) {
				pending.push(existing);
				continue;
			}
			const attemptedAt = this.lastAttemptAt.get(id);
			if (attemptedAt !== undefined && this.clock() - attemptedAt < this.reuseMs) continue;
			pending.push(this.refresh(id));
		}
		await Promise.all(pending);
		const now = this.clock();
		const out = new Map<string, PeerObservation>();
		for (const id of ids) {
			const obs = this.observations.get(id);
			if (obs && now - obs.observedAt <= this.maxAgeMs) out.set(id, obs);
		}
		return out;
	}

	private refresh(siteId: string): Promise<void> {
		const existing = this.inflight.get(siteId);
		if (existing) return existing;
		this.lastAttemptAt.set(siteId, this.clock());
		const run = (async () => {
			let timer: ReturnType<typeof setTimeout> | undefined;
			try {
				const snapshot = await Promise.race([
					this.relay(siteId, this.timeoutMs),
					new Promise<never>((_, reject) => {
						timer = setTimeout(
							() => reject(new Error("route_health timeout")),
							this.timeoutMs + 250,
						);
					}),
				]);
				const observedAt = this.clock();
				const routes = new Map<string, ObservedRouteHealth>();
				for (const r of snapshot.routes) {
					routes.set(r.route_id, {
						health: r.status,
						next_trial_at:
							r.status === "backoff" && r.next_trial_in_ms !== null
								? observedAt + r.next_trial_in_ms
								: null,
					});
				}
				this.observations.set(siteId, { observedAt, routes });
			} catch {
				// Unavailable peer: keep the previous observation; it ages out on its own.
			} finally {
				if (timer) clearTimeout(timer);
				this.inflight.delete(siteId);
			}
		})();
		this.inflight.set(siteId, run);
		return run;
	}
}

export function createRoutingRoutes(
	db: Database,
	siteId: string,
	modelRouter: ModelRouter | null,
	options: RoutingRoutesOptions = {},
) {
	const clock = options.clock ?? Date.now;
	const hostLivenessMs = options.hostLivenessMs ?? REMOTE_HEALTH_HOST_LIVENESS_MS;
	const peerHealth = options.relayRouteHealth
		? new PeerHealthCache(
				options.relayRouteHealth,
				clock,
				options.remoteTimeoutMs ?? REMOTE_HEALTH_TIMEOUT_MS,
				options.snapshotReuseMs ?? REMOTE_HEALTH_REUSE_MS,
				options.snapshotMaxAgeMs ?? REMOTE_HEALTH_MAX_AGE_MS,
			)
		: null;

	/** Fresh peer observations for every live remote host that advertises routes. */
	async function collectPeerHealth(
		supply: Map<string, RouteSupply[]>,
	): Promise<Map<string, PeerObservation>> {
		if (!peerHealth) return new Map();
		const localSite = resolveSiteId();
		const advertising = new Set<string>();
		for (const routes of supply.values()) {
			for (const r of routes) if (r.site_id !== localSite) advertising.add(r.site_id);
		}
		const now = clock();
		const live = listHostsWithLiveness(db)
			.filter((h) => advertising.has(h.site_id) && isHostFresh(h, now, hostLivenessMs))
			.map((h) => h.site_id);
		return peerHealth.collect(live);
	}

	function resolveSiteId(): string {
		return siteId || getSiteId(db);
	}

	// Upsert a model_routing_rules row, carrying forward the untouched column.
	function upsertRule(
		logical: string,
		patch: { route_order?: string | null; fallback_policy?: string | null },
	): void {
		const site = resolveSiteId();
		const existing = findModelRoutingRuleIncludingDeleted(db, logical);
		if (existing) {
			updateRow(db, "model_routing_rules", logical, { ...patch, deleted: 0 }, site);
		} else {
			insertRow(
				db,
				"model_routing_rules",
				{
					logical_model: logical,
					route_order: patch.route_order ?? null,
					fallback_policy: patch.fallback_policy ?? null,
					deleted: 0,
					modified_at: new Date().toISOString(),
				},
				site,
			);
		}
	}

	// Upsert a cluster_config JSON row, un-tombstoning a soft-deleted key.
	function upsertClusterConfig(key: string, value: unknown): void {
		const site = resolveSiteId();
		if (findClusterConfigKeyByKey(db, key)) {
			updateRow(db, "cluster_config", key, { value: JSON.stringify(value), deleted: 0 }, site);
		} else {
			insertRow(
				db,
				"cluster_config",
				{ key, value: JSON.stringify(value), modified_at: new Date().toISOString(), deleted: 0 },
				site,
			);
		}
	}
	const app = new Hono()

		// GET /models — the full Settings › Models assembly.
		.get("/models", async (c) => {
			try {
				const supply = collectSupply(db);
				const peers = await collectPeerHealth(supply);
				const localSite = resolveSiteId();
				const drainRows = new Map(listRouteDrains(db).map((d) => [d.route_id, d]));
				const rules = new Map(listModelRoutingRules(db).map((r) => [r.logical_model, r]));
				const report = analyzeModelReferences(db, normalizeModelKey);
				const staleByModel = new Map<string, StaleRoute[]>();
				const hostNameBySite = new Map(
					listHostSiteIdNameAndModels(db).map((h) => [h.site_id, h.host_name]),
				);
				for (const s of report.staleRouteOrderEntries) {
					const list = staleByModel.get(s.logicalModel) ?? [];
					const [siteId, provider] = s.routeId.split(":");
					list.push({
						route_id: s.routeId,
						host_name: (siteId && hostNameBySite.get(siteId)) || null,
						provider: provider || null,
					});
					staleByModel.set(s.logicalModel, list);
				}

				// The union of logical models that either have supply or carry a rule.
				const models = new Set<string>([...supply.keys(), ...rules.keys()]);
				const out: ModelSettings[] = [];
				for (const logical of models) {
					const rule = rules.get(logical);
					const routeOrder = parseRouteOrder(rule?.route_order ?? null);
					const routes = (supply.get(logical) ?? []).map((r): RouteSupply => {
						const d = drainRows.get(r.route_id);
						const base = {
							...r,
							drained: d !== undefined,
							drain_reason: d?.reason ?? null,
							drained_at: d?.drained_at ?? null,
						};
						if (r.site_id === localSite) {
							const health = localHealth(modelRouter, r.route_id);
							return {
								...base,
								health: health.health,
								next_trial_at: health.next_trial_at,
								health_source: health.health === "unknown" ? null : "local",
								health_observed_at: health.health === "unknown" ? null : clock(),
							};
						}
						const peer = peers.get(r.site_id);
						const observed = peer?.routes.get(r.route_id);
						if (!peer || !observed) return base;
						return {
							...base,
							health: observed.health,
							next_trial_at: observed.next_trial_at,
							health_source: "remote",
							health_observed_at: peer.observedAt,
						};
					});
					// Order routes by the model's declared route_order; unordered routes
					// fall to the end, local-before-remote then lexicographical by RouteId
					// (mirrors the router's default ranking, §5.2). With no route_order the
					// whole list follows the default tie-break.
					const rank = new Map((routeOrder ?? []).map((id, i) => [id, i]));
					routes.sort((a, b) => {
						const ra = rank.get(a.route_id) ?? Number.POSITIVE_INFINITY;
						const rb = rank.get(b.route_id) ?? Number.POSITIVE_INFINITY;
						if (ra !== rb) return ra - rb;
						// Tie-break: local (this host's siteId) before remote, then by RouteId.
						const aLocal = a.site_id === localSite ? 0 : 1;
						const bLocal = b.site_id === localSite ? 0 : 1;
						if (aLocal !== bLocal) return aLocal - bLocal;
						return a.route_id < b.route_id ? -1 : a.route_id > b.route_id ? 1 : 0;
					});
					out.push({
						logical_model: logical,
						display_name: resolveModelDisplayName(logical, routes),
						route_order: routeOrder,
						fallback_policy: parseFallbackPolicy(rule?.fallback_policy ?? null),
						routes,
						stale_routes: staleByModel.get(logical) ?? [],
					});
				}
				disambiguateDisplayNames(out);
				out.sort(
					(a, b) =>
						a.display_name.localeCompare(b.display_name, undefined, { sensitivity: "base" }) ||
						(a.logical_model < b.logical_model ? -1 : a.logical_model > b.logical_model ? 1 : 0),
				);
				return c.json({ models: out });
			} catch (error) {
				const message = error instanceof Error ? error.message : "Unknown error";
				return c.json({ error: "Failed to assemble routing settings", details: message }, 500);
			}
		})

		// GET /references — stale/dangling reference report for the cleanup surfaces.
		.get("/references", (c) => {
			try {
				return c.json(analyzeModelReferences(db, normalizeModelKey));
			} catch (error) {
				const message = error instanceof Error ? error.message : "Unknown error";
				return c.json({ error: "Failed to analyze references", details: message }, 500);
			}
		})

		// PUT /models/:logical/route-order — reorder a model's preferred routes.
		.put("/models/:logical/route-order", async (c) => {
			const logical = c.req.param("logical");
			let body: unknown;
			try {
				body = await c.req.json();
			} catch {
				return c.json({ error: "Invalid JSON body" }, 400);
			}
			const order = (body as { route_order?: unknown }).route_order;
			if (!Array.isArray(order) || !order.every((x) => typeof x === "string")) {
				return c.json({ error: "route_order must be an array of RouteId strings" }, 400);
			}
			const advertised = new Set((collectSupply(db).get(logical) ?? []).map((r) => r.route_id));
			const existingOrder = parseRouteOrder(findModelRoutingRule(db, logical)?.route_order ?? null);
			const known = new Set([...advertised, ...(existingOrder ?? [])]);
			const unknown = (order as string[]).find((id) => !known.has(id));
			if (unknown !== undefined) {
				return c.json({ error: `Unknown route "${unknown}" for model "${logical}"` }, 422);
			}
			try {
				upsertRule(logical, { route_order: JSON.stringify(order) });
				return c.json({ ok: true });
			} catch (error) {
				const message = error instanceof Error ? error.message : "Unknown error";
				return c.json({ error: "Failed to set route order", details: message }, 500);
			}
		})

		// PUT /models/:logical/fallback-policy — set the refusal-fallback policy.
		.put("/models/:logical/fallback-policy", async (c) => {
			const logical = c.req.param("logical");
			let body: unknown;
			try {
				body = await c.req.json();
			} catch {
				return c.json({ error: "Invalid JSON body" }, 400);
			}
			let policy = validateFallbackPolicy(body);
			if (!policy) {
				return c.json({ error: "Invalid fallback policy" }, 400);
			}
			if (policy.mode === "custom") {
				if (policy.models.includes(logical)) {
					return c.json({ error: `Model "${logical}" cannot fall back to itself` }, 422);
				}
				const prior = parseFallbackPolicy(
					findModelRoutingRule(db, logical)?.fallback_policy ?? null,
				);
				const priorModels = new Set(prior.mode === "custom" ? prior.models : []);
				const supplied = collectSupply(db);
				const unknown = policy.models.find((m) => !supplied.has(m) && !priorModels.has(m));
				if (unknown !== undefined) {
					return c.json({ error: `Unknown fallback model "${unknown}"` }, 422);
				}
				if (policy.models.length === 0) policy = { mode: "never" };
			}
			try {
				upsertRule(logical, { fallback_policy: JSON.stringify(policy) });
				return c.json({ ok: true });
			} catch (error) {
				const message = error instanceof Error ? error.message : "Unknown error";
				return c.json({ error: "Failed to set fallback policy", details: message }, 500);
			}
		})

		// POST /routes/:routeId/drain — drain a route (exclude from candidates).
		.post("/routes/:routeId/drain", async (c) => {
			const routeId = c.req.param("routeId");
			const advertised = [...collectSupply(db).values()].some((routes) =>
				routes.some((r) => r.route_id === routeId),
			);
			if (!advertised) {
				return c.json({ error: `Unknown route "${routeId}"` }, 422);
			}
			let reason: string | null = null;
			try {
				const body = (await c.req.json()) as { reason?: unknown };
				if (typeof body.reason === "string" && body.reason.trim())
					reason = body.reason.trim().slice(0, 200);
			} catch {
				// No body is fine — drain with a null reason.
			}
			try {
				const site = resolveSiteId();
				const existing = findRouteDrainIncludingDeleted(db, routeId);
				if (existing) {
					updateRow(
						db,
						"route_drains",
						routeId,
						{ drained_at: new Date().toISOString(), reason, deleted: 0 },
						site,
					);
				} else {
					insertRow(
						db,
						"route_drains",
						{
							route_id: routeId,
							drained_at: new Date().toISOString(),
							reason,
							deleted: 0,
							modified_at: new Date().toISOString(),
						},
						site,
					);
				}
				return c.json({ ok: true });
			} catch (error) {
				const message = error instanceof Error ? error.message : "Unknown error";
				return c.json({ error: "Failed to drain route", details: message }, 500);
			}
		})

		// DELETE /routes/:routeId/drain — un-drain (re-enable) a route.
		.delete("/routes/:routeId/drain", (c) => {
			const routeId = c.req.param("routeId");
			try {
				if (findRouteDrainIncludingDeleted(db, routeId)) {
					softDelete(db, "route_drains", routeId, resolveSiteId());
				}
				return c.json({ ok: true });
			} catch (error) {
				const message = error instanceof Error ? error.message : "Unknown error";
				return c.json({ error: "Failed to un-drain route", details: message }, 500);
			}
		})

		// PUT /aliases/:providerKey — assign (or deliberately ungroup) a provider model.
		.put("/aliases/:providerKey", async (c) => {
			const providerKey = c.req.param("providerKey");
			let body: unknown;
			try {
				body = await c.req.json();
			} catch {
				return c.json({ error: "Invalid JSON body" }, 400);
			}
			const logical = (body as { logical_model?: unknown }).logical_model;
			// null is a valid, deliberate "keep ungrouped" mapping; a string assigns it.
			if (logical !== null && typeof logical !== "string") {
				return c.json({ error: "logical_model must be a string or null" }, 400);
			}
			try {
				const site = resolveSiteId();
				const existing = findModelAliasIncludingDeleted(db, providerKey);
				if (existing) {
					updateRow(db, "model_aliases", providerKey, { logical_model: logical, deleted: 0 }, site);
				} else {
					insertRow(
						db,
						"model_aliases",
						{
							provider_key: providerKey,
							logical_model: logical,
							deleted: 0,
							modified_at: new Date().toISOString(),
						},
						site,
					);
				}
				return c.json({ ok: true });
			} catch (error) {
				const message = error instanceof Error ? error.message : "Unknown error";
				return c.json({ error: "Failed to set alias", details: message }, 500);
			}
		})

		// DELETE /aliases/:providerKey — clear an alias override.
		.delete("/aliases/:providerKey", (c) => {
			const providerKey = c.req.param("providerKey");
			try {
				if (findModelAliasIncludingDeleted(db, providerKey)) {
					softDelete(db, "model_aliases", providerKey, resolveSiteId());
				}
				return c.json({ ok: true });
			} catch (error) {
				const message = error instanceof Error ? error.message : "Unknown error";
				return c.json({ error: "Failed to clear alias", details: message }, 500);
			}
		})

		// PUT /cluster-defaults — the cluster default fallback list + model roles.
		.put("/cluster-defaults", async (c) => {
			let body: unknown;
			try {
				body = await c.req.json();
			} catch {
				return c.json({ error: "Invalid JSON body" }, 400);
			}
			const fallback = (body as { default_fallback_models?: unknown }).default_fallback_models;
			const roles = (body as { roles?: unknown }).roles;
			if (fallback !== undefined) {
				if (!Array.isArray(fallback) || !fallback.every((m) => typeof m === "string")) {
					return c.json({ error: "default_fallback_models must be an array of strings" }, 400);
				}
			}
			if (roles !== undefined) {
				if (typeof roles !== "object" || roles === null || Array.isArray(roles)) {
					return c.json({ error: "roles must be an object" }, 400);
				}
				// Every entry is a cluster-wide name → logical model (§2.1, #281): the three
				// reserved roles and operator-named aliases share this map. Names must be
				// non-empty and free of the `@` RouteId-pin syntax; targets must be strings.
				for (const [name, target] of Object.entries(roles as Record<string, unknown>)) {
					if (!isValidModelRoleName(name)) {
						return c.json(
							{ error: `Invalid role/alias name "${name}": must be non-empty and contain no '@'` },
							400,
						);
					}
					if (typeof target !== "string") {
						return c.json(
							{ error: `Role/alias "${name}" must map to a string logical model` },
							400,
						);
					}
				}
			}
			if (fallback !== undefined || roles !== undefined) {
				const supplied = collectSupply(db);
				const parseStored = (key: string): unknown => {
					try {
						const raw = findClusterConfigValueByKey(db, key)?.value;
						return raw ? JSON.parse(raw) : null;
					} catch {
						return null;
					}
				};
				if (roles !== undefined) {
					const stored = (parseStored(ROUTING_MODEL_ROLES_KEY) ?? {}) as Record<string, unknown>;
					for (const [name, target] of Object.entries(roles as Record<string, string>)) {
						if (target === "" || supplied.has(target) || stored[name] === target) continue;
						return c.json({ error: `Role/alias "${name}" targets unknown model "${target}"` }, 422);
					}
				}
				if (fallback !== undefined) {
					const stored = parseStored(ROUTING_DEFAULT_FALLBACK_MODELS_KEY);
					const prior = new Set(Array.isArray(stored) ? stored : []);
					const unknown = (fallback as string[]).find((m) => !supplied.has(m) && !prior.has(m));
					if (unknown !== undefined) {
						return c.json({ error: `Unknown default fallback model "${unknown}"` }, 422);
					}
				}
			}
			try {
				if (fallback !== undefined) {
					upsertClusterConfig(ROUTING_DEFAULT_FALLBACK_MODELS_KEY, fallback);
				}
				if (roles !== undefined) {
					upsertClusterConfig(ROUTING_MODEL_ROLES_KEY, roles);
				}
				return c.json({ ok: true });
			} catch (error) {
				const message = error instanceof Error ? error.message : "Unknown error";
				return c.json({ error: "Failed to set cluster defaults", details: message }, 500);
			}
		})

		// GET /cluster-defaults — the current default fallback list + roles + aliases.
		.get("/cluster-defaults", (c) => {
			try {
				const fbRow = findClusterConfigValueByKey(db, ROUTING_DEFAULT_FALLBACK_MODELS_KEY);
				const rolesRow = findClusterConfigValueByKey(db, ROUTING_MODEL_ROLES_KEY);
				const parse = (raw: string | undefined): unknown => {
					if (!raw) return null;
					try {
						return JSON.parse(raw);
					} catch {
						return null;
					}
				};
				return c.json({
					default_fallback_models: parse(fbRow?.value) ?? [],
					roles: parse(rolesRow?.value) ?? {},
					aliases: listModelAliases(db).map((a) => ({
						provider_key: a.provider_key,
						logical_model: a.logical_model,
					})),
				});
			} catch (error) {
				const message = error instanceof Error ? error.message : "Unknown error";
				return c.json({ error: "Failed to read cluster defaults", details: message }, 500);
			}
		});

	return app;
}
