/**
 * Token-aware history truncation. See `index.ts` for the
 * architectural rationale and post-condition contract.
 */

import type { LLMMessage } from "@bound/llm";
import { countContentTokens } from "@bound/shared";
import {
	type HistoryTokenCounter,
	findHistoryBoundary,
	isWireLegalHistoryOpener,
} from "../history-boundary";

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

const countMessageContentTokens: HistoryTokenCounter = (message) =>
	countContentTokens(message.content);

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

	const sliceStart = findHistoryBoundary(historyMessages, countMessageContentTokens, historyBudget);

	const kept = historyMessages.slice(sliceStart);
	const truncatedCount = historyMessages.length - kept.length;

	// Compute wireLegalOpener for the result.
	const wireLegalOpener = isWireLegalHistoryOpener(historyMessages, sliceStart);
	// Note: a leading `tool_result` is the only wire-illegal opener
	// after the advance/fallback chain. Production usually avoids
	// this via the placeholder user message that Bedrock prepends,
	// but we surface the flag for diagnostics regardless.

	return { kept: [...kept], truncatedCount, sliceStart, wireLegalOpener };
}
