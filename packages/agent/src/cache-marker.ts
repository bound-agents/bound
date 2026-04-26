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
 * Caps shape: accepts either the full `BackendCapabilities` (local resolution)
 * or a partial `{ prompt_caching?: boolean, ... }` bag (remote resolution —
 * `EligibleHost.capabilities` is a subset of the driver shape). `undefined`
 * means "no caps info at all"; the helper places the marker optimistically.
 * The relay-processor receiver-side strip is the defense-in-depth line for
 * that case.
 */

import type { LLMMessage } from "@bound/llm";

export type CacheMarkerKind = "fixed" | "rolling";

/** Minimal capability shape the gate actually inspects. */
export interface CacheMarkerCaps {
	prompt_caching?: boolean;
}

/**
 * Splice a `{ role: "cache", content: "" }` marker into `messages` at
 * `messages.length - 1` (i.e. before the last entry).
 *
 * @returns true when a marker was placed, false when gated out.
 */
export function maybePlaceCacheMarker(
	messages: LLMMessage[],
	_kind: CacheMarkerKind,
	caps: CacheMarkerCaps | undefined,
): boolean {
	if (caps && caps.prompt_caching === false) return false;
	if (messages.length < 2) return false;
	messages.splice(messages.length - 1, 0, { role: "cache", content: "" });
	return true;
}

/**
 * Defense-in-depth receiver-side strip: if a relayed inference payload
 * arrives with `{ role: "cache" }` markers but the local backend can't
 * cache, drop them before dispatch so we don't send
 * `providerOptions.bedrock.cachePoint` to AWS for a model that 403s on it.
 *
 * Returns the same array reference when there's nothing to do (fast path)
 * so callers don't need to re-bind. Does NOT mutate the input.
 */
export function stripCacheMarkersIfUnsupported(
	messages: LLMMessage[],
	caps: CacheMarkerCaps | undefined,
): LLMMessage[] {
	if (!caps || caps.prompt_caching !== false) return messages;
	if (!messages.some((m) => m.role === "cache")) return messages;
	return messages.filter((m) => m.role !== "cache");
}
