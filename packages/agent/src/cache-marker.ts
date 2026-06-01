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
	/**
	 * Cumulative tokens BEFORE the marker. Set by the stable-position placer
	 * (`coldPathPlaceCacheMarker`) when caching is enabled — represents the
	 * actual bytes Bedrock will see riding the cachePoint, distinct from the
	 * section-aggregate fallback used in legacy paths. Undefined when not
	 * provided by the placer; `buildCacheMarkers` then falls back to summing
	 * `system + skill-context + volatile-prefix + tools + history` section
	 * tokens.
	 */
	positionTokens?: number;
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
 * Semantic-anchor cache marker placement.
 *
 * Background. Bedrock's prompt cache is keyed by the EXACT byte position of
 * each `cachePoint` from the start of the request, with a ~20-content-block
 * lookback for the simplified-cache mode. The original "rolling" placer
 * thrashed because every turn moved the marker; the bucket-token-aligned
 * successor (5b2f05fe) thrashed when single inner-loop iterations produced
 * tool results larger than the bucket size — the bucket boundary advanced
 * past the prior cached position in one jump, lookback couldn't bridge.
 * Live evidence: thread `192f8174-…` had a +28k-token tool result between
 * two budget-exceeded cold paths within the same outer turn; bucket
 * advanced from 90k → 120k; cumulative cache orphaned for 5 turns until
 * the new bucket primed.
 *
 * The fundamental issue with token-bucket math: `bucketTokens` is a magic
 * number. There IS no principled value of N — pick 10k and big tool
 * results overflow, pick 50k and small inner loops never benefit. The
 * placer was tuning a symptom.
 *
 * Semantic anchoring. The cachePoint anchors at the index of the LATEST
 * user message. The bytes BEFORE that user are persisted history from
 * prior turns — semantically immutable. Within a single user turn (any
 * number of inner-loop iterations producing arbitrary-size tool results),
 * the latest-user-msg index doesn't advance; the cachePoint byte position
 * stays put; Bedrock's prefix cache hits regardless of inner-loop append
 * size. When a NEW user message arrives, the anchor advances by exactly
 * one prior user turn's worth of content — a natural cache-invalidation
 * cadence aligned with the user's interaction pattern.
 *
 * Same semantic boundary used by `computeCompactionBoundary` in
 * `history-compaction/` and the boundary-aware summary throttle (0ce38fb0).
 * Anchoring on it unifies the architecture: summary regen, cachePoint
 * advance, and compaction events all happen at the same instant — the
 * arrival of a new user message.
 *
 * Cumulative cache lifecycle:
 *   user turn 1 starts: place cachePoint before user_1 (no prior msgs →
 *                       no message-level marker, system anchor only).
 *   user turn 1 inner loop: marker stays put. Each iteration's tool calls
 *                           append AFTER the cachePoint. cache HITS.
 *   user turn 2 arrives: cachePoint advances to before user_2. The bytes
 *                        between (user_1, asst_response_1, tool round
 *                        results) are now cached. cache_write to seed the
 *                        new larger prefix; subsequent inner-loop turns
 *                        cache HIT at the new larger position.
 *
 * Pure function — depends only on its arguments. No DB, no clock, no
 * ambient state.
 */

export interface StableCacheMarkerParams {
	messages: ReadonlyArray<LLMMessage>;
	/**
	 * @deprecated Unused under the semantic-anchor algorithm. Kept in the
	 * input shape for backward compatibility with callers that still pass
	 * a value; the placer ignores it. Pass any value (e.g. `0`).
	 */
	bucketTokens: number;
	/**
	 * Token estimator. Pure and deterministic. The function is called once
	 * per non-marker, non-developer message; its result is summed to
	 * compute `positionTokens` (the wire byte position of the cachePoint).
	 */
	estimateTokens: (msg: LLMMessage) => number;
}

export interface StableCacheMarkerPlacement {
	placed: boolean;
	/** Splice index for the marker. -1 when not placed. */
	index: number;
	/** Cumulative tokens BEFORE the marker (= bytes that get cached). 0 when not placed. */
	positionTokens: number;
	/**
	 * Equal to `positionTokens` under the semantic-anchor algorithm.
	 * Retained in the response shape for backward compatibility with the
	 * web debugger's marker-tick rendering, which historically read this
	 * field as the bucket-aligned target.
	 */
	targetTokens: number;
	/** Reason for non-placement. */
	reason?: "capability-disabled" | "no-eligible-anchor";
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

	const { messages, estimateTokens } = params;

	// Semantic anchoring. The cachePoint anchors at the index of the
	// LATEST user message — `computeCacheMarkerIndex` already implements
	// this rule for the trailing-developer case (76a0c0eb). Within a
	// single user turn (multiple inner-loop iterations), the latest user
	// msg index does NOT change as new tool_call / tool_result content
	// appends. The cachePoint byte position therefore stays stable
	// regardless of how big the inner-loop appends grow.
	//
	// When a NEW user message arrives, the index advances — the
	// cachePoint's byte position increases by exactly one prior user
	// turn's worth of content. That's the natural cache-invalidation
	// cadence: cumulative cache grows monotonically by one user turn per
	// transition over the thread lifetime.
	//
	// `bucketTokens` is now unused — the magic-number era is over. The
	// param is kept in the input shape for backward compat with existing
	// callers; new callers should pass anything (e.g. `0`) and ignore it.
	if (messages.length < 2) {
		return {
			placed: false,
			index: -1,
			positionTokens: 0,
			targetTokens: 0,
			reason: "no-eligible-anchor",
		};
	}

	// Semantic anchor: find the LATEST user message index. Place marker
	// at that index so the cachePoint attaches to messages[index - 1]
	// (the prior turn's last message — semantically immutable history).
	//
	// This mirrors `computeCompactionBoundary` from `history-compaction/`
	// — same semantic boundary (latest-user-msg-index) the summary
	// throttle uses (0ce38fb0). The two systems advance in lockstep, so
	// summary regen and cachePoint advance happen at the same instant.
	let insertAt = -1;
	for (let i = messages.length - 1; i >= 0; i--) {
		if (messages[i].role === "user") {
			insertAt = i;
			break;
		}
	}

	// Fallback: when no usable semantic anchor exists (no user message at
	// index > 0), fall back to the bridge-aware default placement. This
	// preserves the load-bearing contract that placement happens
	// best-effort ALWAYS when caps allow caching — without a placed
	// marker, `hasBedrockMessageCachePoint` returns false and the bedrock
	// driver gates the SYSTEM cachePoint off too, killing cache_read for
	// the whole turn. Live regression: thread `a191e01f-…` had user_1 at
	// index 0 (fresh boundless thread), the strict semantic placer
	// declined, and 79 turns ran with cr=0 across the board.
	//
	// The fallback (`computeCacheMarkerIndex`) is byte-position-suboptimal
	// for tool-using inner loops but unconditionally produces a valid
	// placement when there's anything to anchor on.
	if (insertAt <= 0) {
		// `computeCacheMarkerIndex` reads from `messages` only — never
		// mutates — so the readonly-vs-mutable distinction is safe to
		// drop here.
		insertAt = computeCacheMarkerIndex(messages as LLMMessage[]);
	}

	if (insertAt <= 0) {
		// Even the fallback couldn't find a position — the array is too
		// small (1-message threads). Caller can re-attempt later.
		return {
			placed: false,
			index: -1,
			positionTokens: 0,
			targetTokens: 0,
			reason: "no-eligible-anchor",
		};
	}

	// Compute positionTokens = sum of estimateTokens over messages BEFORE
	// the splice index. Skip cache markers and developer messages
	// (consistent with the bridge — developer messages get merged into
	// adjacent users and don't contribute their own token count to the
	// on-wire cumulative).
	const computePositionTokens = (
		end: number,
	): { positionTokens: number; nonDevPrecedingCount: number } => {
		let positionTokens = 0;
		let nonDevPrecedingCount = 0;
		for (let i = 0; i < end; i++) {
			const m = messages[i];
			if (m.role === "cache" || m.role === "developer") continue;
			positionTokens += estimateTokens(m);
			nonDevPrecedingCount++;
		}
		return { positionTokens, nonDevPrecedingCount };
	};

	let { positionTokens, nonDevPrecedingCount } = computePositionTokens(insertAt);

	// Bridge-drop avoidance. The AI SDK bridge (ai-sdk-bridge.ts:270-288)
	// processes role="cache" by attaching a cachePoint to the LAST emitted
	// message in `result`. Developer messages don't produce result entries
	// — they accumulate in `pendingDev` and merge into the next user
	// message. If every message before insertAt is a developer, `result`
	// is empty when the bridge processes the cache marker, and the marker
	// is silently dropped — no cachePoint reaches the wire.
	//
	// Live regressions:
	//   - thread `91a31a43-...` 2026-05-26: autonomous task with one user
	//     and only `[user_1, dev_tail]` in messages. Latest-user at idx 0,
	//     fallback placed BEFORE user_1 → bridge dropped → cw=0.
	//   - thread `3a833552-...` 2026-05-26: autonomous task WITH a Stage
	//     1.7-prepended `developer` compaction summary at index 0 +
	//     thread.summary. Strict semantic-anchor placed marker BEFORE
	//     user_1 (at idx 1), but nothing non-developer preceded → bridge
	//     dropped → cw=0 across all 33 turns.
	//
	// Recovery rule. When the strict semantic-anchor target has 0
	// non-developer preceding messages, the marker would be silently
	// dropped if spliced. Try advancing insertAt past the latest user
	// (insertAt + 1) so the cachePoint anchors ON that user — by which
	// point the bridge has flushed any pending developer content into the
	// user via `appendDevToUser`. This makes the cached prefix the
	// merged user message (e.g. `[compaction summary] + user prompt`),
	// which is byte-stable across inner-loop iterations as long as
	// thread.summary doesn't change. If the advanced position STILL has
	// no non-dev preceding (impossible here since user_1 IS non-dev), or
	// would land outside the array, refuse.
	if (nonDevPrecedingCount === 0) {
		const advanced = insertAt + 1;
		if (advanced >= messages.length) {
			// No content after the user to advance to — the marker would
			// fall off the end and the bridge couldn't attach it either.
			return {
				placed: false,
				index: -1,
				positionTokens: 0,
				targetTokens: 0,
				reason: "no-eligible-anchor",
			};
		}
		const advancedTokens = computePositionTokens(advanced);
		if (advancedTokens.nonDevPrecedingCount === 0) {
			// Defensive: shouldn't happen because user_1 is non-dev, but
			// preserves the invariant if upstream message shapes change.
			return {
				placed: false,
				index: -1,
				positionTokens: 0,
				targetTokens: 0,
				reason: "no-eligible-anchor",
			};
		}
		insertAt = advanced;
		positionTokens = advancedTokens.positionTokens;
	}

	return {
		placed: true,
		index: insertAt,
		positionTokens,
		// `targetTokens` is now `positionTokens` — there's no separate
		// bucket-aligned target. Kept in the response shape for backward
		// compatibility with the web debugger marker rendering.
		targetTokens: positionTokens,
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
 * Cold-path cache marker placer — the production entry point invoked by the
 * agent-loop's cold path. Delegates to `placeStableCacheMarker` for bucket-
 * aligned byte-position stability across consecutive same-bucket turns, and
 * adapts the result to the legacy `CacheMarkerPlacement` shape consumed by
 * the agent-loop's bookkeeping (cached turn state, context debug, web
 * debugger marker rendering) so the integration is a single call-site swap.
 *
 * Reason mapping. `placeStableCacheMarker` emits richer reason codes
 * (`below-bucket`, `no-eligible-anchor`) than the legacy placement;
 * downstream code already gracefully handles `too-short`, so the wrapper
 * collapses both new reasons into `too-short`. `capability-disabled`
 * passes through unchanged.
 *
 * positionTokens. The stable-position placer's `positionTokens` field is
 * propagated onto the returned `CacheMarkerPlacement` so `buildCacheMarkers`
 * can record the on-wire cachePoint position truthfully — distinct from the
 * section-aggregate fallback. Without this, the web debugger's marker tick
 * would show a position that doesn't match what Bedrock actually sees.
 */
export function coldPathPlaceCacheMarker(
	messages: LLMMessage[],
	params: Omit<StableCacheMarkerParams, "messages">,
	caps: CacheMarkerCaps | undefined,
): CacheMarkerPlacement {
	const placement = placeStableCacheMarker(messages, params, caps);
	if (placement.placed) {
		return {
			placed: true,
			variant: "fixed",
			index: placement.index,
			positionTokens: placement.positionTokens,
		};
	}
	const reason: CacheMarkerPlacement["reason"] =
		placement.reason === "capability-disabled" ? "capability-disabled" : "too-short";
	return { placed: false, variant: "fixed", index: -1, reason };
}

/**
 * Build the `cacheMarkers` array recorded on `ContextDebugInfo` for a turn.
 *
 * Two breakpoint kinds are emitted (when the resolved backend supports prompt
 * caching at all):
 *
 * 1. **System** — boundary at the end of the stable system-prefix per R-VC24.
 *    `positionTokens` sums the `system + skill-context + volatile-prefix +
 *    tools` section tokens, matching the cumulative offset where the
 *    system-level `cache_control` / `cachePoint` rides on the wire. Tool
 *    definitions are part of the cacheable prefix (Anthropic/Bedrock order:
 *    tools → system → messages), so the system breakpoint caches them and they
 *    count toward this offset (#97). Always `variant: "fixed"` because the
 *    system prefix is byte-stable across warm reuse.
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
		tokensFor("system") +
		tokensFor("skill-context") +
		tokensFor("volatile-prefix") +
		tokensFor("tools");
	// Prefer the placer-supplied positionTokens (set by `coldPathPlaceCacheMarker`,
	// represents the actual on-wire bytes leading up to the cachePoint) over the
	// section-aggregate fallback. The fallback covers legacy/warm-path paths that
	// don't carry the stable-placer metadata, and matches the historical "marker
	// just before volatile-tail" semantic.
	const messageBoundaryTokens =
		messagePlacement.placed && messagePlacement.positionTokens !== undefined
			? stablePrefixTokens + messagePlacement.positionTokens
			: stablePrefixTokens + tokensFor("history");

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
 * Maintain a bounded trailing PAIR of inner-loop rolling cache markers: keep
 * the most recent prior rolling marker as an explicit "previous write position"
 * breakpoint and place a fresh one at the tip.
 *
 * Inner-loop semantics. Inside `while (continueLoop)` in agent-loop.ts,
 * each iteration appends `tool_call + tool_result(s)` to `llmMessages`.
 * The cold-path FIXED marker at the semantic anchor (user_1 for fresh
 * threads) caches the system + user prompt, but every byte appended after
 * it pays full price on the next inner iteration. Without a rolling
 * cachePoint, a 5-iter inner loop with ~10k tool roundtrips per iter
 * pays the full ~50k cumulative on each inference.
 *
 * Why a PAIR, not a single rolling marker. A single rolling marker moves to
 * the tip every iteration, so iteration K has NO cachePoint at iteration
 * K-1's write position. Bedrock's exact-byte-position cache then has to bridge
 * P_{K-1} → P_K via its ~20-block auto-lookback. Live data (heavy coding
 * thread 60db514d, May 29-31) shows that lookback does NOT bridge for these
 * threads: a single large `tool_result` (file / bash blob) blows past the
 * window, the prior write is orphaned, `cr` stays pinned at the fixed floor
 * (~58,745) while `cw` re-writes the whole grown prefix (66-95k). Write-once-
 * read-never → cache-write/read ratio ~1.12 (paying for writes consumed once).
 *
 * Keeping iteration K-1's marker in place gives iteration K an EXPLICIT
 * breakpoint at exactly K-1's write position. The preceding bytes are
 * committed history (byte-identical across iterations), so the bridge attaches
 * the cachePoint to the same wire position and Bedrock serves an exact-match
 * read — no reliance on lookback. Inner-loop cumulative cache then grows
 * monotonically, and the next outer turn's warm-path arrival doesn't re-seed
 * the inner-loop content from cold.
 *
 * Eviction / bounding. Keep the single MOST RECENT prior rolling marker (the
 * prev breakpoint); evict every OLDER rolling marker so the pair never grows
 * unbounded. With caching disabled, evict every non-fixed marker and place
 * nothing (a stray cachePoint on a no-cache backend risks a 403). Walks
 * backwards so splice indices don't shift under us; the fixed marker is never
 * touched.
 *
 * Placement. Delegates the new tip marker to
 * `maybePlaceCacheMarker(.., "rolling", caps)`, which handles trailing-
 * developer awareness and the bridge-drop avoidance from
 * `computeCacheMarkerIndex`.
 *
 * 4-cachePoint cap. With this helper engaged, a single chat() call carries:
 * 1 system-level + 1 fixed + 1 prev-rolling + 1 new-rolling = 4 cachePoints,
 * exactly at Anthropic's 4-marker cap. The trailing-pair is BOUNDED (older
 * rollings are evicted every refresh), so the count is deterministic and never
 * exceeds 4. On the first inner refresh — before any prior rolling exists —
 * the call carries 3 (system + fixed + new).
 *
 * Mutates `messages` in place (eviction + splice). Returns the placement
 * record from the underlying `maybePlaceCacheMarker` call so the caller can
 * record it on `contextDebug.cacheMarkers` if desired.
 */
export function refreshInnerLoopRollingMarker(
	messages: LLMMessage[],
	fixedCacheIdx: number,
	caps: CacheMarkerCaps | undefined,
): CacheMarkerPlacement {
	// Collect all non-fixed cache markers (prior rolling markers), ascending.
	const rollingIdxs: number[] = [];
	for (let i = 0; i < messages.length; i++) {
		if (messages[i].role === "cache" && i !== fixedCacheIdx) {
			rollingIdxs.push(i);
		}
	}

	if (caps && caps.prompt_caching === false) {
		// Caching disabled: evict every non-fixed marker (a stray cachePoint on a
		// no-cache backend risks a 403) and place nothing. Walk high→low so
		// splice indices don't shift under us.
		for (let i = rollingIdxs.length - 1; i >= 0; i--) {
			messages.splice(rollingIdxs[i], 1);
		}
		return { placed: false, variant: "rolling", index: -1, reason: "capability-disabled" };
	}

	// Trailing-pair. Keep the MOST RECENT prior rolling marker in place as the
	// explicit "previous write position" breakpoint, and evict every OLDER
	// rolling marker. Walk the older markers high→low so splice indices don't
	// shift under us; the most-recent (highest index) is left untouched.
	for (let i = rollingIdxs.length - 2; i >= 0; i--) {
		messages.splice(rollingIdxs[i], 1);
	}
	return maybePlaceCacheMarker(messages, "rolling", caps);
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
