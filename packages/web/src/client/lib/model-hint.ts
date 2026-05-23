interface ModelEntry {
	id: string;
	host: string;
}

interface ResolvedModel {
	selectedModel: string;
	modelId: string;
}

/**
 * Resolves the initial model selection for the model selector.
 *
 * Priority:
 * 1. If a hint is provided and a model with that ID exists, use it.
 * 2. Otherwise, use the global default.
 *
 * Used by ModelSelector to default to a thread's task model_hint when the
 * thread was spawned by a scheduled task that had a model_hint set (#38).
 */
export function resolveInitialModel(
	models: ModelEntry[],
	defaultModel: string,
	hint?: string | null,
): ResolvedModel {
	if (hint) {
		const hintMatch = models.find((m) => m.id === hint);
		if (hintMatch) {
			return {
				selectedModel: `${hintMatch.id}@${hintMatch.host}`,
				modelId: hintMatch.id,
			};
		}
	}
	const defaultMatch = models.find((m) => m.id === defaultModel);
	return {
		selectedModel: defaultMatch ? `${defaultMatch.id}@${defaultMatch.host}` : defaultModel,
		modelId: defaultModel,
	};
}
