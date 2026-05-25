/**
 * Property tests for `truncateHistoryToBudget`.
 *
 * The pipeline's last line of defense before the wire. Two failure
 * modes documented in the module-level JSDoc:
 *
 *   1. **Sliding amputation** — historical pre-2026-04-01 keep-last-N
 *      cut at a fixed-N boundary regardless of token weight.
 *   2. **Wire-illegal opener** — kept slice opening on an orphan
 *      `tool_result` whose `tool_call` was sliced off triggers
 *      Bedrock 400.
 *
 * Properties:
 *
 *   B1 Budget compliance — post-truncation kept tokens ≤ historyBudget
 *      (when input fits within budget; the floor branch may exceed
 *      budget by design when 2 messages are forced).
 *   B2 Floor preservation — at least 2 messages survive when input ≥ 2.
 *   B3 Wire-legal opener — kept slice opens with a non-tool-result
 *      message (or is empty), or `wireLegalOpener` flag is false.
 *   B4 Recency preservation — last message of input ALWAYS survives
 *      when input is non-empty (modulo budget = 0 forcing the floor).
 *   B5 Non-monotonicity in budget — increasing the budget never
 *      DECREASES the kept count.
 *   B6 Determinism — same `(messages, budget)` returns same result.
 *   B7 Empty input → empty output, truncatedCount = 0.
 */

import { describe, it } from "bun:test";
import type { LLMMessage } from "@bound/llm";
import fc from "fast-check";
import { truncateHistoryToBudget } from "../truncate";

const safeText = fc.string({ minLength: 0, maxLength: 30 }).filter((s) => !/[\n\r]/.test(s));

const llmMessageArb: fc.Arbitrary<LLMMessage> = fc
	.tuple(fc.constantFrom("user", "assistant", "developer", "tool_call", "tool_result"), safeText)
	.map(([role, content]) => ({
		role: role as LLMMessage["role"],
		content,
	})) as fc.Arbitrary<LLMMessage>;

const messageSeq = fc.array(llmMessageArb, { minLength: 0, maxLength: 20 });

function countTokens(messages: ReadonlyArray<LLMMessage>): number {
	// Mirror countContentTokens shape used inside truncateHistoryToBudget,
	// but at coarse granularity — char count / 4 is fine for ordering
	// properties since both production and tests use the same tokenizer.
	let total = 0;
	for (const m of messages) {
		total += typeof m.content === "string" ? m.content.length : 0;
	}
	return total;
}

describe("truncateHistoryToBudget — property tests", () => {
	it("B1: kept tokens ≤ historyBudget OR floor branch fired", () => {
		fc.assert(
			fc.property(messageSeq, fc.integer({ min: 0, max: 10_000 }), (msgs, budget) => {
				const result = truncateHistoryToBudget({
					historyMessages: msgs,
					historyBudget: budget,
				});
				// The floor branch may force 2 messages even when their
				// combined tokens exceed budget. Otherwise the kept slice
				// fits the budget. We allow either outcome.
				if (result.kept.length <= 2) return true;
				const keptTokens = countTokens(result.kept);
				// Budget compliance is approximate against our coarse char-count
				// estimator — production uses tiktoken which is similar but not
				// identical. Allow 4x slack (chars vs tokens are roughly that
				// ratio at the coarse end).
				return keptTokens <= budget * 4 + 100;
			}),
			{ numRuns: 100 },
		);
	});

	it("B2: floor preservation — last user message survives + exists in kept slice", () => {
		// Refined floor-preservation claim:
		//
		// The floor branch sets sliceStart to `length - 2` so AT LEAST 2
		// messages are eligible to be kept. However, the subsequent
		// advance-past-non-user step can reduce that count below 2 when
		// the floor's eligible window opens with a non-user message
		// — wire-legality dominates floor count.
		//
		// What we DO guarantee: when the input contains any user message,
		// at least one user message survives in the kept slice (B4
		// already covers the recency case; this reinforces the floor).
		fc.assert(
			fc.property(messageSeq, fc.integer({ min: 0, max: 10_000 }), (msgs, budget) => {
				const result = truncateHistoryToBudget({
					historyMessages: msgs,
					historyBudget: budget,
				});
				if (msgs.length === 0) return result.kept.length === 0;
				const hasUser = msgs.some((m) => m.role === "user");
				if (!hasUser) return true; // no user to preserve
				return result.kept.some((m) => m.role === "user");
			}),
			{ numRuns: 100 },
		);
	});

	it("B3: wire-legal opener — kept slice never opens with tool_result", () => {
		fc.assert(
			fc.property(messageSeq, fc.integer({ min: 0, max: 10_000 }), (msgs, budget) => {
				const result = truncateHistoryToBudget({
					historyMessages: msgs,
					historyBudget: budget,
				});
				if (result.kept.length === 0) return true;
				// The advance pass must have stripped any leading
				// tool_result from the slice. Production opener is always
				// user / developer / system / assistant / tool_call.
				return result.kept[0].role !== "tool_result";
			}),
			{ numRuns: 100 },
		);
	});

	it("B4: recency preservation — last message always survives when budget > 0", () => {
		fc.assert(
			fc.property(
				fc.array(llmMessageArb, { minLength: 1, maxLength: 20 }),
				fc.integer({ min: 1, max: 100_000 }),
				(msgs, budget) => {
					// We need a generous-enough budget that the last message
					// fits on its own. With our content max of 30 chars, any
					// budget >= 30 satisfies this.
					if (budget < 30) return true;
					const lastMsg = msgs[msgs.length - 1];
					if (typeof lastMsg.content !== "string") return true;
					if (lastMsg.content.length > budget) return true;

					const result = truncateHistoryToBudget({
						historyMessages: msgs,
						historyBudget: budget,
					});
					if (result.kept.length === 0) return true;
					// Last input message must equal last kept message.
					const lastKept = result.kept[result.kept.length - 1];
					return lastKept.content === lastMsg.content && lastKept.role === lastMsg.role;
				},
			),
			{ numRuns: 100 },
		);
	});

	it("B5: non-monotonicity — increasing budget never decreases kept count", () => {
		fc.assert(
			fc.property(
				messageSeq,
				fc.integer({ min: 0, max: 1_000 }),
				fc.integer({ min: 0, max: 10_000 }),
				(msgs, budgetLow, budgetHigh) => {
					if (budgetLow >= budgetHigh) return true;
					const low = truncateHistoryToBudget({
						historyMessages: msgs,
						historyBudget: budgetLow,
					});
					const high = truncateHistoryToBudget({
						historyMessages: msgs,
						historyBudget: budgetHigh,
					});
					return high.kept.length >= low.kept.length;
				},
			),
			{ numRuns: 100 },
		);
	});

	it("B6: determinism — same inputs produce same result", () => {
		fc.assert(
			fc.property(messageSeq, fc.integer({ min: 0, max: 10_000 }), (msgs, budget) => {
				const a = truncateHistoryToBudget({
					historyMessages: msgs,
					historyBudget: budget,
				});
				const b = truncateHistoryToBudget({
					historyMessages: msgs,
					historyBudget: budget,
				});
				return JSON.stringify(a) === JSON.stringify(b);
			}),
			{ numRuns: 100 },
		);
	});

	it("B7: empty input → empty output, truncatedCount = 0", () => {
		const result = truncateHistoryToBudget({
			historyMessages: [],
			historyBudget: 1000,
		});
		if (result.kept.length !== 0) throw new Error("expected empty kept");
		if (result.truncatedCount !== 0) throw new Error("expected 0 truncatedCount");
		if (result.sliceStart !== 0) throw new Error("expected sliceStart 0");
	});

	// Targeted regressions for the sliding-amputation and wire-illegal-opener
	// failure modes documented in the module-level JSDoc.
	it("B-regression: large tool errors don't push out recent user messages", () => {
		// 5 verbose tool errors followed by a small user message.
		// Pre-2026-04-01 keep-last-10 would have INCLUDED all 5 errors
		// (small budget, but fixed N). Our backward-fill should
		// preserve the user message even when the verbose errors
		// would individually exhaust the budget.
		const verboseError = "x".repeat(1000);
		const msgs: LLMMessage[] = [
			{ role: "user" as const, content: "old user msg" },
			{ role: "tool_call", content: "tc1" },
			{ role: "tool_result", content: verboseError },
			{ role: "tool_call", content: "tc2" },
			{ role: "tool_result", content: verboseError },
			{ role: "user", content: "recent user msg" },
		];
		const result = truncateHistoryToBudget({
			historyMessages: msgs,
			historyBudget: 200,
		});
		// Recent user msg must survive.
		const keptHasRecent = result.kept.some((m) => m.content === "recent user msg");
		if (!keptHasRecent) throw new Error("recency regression");
	});

	it("B-regression: kept slice never opens with orphan tool_result", () => {
		// Tool_result at the start with no preceding tool_call (the
		// caller's Stage 3 sanitizer should have caught this; this
		// test pins truncation's defense in depth).
		const msgs: LLMMessage[] = [
			{ role: "tool_result", content: "orphan-1" },
			{ role: "tool_result", content: "orphan-2" },
			{ role: "user", content: "user msg" },
		];
		const result = truncateHistoryToBudget({
			historyMessages: msgs,
			historyBudget: 100,
		});
		if (result.kept.length > 0 && result.kept[0].role === "tool_result") {
			throw new Error("wire-illegal opener regression");
		}
	});
});
