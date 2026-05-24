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
import type { CacheMarker, ContextSection } from "@bound/shared";

export type CacheMarkerKind = "fixed" | "rolling";

/** Minimal capability shape the gate actually inspects. */
export interface CacheMarkerCaps {
	prompt_caching?: boolean;
}

/**
 * Result of a cache-marker placement attempt.
 *
 * - `placed: true` — marker was spliced into `messages` at `messages.length - 2`
 *   (between the second-to-last and last entries). `index` reflects the position
 *   of the inserted marker.
 * - `placed: false` — placement was skipped. `reason` describes which gate fired:
 *   - `"capability-disabled"` — caps explicitly say `prompt_caching: false`. The
 *     loop should treat this as "caching is unsupported on this turn".
 *   - `"too-short"` — `messages.length < 2`. Caching is supported in principle
 *     but there's nothing to cache yet (e.g., the very first turn before any
 *     volatile-tail injection). The UI may still want to render a disabled tick.
 */
export interface CacheMarkerPlacement {
	placed: boolean;
	variant: CacheMarkerKind;
	/** Index of the spliced marker, or -1 when not placed. */
	index: number;
	reason?: "capability-disabled" | "too-short";
}

/**
 * Splice a `{ role: "cache", content: "" }` marker into `messages` at
 * `messages.length - 1` (i.e. before the last entry).
 *
 * @returns A `CacheMarkerPlacement` describing whether the marker was placed,
 *          its variant, the splice index, and (when not placed) the reason.
 */
export function maybePlaceCacheMarker(
	messages: LLMMessage[],
	kind: CacheMarkerKind,
	caps: CacheMarkerCaps | undefined,
): CacheMarkerPlacement {
	if (caps && caps.prompt_caching === false) {
		return { placed: false, variant: kind, index: -1, reason: "capability-disabled" };
	}
	if (messages.length < 2) {
		return { placed: false, variant: kind, index: -1, reason: "too-short" };
	}
	const insertAt = messages.length - 1;
	messages.splice(insertAt, 0, { role: "cache", content: "" });
	return { placed: true, variant: kind, index: insertAt };
}

/**
 * Build the `cacheMarkers` array recorded on `ContextDebugInfo` for a turn.
 *
 * Two breakpoint kinds are emitted (when the resolved backend supports prompt
 * caching at all):
 *
 * 1. **System** — boundary at the end of the stable system-prefix per R-VC24.
 *    `positionTokens` sums the `system + skill-context + volatile-prefix`
 *    section tokens, matching the cumulative offset where the system-level
 *    `cache_control` / `cachePoint` rides on the wire. Always `variant:
 *    "fixed"` because the system prefix is byte-stable across warm reuse.
 *
 * 2. **Message** — boundary at `messages[length - 2]`, i.e. just before the
 *    volatile-tail developer message. `positionTokens` adds the `history`
 *    section tokens to the system marker offset. `variant` follows
 *    `messagePlacement.variant` ("fixed" on cold-path turns, "rolling" on
 *    warm-path turns). When `messagePlacement.reason === "capability-disabled"`
 *    no markers are emitted at all (caching is structurally unavailable on
 *    this turn).
 *
 * Section names not present in `sections` (e.g. `skill-context` is optional)
 * contribute zero to the offset; the helper is robust to missing sections.
 */
export function buildCacheMarkers(args: {
	sections: ContextSection[];
	messagePlacement: CacheMarkerPlacement;
	ttl: "5m" | "1h";
}): CacheMarker[] {
	const { sections, messagePlacement, ttl } = args;

	// "capability-disabled" means the backend cannot cache on this turn at all
	// — neither the system-level nor the message-level breakpoint is emitted on
	// the wire. Recording zero markers reflects on-wire reality and keeps the
	// UI's tick rendering honest.
	if (messagePlacement.placed === false && messagePlacement.reason === "capability-disabled") {
		return [];
	}

	const tokensFor = (name: string): number => sections.find((s) => s.name === name)?.tokens ?? 0;

	const stablePrefixTokens =
		tokensFor("system") + tokensFor("skill-context") + tokensFor("volatile-prefix");
	const messageBoundaryTokens = stablePrefixTokens + tokensFor("history");

	// `capabilityEnabled` reports whether a marker WOULD have been emitted on
	// the wire if structural conditions were met. The system breakpoint and
	// the (potential) message breakpoint share this state — both are gated by
	// the same `prompt_caching` capability bit on the resolved backend. The
	// "too-short" branch (messages.length < 2 on a brand-new thread) keeps
	// `capabilityEnabled: true` so the UI can still render the intended
	// position with a "no benefit yet" tooltip.
	const capabilityEnabled =
		messagePlacement.placed || messagePlacement.reason !== "capability-disabled";

	return [
		{
			kind: "system",
			positionTokens: stablePrefixTokens,
			variant: "fixed",
			ttl,
			capabilityEnabled,
		},
		{
			kind: "message",
			positionTokens: messageBoundaryTokens,
			variant: messagePlacement.variant,
			ttl,
			capabilityEnabled,
		},
	];
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
