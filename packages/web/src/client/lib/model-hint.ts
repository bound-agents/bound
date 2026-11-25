import { compareLabels, parseRouteId } from "./model-labels";

interface ModelEntry {
	id: string;
	logical_model?: string;
	display_name?: string;
}

interface RoutingEntry {
	logical_model: string;
	display_name?: string | null;
	routes?: Array<{ route_id: string }>;
}

/** One selector option: a logical model labelled by its display name (spec §9.1). */
export interface ModelOption {
	/** Logical model id — the selection value and the hint sent to the server. */
	id: string;
	label: string;
}

interface ResolvedModel {
	selectedModel: string;
	modelId: string;
}

/**
 * Builds one option per logical model. The routing API is authoritative when it
 * has entries; `/models` (deduped by logical model) is the fallback for older
 * servers. A label is never a backend id: display name, else the logical id.
 */
export function buildModelOptions(models: ModelEntry[], routing: RoutingEntry[]): ModelOption[] {
	const options: ModelOption[] = [];
	const seen = new Set<string>();
	const push = (id: string, name: string | null | undefined) => {
		if (seen.has(id)) return;
		seen.add(id);
		options.push({ id, label: name || id });
	};
	if (routing.length > 0) {
		for (const r of routing) push(r.logical_model, r.display_name);
	} else {
		for (const m of models) {
			const logical = m.logical_model ?? m.id;
			// A display name equal to the backend id carries no information.
			const name = m.display_name && m.display_name !== m.id ? m.display_name : undefined;
			push(logical, name);
		}
	}
	return options.sort((a, b) => compareLabels(a.label, b.label));
}

/**
 * Maps a backend id or logical id to the logical option it selects, if any.
 * Checks `/models` rows and every routing route's backend id: a remote
 * backend (e.g. `bedrock-main-openai.gpt-6-astra`) may not be the deduped
 * `/models` id. RouteId is `${siteId}:${provider}:${backendId}`.
 */
export function logicalModelFor(
	modelId: string,
	options: ModelOption[],
	models: ModelEntry[],
	routing: RoutingEntry[] = [],
): string | undefined {
	if (options.some((o) => o.id === modelId)) return modelId;
	const row = models.find((m) => m.id === modelId);
	const logical = row?.logical_model;
	if (logical && options.some((o) => o.id === logical)) return logical;
	for (const entry of routing) {
		for (const r of entry.routes ?? []) {
			if (parseRouteId(r.route_id)?.backendId !== modelId) continue;
			if (options.some((o) => o.id === entry.logical_model)) return entry.logical_model;
		}
	}
	return undefined;
}

export interface InitialModelSources {
	/** The thread's latest message `model_id` (backend or logical id). */
	fallbackModel?: string | null;
	/** Cluster `default` role (`getClusterDefaults().roles.default`). */
	clusterDefault?: string | null;
	routing?: RoutingEntry[];
}

/**
 * Resolves the initial selection in priority order: the thread's hint, the
 * thread's latest message model, the cluster `default` role, then the host
 * default. Each may be a backend id or a logical id; all resolve to the
 * logical option (#38).
 */
export function resolveInitialModel(
	options: ModelOption[],
	models: ModelEntry[],
	defaultModel: string,
	hint?: string | null,
	sources: InitialModelSources = {},
): ResolvedModel {
	const routing = sources.routing ?? [];
	for (const candidate of [hint, sources.fallbackModel, sources.clusterDefault, defaultModel]) {
		if (!candidate) continue;
		const logical = logicalModelFor(candidate, options, models, routing);
		if (logical) return { selectedModel: logical, modelId: logical };
	}
	return { selectedModel: defaultModel, modelId: defaultModel };
}
