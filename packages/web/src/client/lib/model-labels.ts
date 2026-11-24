/**
 * User-facing labels for models and routes (routing spec §9, catalog spec §2.1).
 * Users never see a raw backend id, a RouteId, or the logical grouping key when
 * a display name exists. A concrete route renders as
 * `<provider-or-namespace>:<provider-model-id>`.
 */

interface RouteLike {
	route_id: string;
	provider?: string | null;
	provider_model_id?: string | null;
}

interface ModelLike {
	logical_model: string;
	display_name?: string | null;
	routes: RouteLike[];
}

export interface ParsedRouteId {
	siteId: string;
	provider: string;
	backendId: string;
}

/** Split `${siteId}:${provider}:${backendId}`; the backend id may contain ':'. */
export function parseRouteId(id: string): ParsedRouteId | null {
	const first = id.indexOf(":");
	if (first < 0) return null;
	const second = id.indexOf(":", first + 1);
	if (second < 0) return null;
	const siteId = id.slice(0, first);
	const provider = id.slice(first + 1, second);
	const backendId = id.slice(second + 1);
	if (!siteId || !provider || !backendId) return null;
	return { siteId, provider, backendId };
}

function stripPrefix(backendId: string, provider: string): string {
	const prefix = `${provider}-`;
	return backendId.startsWith(prefix) ? backendId.slice(prefix.length) : backendId;
}

export interface ModelLabels {
	routeLabel(routeIdOrBackendId: string | null | undefined): string;
	modelLabel(id: string | null | undefined): string;
}

export function buildModelLabels(models: ModelLike[]): ModelLabels {
	const routeByKey = new Map<string, string>();
	const nameByKey = new Map<string, string>();
	for (const m of models) {
		const name = m.display_name || null;
		if (name) nameByKey.set(m.logical_model, name);
		for (const r of m.routes) {
			const parsed = parseRouteId(r.route_id);
			const provider = r.provider ?? parsed?.provider ?? null;
			const backendId = parsed?.backendId ?? r.route_id;
			const pmid = r.provider_model_id ?? (provider ? stripPrefix(backendId, provider) : backendId);
			const label = provider ? `${provider}:${pmid}` : pmid;
			routeByKey.set(r.route_id, label);
			if (!routeByKey.has(backendId)) routeByKey.set(backendId, label);
			if (name) {
				nameByKey.set(r.route_id, name);
				if (!nameByKey.has(backendId)) nameByKey.set(backendId, name);
			}
		}
	}
	return {
		routeLabel(id) {
			if (!id) return "\u2014";
			const known = routeByKey.get(id);
			if (known) return known;
			const parsed = parseRouteId(id);
			if (parsed) {
				const viaBackend = routeByKey.get(parsed.backendId);
				if (viaBackend) return viaBackend;
				return `${parsed.provider}:${stripPrefix(parsed.backendId, parsed.provider)}`;
			}
			return id;
		},
		modelLabel(id) {
			if (!id) return "\u2014";
			const known = nameByKey.get(id);
			if (known) return known;
			const parsed = parseRouteId(id);
			if (parsed) return nameByKey.get(parsed.backendId) ?? parsed.backendId;
			return id;
		},
	};
}

/** Case-insensitive alphabetical comparator for display labels. */
export function compareLabels(a: string, b: string): number {
	return a.localeCompare(b, undefined, { sensitivity: "base" });
}
