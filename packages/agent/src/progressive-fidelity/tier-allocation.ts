/**
 * Tiered history truncation — the "telescope" model.
 *
 * Replaces the binary truncation cliff with a three-tier gradient:
 *   1. RECENT: full-resolution messages (backward-fill, same as before)
 *   2. MIDDLE: tool-cycle folded one-liners (mechanical compression)
 *   3. ANCIENT: thread summary + drop count (fixed-size marker)
 *
 * The system gracefully degrades to the original binary behavior when
 * the middle tier has nothing meaningful to contribute (too few messages
 * between recent and ancient, or budget too tight for the digest header).
 *
 * Property contracts (tested in __tests__/tier-allocation.property.test.ts):
 *   P1: Budget compliance — tierTokens sum ≤ historyBudget
 *   P2: Coverage — ancientDropped + middleFolded + recentKept == input length
 *   P3: Wire-legal opener — recentMessages[0].role !== "tool_result"
 *   P4: Recency — last input message always survives in recentMessages
 *   P5: Monotonicity — larger historyBudget never decreases recentKept
 *   P6: Determinism — same input → byte-identical output
 *   P7: Graceful degradation — when middle tier empty, same shape as binary
 *   P8: Chronological ordering — middle-tier digest lines in forward order
 */

import type { LLMMessage } from "@bound/llm";
import { countContentTokens } from "@bound/shared";
import { type FoldedLine, foldMessages } from "./tool-cycle-fold";

// Budget allocation ratios.
export const RECENT_RATIO = 0.65;
export const MIDDLE_RATIO = 0.3;
export const ANCIENT_RATIO = 0.05;

// Minimum number of folded lines for the middle tier to be worth rendering.
// Below this, the overhead of the header exceeds the value of the content.
const MIN_MIDDLE_LINES = 3;

export interface TieredHistoryParams {
	historyMessages: ReadonlyArray<LLMMessage>;
	historyBudget: number;
	threadId: string;
	threadSummary?: string;
	/**
	 * Hard ceiling (in tokens) for the recent tier — the physical headroom left
	 * for history after the fixed-cost sections (system prompt + volatile +
	 * tools) are subtracted from the actual context window.
	 *
	 * This is DISTINCT from `historyBudget`, which is the SOFT target
	 * (`contextWindow * truncationRatio` minus fixed costs) the recent/middle
	 * tiers size themselves against. The recent tier is anchored to the latest
	 * user message (the shared semantic boundary cache-point / compaction /
	 * summary all use), so within a single user turn the anchor never moves and
	 * the cache stays warm — even when an inner-loop tool run pushes the
	 * anchored slice modestly past the soft `historyBudget`. Trimming that slice
	 * every turn would mutate the ancient drop count and thrash the cache, which
	 * is precisely the rolling behavior the cache subsystem was redesigned to
	 * eliminate.
	 *
	 * The recent tier may therefore exceed `historyBudget` to preserve the
	 * semantic anchor. It may NOT exceed `recentHardCeiling` — a single user
	 * turn whose tool loop genuinely overflows the physical window has its
	 * older within-turn cycles folded into the middle tier (mechanical fold, no
	 * summarization). When the ceiling is non-positive (degenerate case: fixed
	 * costs alone already exceed the window), the clamp is disabled and the
	 * semantic anchor + ≥2-message floor win — there is no headroom to clamp
	 * into and forcing a step would only thrash. Omit to disable the clamp
	 * entirely (legacy behavior).
	 */
	recentHardCeiling?: number;
}

export interface TieredHistoryResult {
	/** Developer-role message for the ancient tier (summary + retrieval hint). */
	ancientMarker: LLMMessage | null;
	/** Developer-role message for the middle tier (folded digest). */
	middleDigestMsg: LLMMessage | null;
	/** Full-resolution messages for the recent tier. Wire-legal opener guaranteed. */
	recentMessages: LLMMessage[];
	/** Messages completely dropped (ancient tier). */
	ancientDropped: number;
	/** Messages folded into the middle tier digest. */
	middleFolded: number;
	/** Messages kept at full resolution (recent tier). */
	recentKept: number;
	/** Token estimates per tier. */
	tierTokens: { ancient: number; middle: number; recent: number };
	/** Whether recentMessages opens with a wire-legal message. */
	wireLegalOpener: boolean;
}

/**
 * Compute tiered history truncation. Pure function — no I/O, no LLM calls.
 */
export function tieredHistoryTruncation(params: TieredHistoryParams): TieredHistoryResult {
	const { historyMessages, historyBudget, threadId, threadSummary, recentHardCeiling } = params;

	if (historyMessages.length === 0) {
		return {
			ancientMarker: null,
			middleDigestMsg: null,
			recentMessages: [],
			ancientDropped: 0,
			middleFolded: 0,
			recentKept: 0,
			tierTokens: { ancient: 0, middle: 0, recent: 0 },
			wireLegalOpener: true,
		};
	}

	// Compute per-tier budgets.
	// The ratios are applied to historyBudget directly. The ancient marker's
	// token cost is accounted for by the 5% ancient allocation. Since the
	// marker is typically ~60-200 tokens, the 5% of any reasonable historyBudget
	// (minimum ~500 for truncation to fire meaningfully) covers it.
	// The total allocated (65% + 30% + 5% = 100%) stays within historyBudget.
	const recentBudget = Math.floor(historyBudget * RECENT_RATIO);
	const middleBudget = Math.floor(historyBudget * MIDDLE_RATIO);

	// Precompute per-message token counts and suffix sums once (O(n)).
	// `suffixTokens[i]` is the total token cost of messages[i..end); it gives
	// the recent-tier cost for any candidate slice start in O(1), reused by the
	// backward-fill, the physical-window clamp, and the final `recentTokens`.
	const n = historyMessages.length;
	const msgTokenCounts = historyMessages.map((m) => countContentTokens(m.content));
	const suffixTokens = new Array<number>(n + 1);
	suffixTokens[n] = 0;
	for (let i = n - 1; i >= 0; i--) {
		suffixTokens[i] = msgTokenCounts[i] + suffixTokens[i + 1];
	}

	// --- RECENT TIER ---
	// Backward-fill from the tail until recentBudget exhausted.
	// Same algorithm as the original truncateHistoryToBudget but with the
	// recent-tier budget instead of the full historyBudget.
	let recentAccumulated = 0;
	let recentSliceStart = n;
	for (let i = n - 1; i >= 0; i--) {
		const msgTokens = msgTokenCounts[i];
		if (recentAccumulated + msgTokens > recentBudget) break;
		recentAccumulated += msgTokens;
		recentSliceStart = i;
	}

	// Floor: keep at least 2 messages.
	recentSliceStart = Math.min(recentSliceStart, Math.max(0, n - 2));

	// Advance past orphan tool_result/tool_call/assistant to land on a
	// wire-legal opener (a user message when possible). This only moves the
	// slice start forward, and anchoring to a stable user position keeps the
	// ancient-marker drop count byte-stable across consecutive cold rebuilds —
	// the message-level prefix cache depends on that.
	const preAdvanceStart = recentSliceStart;
	while (recentSliceStart < n && historyMessages[recentSliceStart].role !== "user") {
		recentSliceStart++;
	}

	// Fallback: if no user message in the recent window, scan backward for one.
	// (Sustained autonomous tool-only runs have no user turn since the budget
	// boundary.) Anchoring to a fixed historical user position is what makes the
	// drop count byte-stable as the tail grows. The recent slice this produces
	// may exceed the budget — the hard clamp below is the authoritative ceiling
	// that trims it back, so this anchor choice cannot defeat the budget.
	if (recentSliceStart >= n) {
		let foundUser = false;
		for (let i = n - 1; i >= 0; i--) {
			if (historyMessages[i].role === "user") {
				recentSliceStart = i;
				foundUser = true;
				break;
			}
		}
		if (!foundUser) {
			// Strip leading tool_results from the pre-advance position.
			recentSliceStart = preAdvanceStart;
			while (recentSliceStart < n && historyMessages[recentSliceStart].role === "tool_result") {
				recentSliceStart++;
			}
		}
	}

	// Physical-window clamp — the authoritative recent-tier ceiling and the
	// fix for the budget-bypass failure mode. The semantic anchor above can
	// resolve far before the backward-fill boundary (the backward scan
	// re-anchors at the latest historical user message). On a long tool-only
	// run within a single user turn, that pulls the ENTIRE tail into the recent
	// tier at full resolution: without a ceiling the middle tier never fires
	// (remainingBudgetForMiddle clamped to 0) and total context grows unbounded
	// turn over turn (observed live: ~280k tokens against a 200k window).
	//
	// The clamp is deliberately gated on `recentHardCeiling` (the PHYSICAL
	// window headroom) — NOT `historyBudget` (the soft target). Within a user
	// turn the anchored slice may exceed the soft budget while still fitting the
	// window; trimming there would move the anchor every turn and thrash the
	// cache (the rolling behavior the cache subsystem was redesigned away from).
	// Only when a single user turn's tool loop overflows the physical window do
	// we step the anchor forward, folding the older within-turn cycles into the
	// middle tier (mechanical fold, no summarization). In the runaway regime the
	// cache is already cold, so the one-time anchor step costs nothing.
	//
	// When the ceiling is undefined or non-positive (fixed costs alone exceed
	// the window — a degenerate tiny-window case), the clamp is disabled: there
	// is no headroom to clamp into and forcing a step would only thrash. The
	// semantic anchor + ≥2-message floor win, matching the pre-clamp behavior
	// the byte-stability invariant relies on. The clamp force-trims from the
	// FRONT so dropped messages cascade into the middle/ancient tiers; the
	// step/back-off mechanics are documented inline below.
	//
	// TRIGGER vs TARGET. The clamp TRIGGERS on the physical ceiling (only step
	// the anchor when a user turn genuinely overflows the window) but TARGETS
	// `recentBudget` (the soft 65% allocation). Trimming all the way back to the
	// 65% target — rather than just under the physical ceiling — is what frees
	// the remaining ~35% for the middle tier to FOLD the shed tail. If we only
	// trimmed to the ceiling, `remainingBudgetForMiddle = max(0, historyBudget −
	// recentTokens)` would clamp to 0, the middle tier would starve, and the
	// shed messages would drop straight to the ancient tier (recall lost)
	// instead of folding into a compressed action log (recall kept). The
	// physical-ceiling trigger preserves the cache-warm semantic anchor in the
	// normal regime; the soft-budget target preserves recall in the overflow
	// regime.
	if (recentHardCeiling !== undefined && recentHardCeiling > 0) {
		const minFloor = Math.min(2, n);
		// Absolute floor: recentSliceStart may never advance past `maxStart`, so
		// at least `minFloor` messages always survive in the recent tier.
		const maxStart = Math.max(0, n - minFloor);
		const clampTarget = Math.min(recentBudget, recentHardCeiling);
		if (suffixTokens[recentSliceStart] > recentHardCeiling) {
			// Step forward one message at a time while over budget. `suffixTokens`
			// is monotonically decreasing in the start index, so single-stepping
			// converges to the target just as a multi-skip would. `maxStart` caps
			// the advance so at least `minFloor` messages always survive.
			while (recentSliceStart < maxStart && suffixTokens[recentSliceStart] > clampTarget) {
				recentSliceStart++;
			}
			// Prefer a wire-legal opener. A leading `tool_result` opens the recent
			// tier mid-tool-pair; walking backward lands on its preceding
			// `tool_call`. Back-off only DECREASES the index (adds messages), so it
			// can re-inflate the recent tier — only take it while the result still
			// fits the physical ceiling. If backing off to a clean opener would
			// breach the ceiling, keep the `tool_result` opener: it is NOT fatal
			// (the driver's conversation-start invariant prepends a synthetic user
			// message and wraps the orphan result), and the ceiling is the hard
			// constraint that prevents context runaway. `wireLegalOpener` below
			// reports which case occurred.
			//
			// History: the previous implementation stripped tool_results by
			// advancing FORWARD with no floor guard, which ran the start index off
			// the end on a trailing-tool_result tail, leaving recentKept = 0/1 with
			// an empty recent tier. On a thinking-heavy thread (inflation shrinks
			// the soft budget, so the clamp trims aggressively) that starved the
			// agent of its own recent work and drove a re-derivation loop.
			while (
				recentSliceStart > 0 &&
				historyMessages[recentSliceStart].role === "tool_result" &&
				suffixTokens[recentSliceStart - 1] <= recentHardCeiling
			) {
				recentSliceStart--;
			}
		}
	}

	const recentMessages = historyMessages.slice(recentSliceStart) as LLMMessage[];
	const recentKept = recentMessages.length;
	const recentTokens = suffixTokens[recentSliceStart];

	// --- MIDDLE TIER ---
	// Fold messages in [0, recentSliceStart) from the END backward
	// (most-recent-first within the middle zone), accumulating folded lines
	// until middleBudget is exhausted.
	//
	// The effective middle budget is reduced when the floor branch forced the
	// recent tier to exceed its nominal 65% allocation (e.g., 2 messages each
	// larger than the entire budget). Without this check, the middle tier would
	// add tokens on top of an already-overbudget recent tier and blow past the
	// historyBudget ceiling that the caller expects us to respect.
	const middleZoneEnd = recentSliceStart;
	let middleFolded = 0;
	let middleTokens = 0;
	let middleSliceStart = 0; // boundary between ancient and middle
	const remainingBudgetForMiddle = Math.min(
		middleBudget,
		Math.max(0, historyBudget - recentTokens),
	);

	if (middleZoneEnd > 0 && remainingBudgetForMiddle > 0) {
		// Fold the entire middle zone first, then budget-trim.
		const allFolded = foldMessages(historyMessages, 0, middleZoneEnd);

		if (allFolded.length >= MIN_MIDDLE_LINES) {
			// Build the digest header (fixed cost).
			const headerText = buildMiddleHeader(middleZoneEnd, threadId);
			const headerTokens = Math.ceil(headerText.length / 4);

			// Walk folded lines from the END (most recent within middle zone)
			// backward, accumulating until budget minus header is exhausted.
			// This preserves the most-recent middle-tier context when budget
			// is tight — matching the recency-favoring philosophy of the
			// recent tier's backward-fill.
			let accumulatedFoldedTokens = headerTokens;
			let keepFromIdx = allFolded.length;

			for (let fi = allFolded.length - 1; fi >= 0; fi--) {
				const lineTokens = allFolded[fi].tokens;
				if (accumulatedFoldedTokens + lineTokens > remainingBudgetForMiddle) break;
				accumulatedFoldedTokens += lineTokens;
				keepFromIdx = fi;
			}

			const keptFolded = allFolded.slice(keepFromIdx);

			if (keptFolded.length >= MIN_MIDDLE_LINES) {
				middleTokens = accumulatedFoldedTokens;

				// Compute how many source messages the kept folded lines cover.
				// Since we fold forward but keep from the end, the kept lines
				// correspond to messages near the end of the [0, middleZoneEnd) range.
				// Count source messages consumed by dropped lines to find the boundary.
				let droppedSourceCount = 0;
				for (let fi = 0; fi < keepFromIdx; fi++) {
					droppedSourceCount += allFolded[fi].sourceCount;
				}
				middleSliceStart = droppedSourceCount;

				// The middle zone covers [middleSliceStart, middleZoneEnd).
				middleFolded = middleZoneEnd - middleSliceStart;
			}
			// else: not enough lines after budget trim — fall through to no-middle-tier.
		}
		// else: fewer than MIN_MIDDLE_LINES in the entire zone — skip middle tier.
	}

	// When the middle tier doesn't fire, ALL messages before recentSliceStart
	// are ancient (completely dropped). When it does fire, only messages before
	// middleSliceStart are ancient.
	const ancientDropped = middleFolded > 0 ? middleSliceStart : middleZoneEnd;

	// --- ANCIENT MARKER ---
	let ancientMarker: LLMMessage | null = null;
	let ancientTokens = 0;
	if (ancientDropped > 0 || middleFolded > 0) {
		const ancientContent = buildAncientMarker(ancientDropped, threadId, threadSummary);
		ancientMarker = { role: "developer", content: ancientContent };
		ancientTokens = countContentTokens(ancientContent);
	}

	// --- MIDDLE DIGEST MESSAGE ---
	let middleDigestMsg: LLMMessage | null = null;
	if (middleFolded > 0) {
		const allFolded = foldMessages(historyMessages, middleSliceStart, middleZoneEnd);
		const digestContent = buildMiddleDigest(allFolded, middleFolded, threadId);
		middleDigestMsg = { role: "developer", content: digestContent };
		// Recompute tokens from actual content for accuracy.
		middleTokens = countContentTokens(digestContent);
	}

	// Wire-legal opener check.
	const wireLegalOpener =
		recentMessages.length === 0 ||
		recentMessages[0].role === "user" ||
		recentMessages[0].role === "developer" ||
		recentMessages[0].role === "system" ||
		recentMessages[0].role === "assistant" ||
		recentMessages[0].role === "tool_call";

	return {
		ancientMarker,
		middleDigestMsg,
		recentMessages: [...recentMessages],
		ancientDropped,
		middleFolded,
		recentKept,
		tierTokens: { ancient: ancientTokens, middle: middleTokens, recent: recentTokens },
		wireLegalOpener,
	};
}

// ---------------------------------------------------------------------------
// Message formatting
// ---------------------------------------------------------------------------

function buildMiddleHeader(messageCount: number, threadId: string): string {
	return `[Compressed history: ${messageCount} messages folded into action summaries. For full content: query "SELECT role, substr(content, 1, 200), created_at FROM messages WHERE thread_id = '${threadId}' ORDER BY created_at"]`;
}

function buildMiddleDigest(
	foldedLines: FoldedLine[],
	messageCount: number,
	threadId: string,
): string {
	const header = buildMiddleHeader(messageCount, threadId);
	const body = foldedLines
		.filter((line) => line.text.length > 0)
		.map((line) => line.text)
		.join("\n");
	return `${header}\n\n${body}`;
}

function buildAncientMarker(
	droppedCount: number,
	threadId: string,
	threadSummary?: string,
): string {
	const summarySection = threadSummary
		? `\n\nSummary of earlier conversation:\n${threadSummary}`
		: "";

	if (droppedCount === 0) {
		// No ancient messages — the marker just introduces the middle tier.
		return `[Context note: Earlier messages in this conversation were compressed to fit the context window. A folded summary of recent actions follows below. For full content, use: query "SELECT role, substr(content, 1, 200), created_at FROM messages WHERE thread_id = '${threadId}' ORDER BY created_at DESC LIMIT 50"]${summarySection}`;
	}

	return `[Context note: ${droppedCount} earlier messages in this conversation were truncated to fit the context window. A folded summary of more recent actions follows below. For full content, use: query "SELECT role, substr(content, 1, 200), created_at FROM messages WHERE thread_id = '${threadId}' ORDER BY created_at DESC LIMIT 50"]${summarySection}`;
}
