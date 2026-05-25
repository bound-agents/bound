/**
 * Token-aware history truncation. See `index.ts` for the
 * architectural rationale and post-condition contract.
 */

import type { LLMMessage } from "@bound/llm";
import { countContentTokens } from "@bound/shared";

export interface TruncateHistoryParams {
	/**
	 * History messages — already filtered to exclude `system`-role
	 * rows by the caller (those count against `systemTokens`
	 * separately and are NEVER subject to truncation).
	 */
	historyMessages: ReadonlyArray<LLMMessage>;
	/**
	 * Token budget for the post-truncation history slice. Caller
	 * computes this as
	 *   `truncationTarget - systemMsgTokens - stablePrefixTokens - toolTokens`
	 * so all non-history fixed-cost components are subtracted up
	 * front. Negative or zero budgets are valid — they trigger the
	 * floor branch (keep at least 2 messages from the tail).
	 */
	historyBudget: number;
}

export interface TruncateHistoryResult {
	/**
	 * The kept slice. Always opens with a wire-legal first message
	 * per B3 (user, OR a tool_call+tool_result pair from Stage 3
	 * synthesis), unless the entire input was already wire-illegal
	 * — see `wireLegalOpener` for the precise condition.
	 */
	kept: LLMMessage[];
	/**
	 * Number of messages dropped from the front of the input.
	 * `historyMessages.length - kept.length`.
	 */
	truncatedCount: number;
	/**
	 * Index into `historyMessages` where `kept` begins. Useful for
	 * debug / logging.
	 */
	sliceStart: number;
	/**
	 * `true` when the kept slice opens with a wire-legal message.
	 * Caller can use this to log a warning for the rare case where
	 * the entire input was tool_call-only (no user, no tool_result-
	 * starting opener) and truncation couldn't produce a wire-legal
	 * slice — production almost never hits this.
	 */
	wireLegalOpener: boolean;
}

/**
 * Backward-fill from the end of `historyMessages`, accumulating
 * tokens until the budget is exhausted. Then advance the slice
 * start past leading orphan tool_results to land on a wire-legal
 * opener (user, or tool_call+tool_result pair).
 *
 * The full contract is documented at the property tests
 * (`__tests__/truncate.property.test.ts`); the inline comments
 * here flag the historical regressions each step defends against.
 */
export function truncateHistoryToBudget(params: TruncateHistoryParams): TruncateHistoryResult {
	const { historyMessages, historyBudget } = params;

	if (historyMessages.length === 0) {
		return { kept: [], truncatedCount: 0, sliceStart: 0, wireLegalOpener: true };
	}

	// Backward fill — accumulate tokens until we'd exceed budget.
	// Pre-2026-04-01 this was hardcoded `length - 10`, which slid
	// the kept window forward and amputated recent user messages
	// when bulky tool errors were present.
	let accumulatedTokens = 0;
	let sliceStart = historyMessages.length; // start at end (include nothing)
	for (let i = historyMessages.length - 1; i >= 0; i--) {
		const msgTokens = countContentTokens(historyMessages[i].content);
		if (accumulatedTokens + msgTokens > historyBudget) break;
		accumulatedTokens += msgTokens;
		sliceStart = i;
	}

	// Floor: keep at least 2 messages so the agent has something to
	// work with even when budget is unusually tight or the message
	// at the tail is huge enough to alone exceed the budget.
	sliceStart = Math.min(sliceStart, Math.max(0, historyMessages.length - 2));

	// Advance past orphan tool_result/tool_call/assistant boundaries
	// so the slice opens at a clean user message when possible.
	// Pre-fix Bedrock would 400 with "Expected toolResult blocks at
	// messages.0.content for the following Ids: …" when the slice
	// started on an orphan tool_result.
	const preAdvanceStart = sliceStart;
	while (sliceStart < historyMessages.length && historyMessages[sliceStart].role !== "user") {
		sliceStart++;
	}

	// Fallback path: scheduled task threads with only system wakeup +
	// tool cycles have no user message in the kept window. Scan back
	// to the last user message; if none exists, fall back to the
	// pre-advance position and strip leading tool_result rows so the
	// opener is at least a tool_call (well-formed pair) or a non-tool
	// message.
	if (sliceStart >= historyMessages.length) {
		let foundUser = false;
		for (let i = historyMessages.length - 1; i >= 0; i--) {
			if (historyMessages[i].role === "user") {
				sliceStart = i;
				foundUser = true;
				break;
			}
		}
		if (!foundUser) {
			sliceStart = preAdvanceStart;
			while (
				sliceStart < historyMessages.length &&
				historyMessages[sliceStart].role === "tool_result"
			) {
				sliceStart++;
			}
		}
	}

	const kept = historyMessages.slice(sliceStart);
	const truncatedCount = historyMessages.length - kept.length;

	// Compute wireLegalOpener for the result.
	const wireLegalOpener =
		kept.length === 0 ||
		kept[0].role === "user" ||
		kept[0].role === "developer" ||
		kept[0].role === "system" ||
		kept[0].role === "assistant" ||
		kept[0].role === "tool_call";
	// Note: a leading `tool_result` is the only wire-illegal opener
	// after the advance/fallback chain. Production usually avoids
	// this via the placeholder user message that Bedrock prepends,
	// but we surface the flag for diagnostics regardless.

	return { kept: [...kept], truncatedCount, sliceStart, wireLegalOpener };
}
