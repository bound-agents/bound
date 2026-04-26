/**
 * Cache-marker placement helper.
 *
 * Extracted from the agent-loop so the gating rules around prompt-caching
 * capability can be unit-tested without standing up a full loop. Both the
 * cold (fixed) and warm (rolling) paths funnel through here.
 *
 * Gating rule: skip marker placement when the effective backend capabilities
 * explicitly report `prompt_caching: false`. This prevents emitting a
 * `{ role: "cache" }` message which the bedrock driver would translate into
 * `providerOptions.bedrock.cachePoint` — rejected by AWS with a 403 for
 * models that don't support the Converse API cache feature.
 *
 * When caps are `undefined` (e.g. a remote resolution where capabilities
 * weren't prefetched), we DO place the marker — preserving historical
 * behavior. The receiving host remains responsible for stripping or
 * honoring the marker based on its own backend.
 */

import type { BackendCapabilities, LLMMessage } from "@bound/llm";

export type CacheMarkerKind = "fixed" | "rolling";

/**
 * Splice a `{ role: "cache", content: "" }` marker into `messages` at
 * `messages.length - 1` (i.e. before the last entry).
 *
 * @returns true when a marker was placed, false when gated out.
 */
export function maybePlaceCacheMarker(
	messages: LLMMessage[],
	_kind: CacheMarkerKind,
	caps: BackendCapabilities | undefined,
): boolean {
	if (caps && caps.prompt_caching === false) return false;
	if (messages.length < 2) return false;
	messages.splice(messages.length - 1, 0, { role: "cache", content: "" });
	return true;
}
