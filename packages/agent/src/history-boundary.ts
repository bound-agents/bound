import type { LLMMessage } from "@bound/llm";

/** A token source that calculates a count only when the boundary scan reaches a message. */
export type HistoryTokenCounter = (message: LLMMessage, index: number) => number;

/**
 * Find the same history slice boundary used by binary and tiered truncation.
 * Token accounting remains with each caller: counts may be precomputed or
 * calculated lazily by the caller-provided counter.
 */
export function findHistoryBoundary(
	historyMessages: ReadonlyArray<LLMMessage>,
	tokenCounts: ReadonlyArray<number> | HistoryTokenCounter,
	historyBudget: number,
): number {
	const n = historyMessages.length;
	let accumulatedTokens = 0;
	let sliceStart = n;
	for (let i = n - 1; i >= 0; i--) {
		const msgTokens =
			typeof tokenCounts === "function" ? tokenCounts(historyMessages[i], i) : tokenCounts[i];
		if (accumulatedTokens + msgTokens > historyBudget) break;
		accumulatedTokens += msgTokens;
		sliceStart = i;
	}

	sliceStart = Math.min(sliceStart, Math.max(0, n - 2));
	const preAdvanceStart = sliceStart;
	while (sliceStart < n && historyMessages[sliceStart].role !== "user") sliceStart++;

	if (sliceStart >= n) {
		for (let i = n - 1; i >= 0; i--) {
			if (historyMessages[i].role === "user") return i;
		}
		sliceStart = preAdvanceStart;
		while (sliceStart < n && historyMessages[sliceStart].role === "tool_result") sliceStart++;
	}
	return sliceStart;
}

/** Whether a retained history suffix has a provider-legal opening message. */
export function isWireLegalHistoryOpener(
	historyMessages: ReadonlyArray<LLMMessage>,
	sliceStart: number,
): boolean {
	const message = historyMessages[sliceStart];
	return (
		message === undefined ||
		message.role === "user" ||
		message.role === "developer" ||
		message.role === "system" ||
		message.role === "assistant" ||
		message.role === "tool_call"
	);
}
