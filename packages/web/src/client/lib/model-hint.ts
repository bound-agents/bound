interface ModelEntry {
	id: string;
	logical_model?: string;
	display_name?: string;
}

interface RoutingEntry {
	logical_model: string;
	display_name?: string | null;
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
	return options.sort((a, b) => a.label.localeCompare(b.label));
}

/** Maps a backend id or logical id to the logical option it selects, if any. */
export function logicalModelFor(
	modelId: string,
	options: ModelOption[],
	models: ModelEntry[],
): string | undefined {
	if (options.some((o) => o.id === modelId)) return modelId;
	const row = models.find((m) => m.id === modelId);
	const logical = row?.logical_model;
	if (logical && options.some((o) => o.id === logical)) return logical;
	return undefined;
}

/**
 * Resolves the initial selection: a thread hint first, then the cluster
 * default. Either may be a backend id or a logical id; both resolve to the
 * logical option (#38).
 */
export function resolveInitialModel(
	options: ModelOption[],
	models: ModelEntry[],
	defaultModel: string,
	hint?: string | null,
): ResolvedModel {
	if (hint) {
		const logical = logicalModelFor(hint, options, models);
		if (logical) return { selectedModel: logical, modelId: logical };
	}
	const logical = logicalModelFor(defaultModel, options, models);
	if (logical) return { selectedModel: logical, modelId: logical };
	return { selectedModel: defaultModel, modelId: defaultModel };
}
