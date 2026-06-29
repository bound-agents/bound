/**
 * Property tests for Stage 1.7 history compaction.
 *
 * The cache-stability invariant (H2) is THE big one. Pre-fix, the
 * compaction boundary slid forward by 2 every warm/cold pass as
 * new assistant + tool_result rows appended, mutating
 * previously-preserved tool_result bytes and busting the
 * provider's prefix cache. The user-anchored boundary stops the
 * slide.
 *
 * Properties:
 *
 *   H1 Boundary anchoring — when a user message exists, boundary
 *      equals the LAST user message's index.
 *   H2 Cache stability — appending assistant + tool_result after
 *      the last user does NOT change the boundary. (the big one)
 *   H3 User-shift — appending a user message DOES advance the
 *      boundary forward.
 *   H4 Fallback path — when no user exists, boundary is
 *      max(0, length - recentWindow).
 *   H5 compactToolResultsBeforeBoundary idempotence — re-running
 *      on already-compacted output produces no further changes.
 *   H6 Compaction threshold — only tool_result rows with content
 *      > COLD_COMPACTION_THRESHOLD get stubbed.
 *   H7 Pre-boundary scope — messages at index >= boundary are
 *      never modified.
 */

import { describe, expect, it } from "bun:test";
import { type Message, countContentTokens } from "@bound/shared";
import fc from "fast-check";
import { COLD_COMPACTION_THRESHOLD } from "../../warm-compaction";
import {
	compactToolResultsBeforeBoundary,
	computeCompactionBoundary,
	stripThinkingBeforeBoundary,
} from "../compact";

const FIXED_NOW = "2026-05-25T12:00:00.000Z";
const THREAD_ID = "test-thread";

function msg(role: Message["role"], id: string, content: string): Message {
	return {
		id,
		thread_id: THREAD_ID,
		role,
		content,
		model_id: null,
		tool_name: null,
		created_at: FIXED_NOW,
		modified_at: FIXED_NOW,
		host_origin: "test",
		deleted: 0,
		exit_code: null,
		metadata: null,
	};
}

const safeContent = fc.string({ minLength: 0, maxLength: 60 }).filter((s) => !/[\n\r]/.test(s));

const safeRole = fc.constantFrom<Message["role"]>(
	"user",
	"assistant",
	"developer",
	"tool_call",
	"tool_result",
);

const messageArb: fc.Arbitrary<Message> = fc
	.tuple(safeRole, fc.uuid(), safeContent)
	.map(([role, id, content]) => msg(role, id, content));

describe("computeCompactionBoundary — property tests", () => {
	it("H1: boundary equals last user message's index when a user exists", () => {
		fc.assert(
			fc.property(
				fc.array(messageArb, { minLength: 1, maxLength: 20 }),
				fc.integer({ min: 1, max: 20 }),
				(msgs, recentWindow) => {
					// Find the actual last-user index.
					let expected = -1;
					for (let i = msgs.length - 1; i >= 0; i--) {
						if (msgs[i].role === "user") {
							expected = i;
							break;
						}
					}
					const result = computeCompactionBoundary(msgs, recentWindow);
					if (expected >= 0) return result === expected;
					// No user message — fallback path.
					return result === Math.max(0, msgs.length - recentWindow);
				},
			),
			{ numRuns: 100 },
		);
	});

	it("H2: cache stability — appending assistant + tool_result after last user doesn't shift boundary", () => {
		// THE big invariant. Pre-fix this would have failed on every
		// LLM round-trip because the boundary was `length - recentWindow`
		// which slides by 2 with each pair appended.
		fc.assert(
			fc.property(
				fc
					.array(messageArb, { minLength: 1, maxLength: 15 })
					.filter((msgs) => msgs.some((m) => m.role === "user")),
				safeContent,
				safeContent,
				fc.integer({ min: 1, max: 20 }),
				(baseMsgs, assistantContent, toolResultContent, recentWindow) => {
					const baseBoundary = computeCompactionBoundary(baseMsgs, recentWindow);
					const grown: Message[] = [
						...baseMsgs,
						msg("assistant", "appended-assist", assistantContent),
						msg("tool_result", "appended-tr", toolResultContent),
					];
					const grownBoundary = computeCompactionBoundary(grown, recentWindow);
					return grownBoundary === baseBoundary;
				},
			),
			{ numRuns: 100 },
		);
	});

	it("H3: user-shift — appending a user message DOES advance the boundary", () => {
		fc.assert(
			fc.property(
				fc
					.array(messageArb, { minLength: 1, maxLength: 10 })
					.filter((msgs) => msgs.some((m) => m.role === "user")),
				safeContent,
				fc.integer({ min: 1, max: 20 }),
				(baseMsgs, userContent, recentWindow) => {
					const grown: Message[] = [...baseMsgs, msg("user", "appended-user", userContent)];
					const grownBoundary = computeCompactionBoundary(grown, recentWindow);
					// New boundary should be exactly the new user's index.
					return grownBoundary === baseMsgs.length;
				},
			),
			{ numRuns: 100 },
		);
	});

	it("H4: fallback — no user message ⇒ boundary = max(0, length - recentWindow)", () => {
		fc.assert(
			fc.property(
				fc.array(messageArb, { minLength: 0, maxLength: 20 }).map((msgs) =>
					// Filter out any users from the generated sequence.
					msgs.filter((m) => m.role !== "user"),
				),
				fc.integer({ min: 1, max: 20 }),
				(noUserMsgs, recentWindow) => {
					const result = computeCompactionBoundary(noUserMsgs, recentWindow);
					return result === Math.max(0, noUserMsgs.length - recentWindow);
				},
			),
			{ numRuns: 100 },
		);
	});
});

describe("compactToolResultsBeforeBoundary — property tests", () => {
	it("H5: idempotence — re-running on compacted output produces no further changes", () => {
		fc.assert(
			fc.property(
				fc.array(messageArb, { minLength: 1, maxLength: 10 }),
				fc.integer({ min: 0, max: 10 }),
				(msgs, boundary) => {
					const a = msgs.map((m) => ({ ...m }));
					const b = msgs.map((m) => ({ ...m }));
					// budget=0 forces over-budget so stubbing fires; idempotence is
					// about re-running producing no further change.
					compactToolResultsBeforeBoundary(a, boundary, 0);
					compactToolResultsBeforeBoundary(b, boundary, 0);
					compactToolResultsBeforeBoundary(b, boundary, 0); // second pass
					return JSON.stringify(a) === JSON.stringify(b);
				},
			),
			{ numRuns: 100 },
		);
	});

	it("H6: compaction threshold — short tool_results pass through unchanged", () => {
		fc.assert(
			fc.property(
				fc
					.string({ minLength: 0, maxLength: COLD_COMPACTION_THRESHOLD })
					.filter((s) => !/[\n\r]/.test(s)),
				(content) => {
					const msgs: Message[] = [msg("tool_result", "tr-short", content), msg("user", "u", "x")];
					compactToolResultsBeforeBoundary(msgs, 1, 0);
					// Short tool_result should be unchanged.
					return msgs[0].content === content;
				},
			),
			{ numRuns: 50 },
		);
	});

	it("H6b: compaction threshold — long tool_results get stubbed when over budget", () => {
		const longContent = "x".repeat(COLD_COMPACTION_THRESHOLD + 100);
		const msgs: Message[] = [msg("tool_result", "tr-long", longContent), msg("user", "u", "later")];
		// budget=0 forces over-budget so stubbing fires.
		compactToolResultsBeforeBoundary(msgs, 1, 0);
		if (msgs[0].content === longContent) {
			throw new Error("long tool_result was not stubbed");
		}
		if (!msgs[0].content.includes("[Tool result truncated for inline display")) {
			throw new Error("stub format regression");
		}
	});

	it("H6c: budget gate — long tool_results are PRESERVED when under budget", () => {
		// The bug this guards: compaction destroyed read results at ~23% context
		// fill, forcing the model to re-read and never converge. With headroom
		// (estimate <= budget), nothing is stubbed.
		const longContent = "x".repeat(COLD_COMPACTION_THRESHOLD + 5000);
		const msgs: Message[] = [msg("tool_result", "tr-long", longContent), msg("user", "u", "later")];
		const stubbed = compactToolResultsBeforeBoundary(msgs, 1, 1_000_000);
		expect(stubbed).toBe(0);
		expect(msgs[0].content).toBe(longContent);
	});

	it("H6d: greedy — stubs only enough to fall under budget, newest-first preserved", () => {
		// Three large results before the boundary; a budget that needs only the
		// oldest one or two reclaimed. The most recent read (the model's freshest
		// finding) must survive. Budget is in TOKENS (what the gate measures).
		const body = "y ".repeat(10_000); // ~10k tokens each, well over threshold
		const big = (n: string) => msg("tool_result", n, body);
		const msgs: Message[] = [big("oldest"), big("middle"), big("newest"), msg("user", "u", "x")];
		const totalTokens = msgs.reduce((s, m) => s + countContentTokens(m.content), 0);
		// Budget that requires reclaiming roughly one result's worth of tokens.
		const stubbed = compactToolResultsBeforeBoundary(msgs, 3, Math.floor(totalTokens * 0.7));
		expect(stubbed).toBeGreaterThan(0);
		// The newest (closest to boundary) should be the last to be stubbed.
		expect(msgs[2].content).toBe(body);
	});

	it("H7: pre-boundary scope — messages at index >= boundary are never modified", () => {
		fc.assert(
			fc.property(
				fc.array(messageArb, { minLength: 1, maxLength: 10 }),
				fc.integer({ min: 0, max: 10 }),
				(msgs, boundary) => {
					const before = msgs.map((m) => ({ ...m }));
					const after = msgs.map((m) => ({ ...m }));
					compactToolResultsBeforeBoundary(after, boundary, 0);
					// Messages at index >= boundary must be byte-equal.
					for (let i = boundary; i < msgs.length; i++) {
						if (after[i].content !== before[i].content) return false;
					}
					return true;
				},
			),
			{ numRuns: 100 },
		);
	});

	it("H7b: boundary scales which results compact (recent-window behavior)", () => {
		// Replaces the former end-to-end "scales recentWindow" integration test.
		// The boundary (derived from recentWindow upstream) gates how many of the
		// oldest results are eligible: a narrow window (high boundary) exposes
		// more results to compaction than a wide window (low/zero boundary).
		const big = (n: string) => msg("tool_result", n, "y".repeat(COLD_COMPACTION_THRESHOLD + 2000));
		const build = (): Message[] => [big("r0"), big("r1"), big("r2"), big("r3"), big("r4")];

		// Wide window → boundary 0: nothing eligible, all preserved (budget=0
		// forces over-budget, isolating the boundary's effect).
		const wide = build();
		expect(compactToolResultsBeforeBoundary(wide, 0, 0)).toBe(0);

		// Narrow window → boundary 3: results 0..2 eligible, 3..4 protected.
		const narrow = build();
		const stubbed = compactToolResultsBeforeBoundary(narrow, 3, 0);
		expect(stubbed).toBeGreaterThan(0);
		expect(stubbed).toBeLessThanOrEqual(3);
		// The protected tail (indices >= boundary) is untouched.
		expect(narrow[3].content).toBe("y".repeat(COLD_COMPACTION_THRESHOLD + 2000));
		expect(narrow[4].content).toBe("y".repeat(COLD_COMPACTION_THRESHOLD + 2000));
	});
});

describe("stripThinkingBeforeBoundary — property tests", () => {
	it("H8: zero strips when below threshold", () => {
		// Construct a small message sequence that's well under any
		// reasonable threshold.
		const msgs: Message[] = [msg("user", "u1", "hi"), msg("assistant", "a1", "ok")];
		const stripped = stripThinkingBeforeBoundary(msgs, 2, 1_000_000);
		if (stripped !== 0) throw new Error("stripped above-threshold input");
	});

	it("H9: stripping touches only pre-boundary tool_call messages", () => {
		// We can't easily construct a tool_call with strippable thinking
		// from arbitraries (the format is provider-specific). This
		// property verifies the negative case: when no tool_call has
		// strippable thinking, the function reports 0 strips.
		fc.assert(
			fc.property(
				fc.array(messageArb, { minLength: 1, maxLength: 10 }),
				fc.integer({ min: 0, max: 10 }),
				(msgs, boundary) => {
					const before = msgs.map((m) => ({ ...m }));
					stripThinkingBeforeBoundary(msgs, boundary, 0);
					// Messages at index >= boundary must be byte-equal.
					for (let i = boundary; i < msgs.length; i++) {
						if (msgs[i].content !== before[i].content) return false;
					}
					return true;
				},
			),
			{ numRuns: 100 },
		);
	});
});
