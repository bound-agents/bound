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
 * Compute the splice index for a cache marker, taking the trailing-developer
 * merge into account.
 *
 * Background. The AI SDK bridge merges a trailing run of `developer` messages
 * onto the preceding user message (`appendDevToUser` in `ai-sdk-bridge.ts`).
 * The volatile-tail injection always lands as a trailing `developer`, so the
 * bridge mutates the user message that would otherwise be the cachePoint
 * target — the cached-prefix bytes then change every turn because the
 * volatile-tail varies. Live evidence: thread `927d4562-…` post-system-anchor
 * fix held `tokens_cache_read` at exactly the system-prefix size (86,041) on
 * every turn after the first, with `tokens_cache_write` climbing to 60k+
 * without ever reading back — the message-level marker writing fresh cache
 * each turn that the next turn never matches because the user-N bytes shifted.
 *
 * Placement rule. Walk backwards from the end:
 *   - If the last message is NOT a developer, fall back to the original
 *     position (`length - 1`). The bridge does not merge in this case, so
 *     a cachePoint on the second-to-last message rides stable bytes.
 *   - If the last message IS a developer, scan past the trailing-developer
 *     run. The first non-developer encountered is the merge-target candidate.
 *     If it's a user, place the marker BEFORE that user — cachePoint then
 *     attaches to whatever precedes it (a stable prior-turn message).
 *     If it's not a user (e.g., `assistant` or `tool_result` followed by a
 *     trailing developer), the bridge will emit the developer as a NEW
 *     trailing user rather than mutating an existing one; the original
 *     position immediately after the last non-dev is safe.
 *
 * The function is pure: depends only on `messages` and never mutates the
 * input. The caller decides whether to splice based on the returned index.
 */
function computeCacheMarkerIndex(messages: LLMMessage[]): number {
	const lastIdx = messages.length - 1;
	if (messages[lastIdx].role !== "developer") {
		return lastIdx;
	}
	// Skip trailing developer run.
	let i = lastIdx - 1;
	while (i >= 0 && messages[i].role === "developer") i--;
	// Last non-developer position.
	if (i >= 0 && messages[i].role === "user") {
		// Bridge will merge the trailing developers into this user. Anchor
		// before it so the cachePoint lands on stable bytes.
		return i;
	}
	// Last non-dev isn't a user — bridge appends a new trailing user for
	// the developer content. Original semantics apply at i + 1 (the start
	// of the trailing-dev run, which is now safely outside the cachePoint).
	return i + 1;
}

/**
 * Splice a `{ role: "cache", content: "" }` marker into `messages`.
 *
 * The splice position respects the bridge's trailing-developer merge: when
 * the input ends with a developer message (the volatile-tail), the marker is
 * placed BEFORE the user message the bridge will merge into. See
 * `computeCacheMarkerIndex` for the full placement rationale.
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
	const insertAt = computeCacheMarkerIndex(messages);
	// A marker spliced at index 0 has no preceding message for the bridge to
	// attach the cachePoint onto — the bridge silently drops it. Treat that
	// as too-short rather than emit a misleading `placed: true`.
	if (insertAt === 0) {
		return { placed: false, variant: kind, index: -1, reason: "too-short" };
	}
	messages.splice(insertAt, 0, { role: "cache", content: "" });
	return { placed: true, variant: kind, index: insertAt };
}

/**
 * Bucket-aligned stable cache marker placement.
 *
 * Background. Bedrock's prompt cache is keyed by the EXACT byte position of
 * each `cachePoint` from the start of the request, with a ~20-content-block
 * lookback for the simplified-cache mode (see Bedrock prompt-caching docs).
 * The "rolling" placement that pinned the marker right before the trailing
 * volatile-tail thrashed: every turn placed the cachePoint at a new byte
 * position because message history grew, so cached prefixes from prior turns
 * were never matched. Live evidence: thread `7453d60b-…` post-bridge-aware
 * fix held cache_read at the system-prefix size on every turn after
 * priming, with cache_write climbing to 60k+ tokens per turn that the next
 * turn never read back. One serendipitous hit (cr=141,991) confirmed the
 * lookback DOES work when consecutive turns happen to land within the
 * window; the other turns missed because position drift exceeded the
 * window.
 *
 * Bucket-aligned placement. Round the marker's cumulative-token position
 * DOWN to the nearest `bucketTokens` boundary. The marker advances only
 * when message history grows past the next bucket boundary — bounded,
 * predictable hysteresis. Within a bucket, consecutive turns land the
 * cachePoint at the same byte position and Bedrock matches reliably.
 *
 * Cumulative cache lifecycle:
 *   turn 1: history = 12k tokens. Below bucket → no message marker (system
 *           anchor still rides the cache).
 *   turn 5: history = 32k tokens, bucket = 10k → target 30k. Marker lands
 *           at the latest message boundary ≤ 30k cumulative. cache_write
 *           seeds the new prefix.
 *   turn 6-9: history = 35-39k tokens, bucket-aligned target stays at 30k.
 *             Marker at SAME byte position. cache_read = 30k every turn.
 *   turn 10: history = 41k tokens, bucket-aligned target advances to 40k.
 *            Marker advances forward; one cache_write to seed the new
 *            prefix; subsequent turns in the 40k bucket cache-hit.
 *
 * Pure function — depends only on its arguments. No DB, no clock, no
 * ambient state. The token estimator is injected so the production caller
 * uses tiktoken while tests use a deterministic char-based estimator.
 */

export interface StableCacheMarkerParams {
	messages: ReadonlyArray<LLMMessage>;
	/**
	 * Bucket size in tokens. The marker advances in chunks of this size.
	 * Larger values = fewer cache_write events but smaller cached prefix
	 * relative to history. Recommended: 10,000 tokens.
	 */
	bucketTokens: number;
	/**
	 * Token estimator. Pure and deterministic. The function is called once
	 * per non-marker message; its result is summed cumulatively.
	 */
	estimateTokens: (msg: LLMMessage) => number;
}

export interface StableCacheMarkerPlacement {
	placed: boolean;
	/** Splice index for the marker. -1 when not placed. */
	index: number;
	/** Cumulative tokens BEFORE the marker (= bytes that get cached). 0 when not placed. */
	positionTokens: number;
	/** Bucket-aligned target the marker is at-or-below. 0 when not placed. */
	targetTokens: number;
	/** Reason for non-placement. */
	reason?: "capability-disabled" | "below-bucket" | "no-eligible-anchor";
}

/**
 * Compute the stable-position cache marker placement for `messages`.
 *
 * Behavior:
 * - Skips messages with role `"cache"` when accumulating tokens (existing
 *   markers don't count toward the cumulative position).
 * - Returns `placed: false, reason: "below-bucket"` when total cumulative
 *   tokens < `bucketTokens` (nothing useful to cache yet — system-level
 *   anchor handles this regime).
 * - Returns `placed: false, reason: "capability-disabled"` when caps
 *   explicitly disable prompt caching.
 * - Otherwise returns the LATEST splice index whose cumulative-tokens-
 *   before-marker is ≤ `floor(totalTokens / bucketTokens) * bucketTokens`.
 *
 * The function does NOT mutate `messages`. Use `placeStableCacheMarker`
 * for the mutating version.
 */
export function computeStableCacheMarkerPlacement(
	params: StableCacheMarkerParams,
	caps: CacheMarkerCaps | undefined,
): StableCacheMarkerPlacement {
	if (caps && caps.prompt_caching === false) {
		return {
			placed: false,
			index: -1,
			positionTokens: 0,
			targetTokens: 0,
			reason: "capability-disabled",
		};
	}

	const { messages, bucketTokens, estimateTokens } = params;

	// Walk forward, tracking cumulative tokens and candidate splice indices.
	// A "candidate" splice index sits IMMEDIATELY AFTER a non-marker, non-
	// developer message — that's where a cache marker can land such that the
	// bridge will attach the cachePoint to that preceding message. Trailing
	// developer messages are excluded because the bridge merges them onto an
	// adjacent user, mutating the cachePoint target's bytes (the bug pinned
	// by `computeCacheMarkerIndex`).
	let cumulative = 0;
	const candidates: Array<{ index: number; cumulative: number }> = [];
	for (let i = 0; i < messages.length; i++) {
		const m = messages[i];
		if (m.role === "cache") continue;
		if (m.role === "developer") continue;
		cumulative += estimateTokens(m);
		// Candidate splice index = i + 1 (insert AFTER this message).
		candidates.push({ index: i + 1, cumulative });
	}

	const totalTokens = cumulative;
	if (totalTokens < bucketTokens) {
		return {
			placed: false,
			index: -1,
			positionTokens: 0,
			targetTokens: 0,
			reason: "below-bucket",
		};
	}

	const targetTokens = Math.floor(totalTokens / bucketTokens) * bucketTokens;

	// Find the LATEST candidate whose cumulative ≤ target.
	let best: { index: number; cumulative: number } | null = null;
	for (const c of candidates) {
		if (c.cumulative <= targetTokens) best = c;
		else break;
	}

	if (!best || best.index === 0) {
		return {
			placed: false,
			index: -1,
			positionTokens: 0,
			targetTokens,
			reason: "no-eligible-anchor",
		};
	}

	return {
		placed: true,
		index: best.index,
		positionTokens: best.cumulative,
		targetTokens,
	};
}

/**
 * Splice a stable-position cache marker into `messages` per
 * `computeStableCacheMarkerPlacement`. Mutates `messages` in place when a
 * marker is placed; leaves it untouched otherwise.
 */
export function placeStableCacheMarker(
	messages: LLMMessage[],
	params: Omit<StableCacheMarkerParams, "messages">,
	caps: CacheMarkerCaps | undefined,
): StableCacheMarkerPlacement {
	const placement = computeStableCacheMarkerPlacement({ ...params, messages }, caps);
	if (placement.placed) {
		messages.splice(placement.index, 0, { role: "cache", content: "" });
	}
	return placement;
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
