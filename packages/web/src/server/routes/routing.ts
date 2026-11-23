import type { Database } from "bun:sqlite";
import {
	analyzeModelReferences,
	findClusterConfigKeyByKey,
	findClusterConfigValueByKey,
	findModelAliasIncludingDeleted,
	findModelRoutingRuleIncludingDeleted,
	findRouteDrainIncludingDeleted,
	getSiteId,
	insertRow,
	listDrainedRouteIds,
	listHostSiteIdNameAndModels,
	listModelAliases,
	listModelRoutingRules,
	softDelete,
	updateRow,
} from "@bound/core";
import type { ModelRouter } from "@bound/llm";
import {
	type HostModelEntry,
	type ModelFallbackPolicy,
	ROUTING_DEFAULT_FALLBACK_MODELS_KEY,
	ROUTING_MODEL_ROLES_KEY,
	hostModelsSchema,
	parseJsonSafe,
} from "@bound/shared";
import { Hono } from "hono";

/**
 * Settings › Models server surface (2026-11-21-model-routing.md §9.3,
 * 2026-11-21-model-catalog.md §9). This route backs the operator page that
 * manages cluster-synced routing PREFERENCES — route priority per logical
 * model, operator drains, refusal-fallback policy, cluster default fallback
 * list + roles, and alias overrides — against the read-only per-host route
 * SUPPLY advertised in `hosts.models`.
 *
 * Health is per-host and NOT synced: it lives in the local {@link ModelRouter}'s
 * in-memory `RouteHealth` registry. The assembly folds in the local router's
 * snapshot for routes it serves; a route advertised only by a remote host
 * reports health `"unknown"` because this host cannot observe it. That is a
 * genuine host-boundary limit, surfaced honestly rather than guessed.
 *
 * All preference writes go through the change-log outbox (invariant #1): the
 * three tables are synced LWW, so an edit on any host propagates cluster-wide.
 */

/** One advertised route for a logical model, with supply + drain + health. */
interface RouteSupply {
	route_id: string;
	site_id: string;
	host_name: string;
	provider: string | null;
	/** This route's user-facing display name (spec §2.1), or null when unadvertised. */
	display_name: string | null;
	/** The raw provider model id, used as the tie-breaker for the per-model display name. */
	provider_model_id: string | null;
	/** Which metadata source the display name came from, for the per-model consistency rule. */
	display_name_source: DisplayNameSource;
	drained: boolean;
	/** `healthy` | `backoff` | `half_open` from the local router, else `unknown` (remote). */
	health: "healthy" | "backoff" | "half_open" | "unknown";
	/** Epoch-ms of the next half-open trial when `health === "backoff"`, else null. */
	next_trial_at: number | null;
}

/**
 * The precedence tier a route's advertised display name came from. A route that
 * advertises a `display_name` distinct from its own `provider_model_id` was named
 * by a real source (provider or models.dev); one equal to its id fell through to
 * the id fallback. This drives the per-model display-name consistency rule.
 */
type DisplayNameSource = "named" | "id-fallback" | "none";

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

/**
 * Choose the single display name for a logical model whose routes may disagree.
 * RULE: prefer a route named by a real source (`named`) over one that fell back
 * to its provider model id (`id-fallback`); within the same tier, break ties by
 * the lexically-least `provider_model_id` so the choice is deterministic and
 * host-independent (never keyed on RouteId or site id, which are internal). When
 * no route advertises a name, fall back to the logical model id itself.
 */
function resolveModelDisplayName(logical: string, routes: RouteSupply[]): string {
	const rank = (s: DisplayNameSource): number => (s === "named" ? 0 : s === "id-fallback" ? 1 : 2);
	let best: RouteSupply | null = null;
	for (const r of routes) {
		if (r.display_name === null) continue;
		if (best === null) {
			best = r;
			continue;
		}
		const cmp = rank(r.display_name_source) - rank(best.display_name_source);
		if (cmp < 0) {
			best = r;
		} else if (cmp === 0) {
			const ra = r.provider_model_id ?? r.route_id;
			const rb = best.provider_model_id ?? best.route_id;
			if (ra < rb) best = r;
		}
	}
	return best?.display_name ?? logical;
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
 * Collect every advertised route grouped by logical model from `hosts.models`.
 * The route's `provider` is the middle segment of its RouteId
 * (`${siteId}:${provider}:${backendId}`) when present, else the entry's own
 * provider hint, else null.
 */
function collectSupply(db: Database): Map<string, RouteSupply[]> {
	const byModel = new Map<string, RouteSupply[]>();
	for (const host of listHostSiteIdNameAndModels(db)) {
		if (host.models === null) continue;
		const parsed = parseJsonSafe(hostModelsSchema, host.models, "host.models");
		if (!parsed.ok) continue;
		for (const raw of parsed.value) {
			const entry: HostModelEntry = typeof raw === "string" ? { id: raw } : raw;
			const logical = entry.logical_model ?? entry.id;
			const routeId = entry.route_id ?? `${host.site_id}:unknown:${entry.id}`;
			const provider = routeId.split(":")[1] ?? null;
			const providerModelId = entry.provider_model_id ?? null;
			// A display name equal to the raw provider model id means the catalog fell
			// through to the id fallback (no provider/registry name); treat that as a
			// weaker source than a real name so a sibling route's real name wins.
			const displayName = entry.display_name ?? null;
			const displayNameSource: DisplayNameSource =
				displayName === null ? "none" : displayName === providerModelId ? "id-fallback" : "named";
			const list = byModel.get(logical) ?? [];
			list.push({
				route_id: routeId,
				site_id: host.site_id,
				host_name: host.host_name,
				provider,
				display_name: displayName,
				provider_model_id: providerModelId,
				display_name_source: displayNameSource,
				drained: false,
				health: "unknown",
				next_trial_at: null,
			});
			byModel.set(logical, list);
		}
	}
	return byModel;
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

export function createRoutingRoutes(
	db: Database,
	siteId: string,
	modelRouter: ModelRouter | null,
): Hono {
	const app = new Hono();

	function resolveSiteId(): string {
		return siteId || getSiteId(db);
	}

	// GET /models — the full Settings › Models assembly.
	app.get("/models", (c) => {
		try {
			const supply = collectSupply(db);
			const drained = new Set(listDrainedRouteIds(db));
			const rules = new Map(listModelRoutingRules(db).map((r) => [r.logical_model, r]));
			const report = analyzeModelReferences(db);
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
				const routes = (supply.get(logical) ?? []).map((r) => {
					const health = localHealth(modelRouter, r.route_id);
					return {
						...r,
						drained: drained.has(r.route_id),
						health: health.health,
						next_trial_at: health.next_trial_at,
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
					const aLocal = a.site_id === siteId ? 0 : 1;
					const bLocal = b.site_id === siteId ? 0 : 1;
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
			out.sort((a, b) => (a.logical_model < b.logical_model ? -1 : 1));
			return c.json({ models: out });
		} catch (error) {
			const message = error instanceof Error ? error.message : "Unknown error";
			return c.json({ error: "Failed to assemble routing settings", details: message }, 500);
		}
	});

	// GET /references — stale/dangling reference report for the cleanup surfaces.
	app.get("/references", (c) => {
		try {
			return c.json(analyzeModelReferences(db));
		} catch (error) {
			const message = error instanceof Error ? error.message : "Unknown error";
			return c.json({ error: "Failed to analyze references", details: message }, 500);
		}
	});

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

	// PUT /models/:logical/route-order — reorder a model's preferred routes.
	app.put("/models/:logical/route-order", async (c) => {
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
		try {
			upsertRule(logical, { route_order: JSON.stringify(order) });
			return c.json({ ok: true });
		} catch (error) {
			const message = error instanceof Error ? error.message : "Unknown error";
			return c.json({ error: "Failed to set route order", details: message }, 500);
		}
	});

	// PUT /models/:logical/fallback-policy — set the refusal-fallback policy.
	app.put("/models/:logical/fallback-policy", async (c) => {
		const logical = c.req.param("logical");
		let body: unknown;
		try {
			body = await c.req.json();
		} catch {
			return c.json({ error: "Invalid JSON body" }, 400);
		}
		const policy = validateFallbackPolicy(body);
		if (!policy) {
			return c.json({ error: "Invalid fallback policy" }, 400);
		}
		try {
			upsertRule(logical, { fallback_policy: JSON.stringify(policy) });
			return c.json({ ok: true });
		} catch (error) {
			const message = error instanceof Error ? error.message : "Unknown error";
			return c.json({ error: "Failed to set fallback policy", details: message }, 500);
		}
	});

	// POST /routes/:routeId/drain — drain a route (exclude from candidates).
	app.post("/routes/:routeId/drain", async (c) => {
		const routeId = c.req.param("routeId");
		let reason: string | null = null;
		try {
			const body = (await c.req.json()) as { reason?: unknown };
			if (typeof body.reason === "string") reason = body.reason;
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
	});

	// DELETE /routes/:routeId/drain — un-drain (re-enable) a route.
	app.delete("/routes/:routeId/drain", (c) => {
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
	});

	// PUT /aliases/:providerKey — assign (or deliberately ungroup) a provider model.
	app.put("/aliases/:providerKey", async (c) => {
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
	});

	// DELETE /aliases/:providerKey — clear an alias override.
	app.delete("/aliases/:providerKey", (c) => {
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
	});

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

	// PUT /cluster-defaults — the cluster default fallback list + model roles.
	app.put("/cluster-defaults", async (c) => {
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
		if (roles !== undefined && (typeof roles !== "object" || roles === null)) {
			return c.json({ error: "roles must be an object" }, 400);
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
	});

	// GET /cluster-defaults — the current default fallback list + roles + aliases.
	app.get("/cluster-defaults", (c) => {
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
