/**
 * Stage 7 BUDGET_VALIDATION — token-aware backward-fill history
 * truncation.
 *
 * The pipeline's last line of defense before the wire. If we
 * over-truncate, the agent loses recent user context (sliding
 * sawtooth, fixed in 2026-04-01 by replacing keep-last-N with
 * token-aware backward-fill). If we under-truncate, we overflow
 * the backend's true context window — Bedrock and Anthropic both
 * reject the entire request, the turn fails, and the user sees
 * "context_length_exceeded" in the alert log.
 *
 * Two failure modes the algorithm specifically defends against:
 *
 *   1. **Sliding amputation** (pre-2026-04-01): hardcoded
 *      `historyMessages.length - 10` would cut at a fixed-N
 *      boundary regardless of how token-heavy the kept window
 *      was. A thread with 10 verbose tool errors would push the
 *      most-recent user message out of the slice.
 *
 *   2. **Wire-illegal openers** (incident 2026-05-XX): a
 *      backward-fill that lands the slice on a `tool_result` row
 *      whose `tool_call` partner was sliced off triggers Bedrock's
 *      "Expected toolResult blocks at messages.0.content for the
 *      following Ids: …" rejection. The forward-scan-to-user
 *      advance is what avoids this — but only when there IS a user
 *      somewhere in the kept window. Scheduled task threads with
 *      only system wakeup + tool cycles have no users, so the
 *      fallback path scans backward to the last user OR strips
 *      leading orphan tool_results until a wire-legal opener
 *      surfaces.
 *
 * Properties pinned by `__tests__/truncate.property.test.ts`:
 *
 *   B1 Budget compliance — post-truncation total ≤ historyBudget.
 *   B2 Floor preservation — at least 2 messages survive when input
 *      had ≥ 2 (or all messages survive when input had < 2).
 *   B3 Wire-legal opener — kept slice opens with `user`, OR the
 *      first kept message is a `tool_call` followed by its
 *      `tool_result` (synthesized opener from Stage 3 sanitizer).
 *      The forbidden state: kept slice opens with a `tool_result`.
 *   B4 Recency preservation — when a budget exists, the LAST
 *      message of the input always survives.
 *   B5 Non-monotonicity in budget — increasing the budget never
 *      DECREASES the kept count.
 *   B6 Determinism — same `(messages, budget)` returns same
 *      result.
 *   B7 Empty input → empty output, truncatedCount = 0.
 */

export {
	truncateHistoryToBudget,
	type TruncateHistoryParams,
	type TruncateHistoryResult,
} from "./truncate";
