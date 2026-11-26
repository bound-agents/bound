import type { Database } from "bun:sqlite";
import { listHostSiteIdNameAndModels } from "@bound/core";
import { type HostModelEntry, hostModelsSchema, parseJsonSafe } from "@bound/shared";

/** One advertised route for a logical model, with supply + drain + health. */
export interface RouteSupply {
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
	/** Operator reason recorded with the drain, or null. */
	drain_reason?: string | null;
	/** ISO time the route was drained, or null. */
	drained_at?: string | null;
	/** `healthy` | `backoff` | `half_open` as observed by the serving host, else `unknown`. */
	health: "healthy" | "backoff" | "half_open" | "unknown";
	/** Epoch-ms of the next half-open trial when `health === "backoff"`, else null. */
	next_trial_at: number | null;
	/** Where `health` came from: this host's router, the serving peer's snapshot, or none. */
	health_source: "local" | "remote" | null;
	/** Epoch-ms (this host's clock) when the health observation was taken, or null. */
	health_observed_at: number | null;
}

/**
 * The precedence tier a route's advertised display name came from. A route that
 * advertises a `display_name` distinct from its own `provider_model_id` was named
 * by a real source (provider or models.dev); one equal to its id fell through to
 * the id fallback. This drives the per-model display-name consistency rule.
 */
export type DisplayNameSource = "named" | "id-fallback" | "none";

/**
 * Choose the single display name for a logical model whose routes may disagree.
 * RULE: prefer a route named by a real source (`named`) over one that fell back
 * to its provider model id (`id-fallback`); within the same tier, break ties by
 * the lexically-least `provider_model_id` so the choice is deterministic and
 * host-independent (never keyed on RouteId or site id, which are internal). When
 * no route advertises a name, fall back to the logical model id itself.
 */
export function resolveModelDisplayName(
	logical: string,
	routes: Array<
		Pick<RouteSupply, "display_name" | "display_name_source" | "provider_model_id" | "route_id">
	>,
): string {
	const rank = (s: DisplayNameSource): number => (s === "named" ? 0 : s === "id-fallback" ? 1 : 2);
	let best: (typeof routes)[number] | null = null;
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

/**
 * Disambiguate logical models that would otherwise share one display name
 * (e.g. dated snapshots `gpt-4o-2024-08-06` and `gpt-4o-2024-11-20`, both
 * "GPT-4o"). Only colliding names change: each gets its snapshot suffix — a
 * `YYYY-MM-DD` date, a `preview` tag, else its provider model id. A model whose
 * id carries no snapshot suffix keeps the bare name.
 */
export function disambiguateDisplayNames<
	T extends {
		logical_model: string;
		display_name: string;
		routes: Array<{ provider_model_id: string | null }>;
	},
>(models: T[]): void {
	const groups = new Map<string, T[]>();
	for (const m of models) {
		const key = m.display_name.toLowerCase();
		const list = groups.get(key) ?? [];
		list.push(m);
		groups.set(key, list);
	}
	for (const list of groups.values()) {
		if (list.length < 2) continue;
		for (const m of list) {
			const ids = m.routes.map((r) => r.provider_model_id).filter((x): x is string => !!x);
			const id = ids.sort()[0] ?? m.logical_model;
			const date = /(\d{4}-\d{2}-\d{2})/.exec(id)?.[1];
			const suffix = date ?? (/preview/i.test(id) ? "preview" : null);
			if (suffix) m.display_name = `${m.display_name} (${suffix})`;
		}
		// Anything still colliding after snapshot suffixes falls back to its id.
		const seen = new Map<string, number>();
		for (const m of list) seen.set(m.display_name, (seen.get(m.display_name) ?? 0) + 1);
		for (const m of list) {
			if ((seen.get(m.display_name) ?? 0) < 2) continue;
			const id = m.routes.map((r) => r.provider_model_id).find((x) => !!x) ?? m.logical_model;
			if (m.display_name.toLowerCase() !== id.toLowerCase())
				m.display_name = `${m.display_name} (${id})`;
		}
	}
}

/**
 * Collect every advertised route grouped by logical model from `hosts.models`.
 * The route's `provider` is the middle segment of its RouteId
 * (`${siteId}:${provider}:${backendId}`) when present, else the entry's own
 * provider hint, else null.
 */
export function collectSupply(db: Database): Map<string, RouteSupply[]> {
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
				health_source: null,
				health_observed_at: null,
			});
			byModel.set(logical, list);
		}
	}
	return byModel;
}
