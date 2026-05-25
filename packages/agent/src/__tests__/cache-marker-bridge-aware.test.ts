/**
 * Regression tests for bridge-aware cache marker placement.
 *
 * Background. The AI SDK bridge merges a trailing run of `developer` messages
 * onto the preceding user message via `appendDevToUser`. Until 2026-05-26 the
 * cache marker was always spliced at `messages.length - 1` regardless of
 * whether the trailing message was a developer; that placement made the
 * cachePoint land on the user message the bridge subsequently mutated, which
 * folded the per-turn-varying volatile-tail content INTO the cached prefix.
 * Bedrock's prefix-matching cache then missed on every turn after the first.
 *
 * Live evidence (thread `927d4562-…` after the system-anchor fix landed):
 * `tokens_cache_read` held at exactly the system-prefix size (86,041 tokens)
 * on every post-restart turn, while `tokens_cache_write` climbed to 60,989
 * without ever reading back — the message-level marker was writing fresh
 * cache that the next turn could never match because the cachePoint user's
 * bytes shifted with each volatile-tail update.
 *
 * Properties pinned here:
 *
 *   M1 No trailing developer → placement unchanged (`length - 1`).
 *   M2 Trailing developer + preceding user → marker anchors BEFORE that user.
 *   M3 Multiple trailing developers → marker still anchors BEFORE the last
 *      non-developer user; the entire dev run stays outside the cachePoint.
 *   M4 Trailing developer with non-user preceding (assistant/tool_result) →
 *      marker placed at the start of the trailing-dev run; cachePoint
 *      attaches to the assistant/tool_result.
 *   M5 Index-0 result → reported as `too-short`. A marker at index 0 has no
 *      preceding message for the bridge to attach the cachePoint onto.
 *   M6 (load-bearing invariant) For ANY input whose last message is a
 *      developer, the message at the cachePoint target index — i.e.
 *      `messages[insertAt - 1]` after splice — MUST NOT be the user message
 *      that the bridge will merge the trailing-developer run into. Encoded
 *      as a fast-check property: violations reproduce the exact 11.05% hit
 *      rate regression observed in production.
 *   M7 Determinism — `computeCacheMarkerIndex` is a pure function of its
 *      input shape; same role-sequence yields the same index.
 */

import { describe, expect, it } from "bun:test";
import type { BackendCapabilities, LLMMessage } from "@bound/llm";
import fc from "fast-check";
import { maybePlaceCacheMarker } from "../cache-marker";

const CAPS: BackendCapabilities = {
	streaming: true,
	tool_use: true,
	system_prompt: true,
	prompt_caching: true,
	vision: true,
	extended_thinking: false,
	max_context: 200000,
};

describe("maybePlaceCacheMarker — bridge-aware placement", () => {
	it("M1: no trailing developer → marker at length - 1 (original behavior)", () => {
		const messages: LLMMessage[] = [
			{ role: "user", content: "u1" },
			{ role: "assistant", content: "a1" },
			{ role: "user", content: "u2" },
		];
		const placement = maybePlaceCacheMarker(messages, "fixed", CAPS);
		expect(placement.placed).toBe(true);
		expect(placement.index).toBe(2);
		// cachePoint will attach to messages[1] = a1, which is stable history.
		expect(messages[2]).toEqual({ role: "cache", content: "" });
		expect(messages[3]).toEqual({ role: "user", content: "u2" });
	});

	it("M2: trailing developer + preceding user → marker BEFORE that user", () => {
		const messages: LLMMessage[] = [
			{ role: "user", content: "u1" },
			{ role: "assistant", content: "a1" },
			{ role: "user", content: "u2" }, // bridge will merge dev into this
			{ role: "developer", content: "vol_tail" },
		];
		const placement = maybePlaceCacheMarker(messages, "fixed", CAPS);
		expect(placement.placed).toBe(true);
		// Marker at index 2 (the original position of the user_N), so cachePoint
		// attaches to messages[1] = the prior assistant message — stable bytes.
		expect(placement.index).toBe(2);
		expect(messages[2]).toEqual({ role: "cache", content: "" });
		expect(messages[3]).toEqual({ role: "user", content: "u2" });
		expect(messages[4]).toEqual({ role: "developer", content: "vol_tail" });
	});

	it("M3: multiple trailing developers → marker still anchors before the user", () => {
		const messages: LLMMessage[] = [
			{ role: "user", content: "u1" },
			{ role: "assistant", content: "a1" },
			{ role: "user", content: "u2" },
			{ role: "developer", content: "dev1" },
			{ role: "developer", content: "dev2" },
			{ role: "developer", content: "vol_tail" },
		];
		const placement = maybePlaceCacheMarker(messages, "fixed", CAPS);
		expect(placement.placed).toBe(true);
		expect(placement.index).toBe(2);
		// All three trailing developers stay outside the cachePoint.
		expect(messages.slice(3).map((m) => m.role)).toEqual([
			"user",
			"developer",
			"developer",
			"developer",
		]);
	});

	it("M4: trailing developer with assistant preceding → marker before the dev run", () => {
		// Bridge appends a NEW trailing user for the developer content rather
		// than mutating the assistant. Anchoring at the original position is
		// safe because the assistant doesn't get merged.
		const messages: LLMMessage[] = [
			{ role: "user", content: "u1" },
			{ role: "assistant", content: "a1" },
			{ role: "developer", content: "vol_tail" },
		];
		const placement = maybePlaceCacheMarker(messages, "fixed", CAPS);
		expect(placement.placed).toBe(true);
		// Marker at the start of the trailing-dev run (index 2 here).
		expect(placement.index).toBe(2);
		expect(messages[2]).toEqual({ role: "cache", content: "" });
	});

	it("M4b: trailing developer with tool_result preceding → marker before the dev run", () => {
		const messages: LLMMessage[] = [
			{ role: "user", content: "u1" },
			{ role: "tool_call", content: "[]" },
			{ role: "tool_result", content: "ok" },
			{ role: "developer", content: "vol_tail" },
		];
		const placement = maybePlaceCacheMarker(messages, "fixed", CAPS);
		expect(placement.placed).toBe(true);
		expect(placement.index).toBe(3);
	});

	it("M5: short input where placement would land at index 0 → reported as too-short", () => {
		// [user, dev]: bridge would merge dev into user; if we placed marker
		// at index 0, the bridge has no preceding message to attach the
		// cachePoint to and silently drops it. Treat as too-short.
		const messages: LLMMessage[] = [
			{ role: "user", content: "u1" },
			{ role: "developer", content: "vol_tail" },
		];
		const placement = maybePlaceCacheMarker(messages, "fixed", CAPS);
		expect(placement.placed).toBe(false);
		expect(placement.reason).toBe("too-short");
		expect(messages.length).toBe(2);
		expect(messages.some((m) => m.role === "cache")).toBe(false);
	});

	it("M5b: rolling marker gets the same bridge-aware placement on warm path", () => {
		// Mirrors the warm-path message shape after `step 5` in agent-loop.ts.
		const messages: LLMMessage[] = [
			{ role: "user", content: "u1" },
			{ role: "assistant", content: "a1" },
			{ role: "cache", content: "" }, // fixed marker from cold path
			{ role: "user", content: "u2" }, // delta user
			{ role: "developer", content: "fresh_vol_tail" },
		];
		const placement = maybePlaceCacheMarker(messages, "rolling", CAPS);
		expect(placement.placed).toBe(true);
		// Anchors before u2, which the bridge will mutate.
		expect(placement.index).toBe(3);
		expect(messages[3]).toEqual({ role: "cache", content: "" });
		expect(messages[4]).toEqual({ role: "user", content: "u2" });
	});
});

const roleArb = fc.constantFrom<LLMMessage["role"]>(
	"user",
	"assistant",
	"tool_call",
	"tool_result",
	"developer",
);

describe("maybePlaceCacheMarker — invariants (property tests)", () => {
	it("M6 (load-bearing): for any input ending in a developer, the cachePoint target is NOT the user that absorbs the trailing dev run", () => {
		fc.assert(
			fc.property(
				fc.array(roleArb, { minLength: 2, maxLength: 12 }).map((roles) => {
					// Force at least one trailing developer to exercise the
					// merge-target case; preserve the rest of the structure.
					const adjusted = [...roles];
					if (adjusted[adjusted.length - 1] !== "developer") {
						adjusted.push("developer");
					}
					return adjusted;
				}),
				(roles) => {
					const messages: LLMMessage[] = roles.map((role, i) => ({
						role,
						content: `msg-${i}`,
					}));
					// Snapshot pre-splice indices for the original messages so we can
					// identify them after `messages.splice` shifts later items.
					const preSpliceLen = messages.length;
					const placement = maybePlaceCacheMarker(messages, "fixed", CAPS);
					if (!placement.placed) return true; // too-short cases trivially satisfy
					if (placement.index === 0) return false; // index 0 should have been rejected
					// The cachePoint target is the message immediately before the
					// inserted cache marker.
					const target = messages[placement.index - 1];
					if (target.role === "cache") return false; // markers stacking on each other
					// Identify the merge-target user the bridge will mutate: walk
					// backwards from end (post-splice) skipping developers.
					let j = messages.length - 1;
					while (j >= 0 && messages[j].role === "developer") j--;
					const mergeTargetIsUser = j >= 0 && messages[j].role === "user";
					if (!mergeTargetIsUser) {
						// No merge mutation will occur; any preceding non-cache
						// message is fine as the cachePoint target.
						return true;
					}
					const mergeTargetIdx = j;
					// INVARIANT: cachePoint target index < merge-target index.
					// I.e. the message we're caching against is strictly before
					// the user the bridge will mutate.
					if (placement.index - 1 >= mergeTargetIdx) {
						console.error("invariant violation:", {
							preSpliceLen,
							roles,
							placementIndex: placement.index,
							mergeTargetIdx,
							messages: messages.map((m) => m.role),
						});
						return false;
					}
					return true;
				},
			),
			{ numRuns: 200 },
		);
	});

	it("M7: determinism — same role sequence yields the same insert index", () => {
		fc.assert(
			fc.property(fc.array(roleArb, { minLength: 2, maxLength: 12 }), (roles) => {
				const a: LLMMessage[] = roles.map((role, i) => ({ role, content: `c-${i}` }));
				const b: LLMMessage[] = roles.map((role, i) => ({ role, content: `c-${i}` }));
				const pa = maybePlaceCacheMarker(a, "fixed", CAPS);
				const pb = maybePlaceCacheMarker(b, "fixed", CAPS);
				return pa.placed === pb.placed && pa.index === pb.index && pa.reason === pb.reason;
			}),
			{ numRuns: 100 },
		);
	});

	it("M7b: cache marker is the only insertion — message count grows by exactly 1 (or 0 if skipped)", () => {
		fc.assert(
			fc.property(fc.array(roleArb, { minLength: 2, maxLength: 12 }), (roles) => {
				const messages: LLMMessage[] = roles.map((role, i) => ({ role, content: `c-${i}` }));
				const before = messages.length;
				const placement = maybePlaceCacheMarker(messages, "fixed", CAPS);
				const expectedDelta = placement.placed ? 1 : 0;
				return messages.length === before + expectedDelta;
			}),
			{ numRuns: 100 },
		);
	});
});
