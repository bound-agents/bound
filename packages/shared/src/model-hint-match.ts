/**
 * Shared model-hint → logical-model matching (2026-11-21-model-catalog.md §2.1,
 * 2026-11-21-model-routing.md §2.1).
 *
 * Self-configuring namespaces (Copilot, Bedrock, Mantle, Umans) expand backends
 * to ids of the form `${namespaceId}-${providerModelId}` (e.g.
 * `bedrock-use1-openai.gpt-5.6-sol`). Existing thread/task/agent `model_hint`s
 * still carry the old hand-written ids (`gpt-5.6-sol`, `copilot-opus-5.5`, …).
 * Those hand-written ids normalize — via `normalizeModelKey` — to the SAME
 * canonical key the expanded backends advertise as their `logical_model`. So a
 * hint that matches no backend id literally can still resolve THROUGH the
 * logical model: compare its normalized key against the advertised
 * `logical_model` keys (also normalized).
 *
 * This is the ONE matcher shared by local resolution, remote/relay host
 * selection, and the dangling-reference checker, so the three never drift. It
 * lives in `@bound/shared` because `@bound/core` (the dangling checker) depends
 * only on `@bound/shared` and cannot import `@bound/llm`, where
 * `normalizeModelKey` lives. The normalizer is injected (`normalizeKey`) rather
 * than imported here: `@bound/shared` gains no dependency on catalog internals,
 * and `normalizeModelKey` stays put in the catalog module where its six other
 * callers already consume it. Callers in `@bound/agent` / `@bound/web` (both of
 * which depend on `@bound/llm`) pass `@bound/llm`'s `normalizeModelKey`.
 *
 * Literal id matches ALWAYS take precedence (an exact backend id, an advertised
 * entry id, or an `@RouteId` pin behave exactly as before); the logical-model
 * fallback only fires when no literal match exists. Matching never crosses to a
 * DIFFERENT logical model: a hint resolves only to entries whose logical model
 * is the same key the hint itself normalizes to.
 */

/**
 * The provider argument passed to `normalizeModelKey` when normalizing a bare
 * `model_hint` that carries no provider context. `openai-compatible` is
 * deliberately provider-AGNOSTIC for key derivation: it is absent from the
 * hosted-provider namespaces (so it only affects `recognizedNamespace`, never
 * the canonical `key`) and is not a Bedrock-style namespace (so no structural
 * dotted-vendor strip is applied). A hand-written hint like `gpt-5.6-sol` or
 * `copilot-gpt-6.2-sol` therefore normalizes to the same structural key
 * (`gpt-5-6-sol`, `gpt-6-2-sol`) the expanded backend advertises, with no
 * namespace-specific rewriting baked into the hint side.
 */
export const HINT_NORMALIZE_PROVIDER = "openai-compatible";

/** A `normalizeModelKey`-shaped function: `(provider, id) → { key }`. */
export type NormalizeKeyFn = (provider: string, providerModelId: string) => { key: string };

/**
 * Normalize a bare model-hint logical-model name to its canonical structural
 * key via the injected normalizer, using the provider-agnostic argument.
 */
export function normalizeHintKey(hint: string, normalizeKey: NormalizeKeyFn): string {
	return normalizeKey(HINT_NORMALIZE_PROVIDER, hint).key;
}

/**
 * Does `hint` resolve to the logical model `candidateLogicalModel` through the
 * normalized key? True when either (a) they are literally equal (a config pin
 * such as `logical_model: "opus"` matched by a bare `opus` hint), or (b) their
 * normalized keys match. Literal id matches are the CALLER's responsibility and
 * take precedence; this is consulted only after a literal lookup misses.
 */
export function hintMatchesLogicalModel(
	hint: string,
	candidateLogicalModel: string,
	normalizeKey: NormalizeKeyFn,
): boolean {
	if (hint === candidateLogicalModel) return true;
	return (
		normalizeHintKey(hint, normalizeKey) === normalizeHintKey(candidateLogicalModel, normalizeKey)
	);
}

/**
 * Whether a model hint matches ANY advertised logical model in `logicalModels`,
 * literally or through the normalized key. Used by the dangling-reference
 * checker to decide whether a hint has gone dead, and by resolution to decide
 * whether a literal-miss hint is nonetheless live via a logical model.
 */
export function hintMatchesAnyLogicalModel(
	hint: string,
	logicalModels: Iterable<string>,
	normalizeKey: NormalizeKeyFn,
): boolean {
	const hintKey = normalizeHintKey(hint, normalizeKey);
	for (const logical of logicalModels) {
		if (hint === logical) return true;
		if (normalizeHintKey(logical, normalizeKey) === hintKey) return true;
	}
	return false;
}
