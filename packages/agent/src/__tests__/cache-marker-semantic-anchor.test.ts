/**
 * Semantic-anchor cache marker placement — the principled successor
 * to bucket-token alignment.
 *
 * Background. The bucket-token-aligned placer landed in 5b2f05fe was a
 * tuning knob: round the cachePoint's cumulative-token position DOWN to
 * the nearest 10,000-token boundary so consecutive turns within the
 * same bucket share a byte position. It worked when inner-loop tool
 * results were small. It thrashed when a single inner-loop iteration
 * produced a 20k+ token tool result — the bucket boundary advanced
 * past the prior cached position in one jump, Bedrock's ~20-content-
 * block lookback couldn't bridge the gap, the cumulative cache
 * orphaned.
 *
 * Live evidence (thread `192f8174-…` 19:33 → 19:35):
 *   turn 25 hist_tk=47,275  msg_bp=94,429
 *   turn 26 hist_tk=75,571  msg_bp=119,329  ← +28k token jump in one
 *                                              inner-loop iteration
 *   → 5 turns of cache_read stuck at the system-anchor floor while
 *     the new bucket primed from scratch.
 *
 * The fundamental issue: `bucketTokens` is a magic number. Pick 10k
 * and big tool results overflow; pick 50k and small inner-loops never
 * benefit; pick anything and you're tuning a symptom. There IS no
 * principled value of N for token-bucket math.
 *
 * Semantic anchoring. The cachePoint should anchor on bytes that
 * SEMANTICALLY don't change between consecutive inference calls of
 * the same user turn. Those bytes are persisted history from PRIOR
 * USER TURNS — immutable once written. The natural anchor is "the
 * end of the previous user turn's content", or equivalently: place
 * the cachePoint immediately before the LATEST user message.
 *
 * That's exactly what `computeCacheMarkerIndex` (the bridge-aware
 * placer from 76a0c0eb) already does for the trailing-dev case.
 * Adopting it for the cold-path placer too unifies the architecture
 * with the compaction-boundary semantics already used by the summary
 * throttle (0ce38fb0) — same boundary, advancing exactly when the
 * agent transitions to a new user turn.
 *
 * Invariants pinned here:
 *
 *   B1 (load-bearing) — within a single user turn, inner-loop appends
 *      of arbitrary tool result size MUST NOT move the cachePoint
 *      byte position. The bucket placer fails this for ≥10k token
 *      appends; semantic anchor passes regardless of append size.
 *
 *   B2 — cachePoint advances exactly when a new user message arrives.
 *      No spurious advancement from token-count math.
 *
 *   B3 — cachePoint position is monotonic across the thread lifetime.
 *      Once advanced, it never retreats.
 *
 *   B4 — cachePoint never lands inside a turn's content. It always
 *      sits at a turn boundary (between the prior turn's last msg
 *      and the next user msg).
 */

import { describe, expect, it } from "bun:test";
import type { BackendCapabilities, LLMMessage } from "@bound/llm";
import { coldPathPlaceCacheMarker } from "../cache-marker";

const CAPS: BackendCapabilities = {
	streaming: true,
	tool_use: true,
	system_prompt: true,
	prompt_caching: true,
	vision: true,
	extended_thinking: false,
	max_context: 200000,
};

function charEstimate(msg: LLMMessage): number {
	if (typeof msg.content === "string") return msg.content.length;
	let sum = 0;
	for (const block of msg.content) {
		if (block.type === "text") sum += block.text.length;
		else sum += JSON.stringify(block).length;
	}
	return sum;
}

function makeMsg(role: LLMMessage["role"], chars: number, tag = "x"): LLMMessage {
	const repeats = Math.max(1, Math.floor(chars / tag.length));
	let content = tag.repeat(repeats);
	while (content.length < chars) content += tag[0] ?? "x";
	return { role, content: content.slice(0, chars) };
}

/**
 * Compute the byte position of the spliced cache marker — sum of
 * estimateTokens over messages BEFORE the marker. Mirrors the wire
 * cumulative-token calculation Bedrock uses for its prefix-match
 * cachePoint lookup.
 */
function bytePositionOfMarker(messages: LLMMessage[]): number | null {
	let sum = 0;
	for (const m of messages) {
		if (m.role === "cache") return sum;
		if (m.role === "developer") continue;
		sum += charEstimate(m);
	}
	return null;
}

describe("Semantic-anchor cache marker placement (B1-B4)", () => {
	it("B1 (load-bearing): a 30k-token tool_result append in one inner-loop iteration MUST NOT move the cachePoint", () => {
		// Cold-path output before any inner-loop append. Outer turn just started
		// with user_N as the latest user message. dev is the volatile-tail.
		const baseHistory: LLMMessage[] = [];
		for (let i = 0; i < 8; i++) {
			baseHistory.push(makeMsg("user", 1500, `pu${i}`));
			baseHistory.push(makeMsg("assistant", 1500, `pa${i}`));
		}
		const baseMessages: LLMMessage[] = [
			...baseHistory,
			makeMsg("user", 800, "uN"), // user_N — the current outer turn's user msg
			makeMsg("developer", 600, "vt"), // dev_vol_tail
		];

		const placement1 = coldPathPlaceCacheMarker(
			baseMessages,
			{ bucketTokens: 10000, estimateTokens: charEstimate },
			CAPS,
		);
		expect(placement1.placed).toBe(true);
		const pos1 = bytePositionOfMarker(baseMessages);

		// Now simulate the inner loop appending a HUGE tool_call + tool_result.
		// This is what happens between cold-path runs when budget-exceeded
		// forces re-assembly: the DB has the new tool round persisted, so
		// assembleContext rebuilds from DB and includes the new content
		// BETWEEN user_N and dev_vol_tail.
		const messagesAfterToolRound: LLMMessage[] = [
			...baseHistory,
			makeMsg("user", 800, "uN"),
			makeMsg("tool_call", 200, "tc"),
			makeMsg("tool_result", 30000, "TR"), // 30k-token tool result — the cliff trigger
			makeMsg("developer", 600, "vt"),
		];

		const placement2 = coldPathPlaceCacheMarker(
			messagesAfterToolRound,
			{ bucketTokens: 10000, estimateTokens: charEstimate },
			CAPS,
		);
		expect(placement2.placed).toBe(true);
		const pos2 = bytePositionOfMarker(messagesAfterToolRound);

		// LOAD-BEARING: byte position MUST be unchanged. Same outer turn,
		// same user_N, same anchor. Bedrock's prefix-match cache continues
		// to hit at the unchanged position. With bucket-token math, pos2
		// would advance by ~30k tokens because the cumulative crossed
		// multiple bucket boundaries. With semantic anchor, pos2 == pos1.
		expect(pos2).toBe(pos1);
	});

	it("B2: cachePoint advances when a new user message arrives", () => {
		const messagesAtTurnN: LLMMessage[] = [
			makeMsg("user", 500, "u1"),
			makeMsg("assistant", 500, "a1"),
			makeMsg("user", 800, "uN"),
			makeMsg("developer", 600, "vt"),
		];
		const placement1 = coldPathPlaceCacheMarker(
			messagesAtTurnN,
			{ bucketTokens: 10000, estimateTokens: charEstimate },
			CAPS,
		);
		expect(placement1.placed).toBe(true);
		const pos1 = bytePositionOfMarker(messagesAtTurnN);

		// New user turn: prior outer turn's content was persisted, then
		// a new user message arrived. Cold-path output now includes the
		// prior asst response + new user msg.
		const messagesAtTurnNPlus1: LLMMessage[] = [
			makeMsg("user", 500, "u1"),
			makeMsg("assistant", 500, "a1"),
			makeMsg("user", 800, "uN"),
			makeMsg("assistant", 500, "aN"), // asst's response from the prior outer turn
			makeMsg("user", 700, "uN1"), // new user_N+1
			makeMsg("developer", 600, "vt"),
		];
		const placement2 = coldPathPlaceCacheMarker(
			messagesAtTurnNPlus1,
			{ bucketTokens: 10000, estimateTokens: charEstimate },
			CAPS,
		);
		expect(placement2.placed).toBe(true);
		const pos2 = bytePositionOfMarker(messagesAtTurnNPlus1);

		// New user turn → cachePoint advances. The new position covers
		// everything up through user_N's response (which is now stable
		// persisted history).
		expect(pos2).toBeGreaterThan(pos1 ?? 0);
	});

	it("B3: cachePoint is monotonic across thread lifetime", () => {
		// Simulate 4 successive outer turns. Each turn appends a user msg
		// + asst response; intermediate inner-loop tool calls vary in size.
		const positions: number[] = [];
		const history: LLMMessage[] = [];

		for (let turn = 0; turn < 4; turn++) {
			history.push(makeMsg("user", 500, `u${turn}`));
			// vary tool result sizes per turn — small, big, small, big
			const toolSize = turn % 2 === 0 ? 500 : 25000;
			history.push(makeMsg("assistant", 200, `a${turn}c`));
			history.push(makeMsg("tool_call", 100, `tc${turn}`));
			history.push(makeMsg("tool_result", toolSize, `tr${turn}`));
			history.push(makeMsg("assistant", 400, `a${turn}r`));
			const messages: LLMMessage[] = [
				...history,
				makeMsg("user", 600, `q${turn}`),
				makeMsg("developer", 500, "vt"),
			];
			coldPathPlaceCacheMarker(
				messages,
				{ bucketTokens: 10000, estimateTokens: charEstimate },
				CAPS,
			);
			const pos = bytePositionOfMarker(messages);
			if (pos !== null) positions.push(pos);
		}

		// Monotonicity: each position ≥ the previous.
		for (let i = 1; i < positions.length; i++) {
			expect(positions[i]).toBeGreaterThanOrEqual(positions[i - 1]);
		}
	});

	it("B4: cachePoint never lands inside a tool round — always at a turn boundary", () => {
		// A turn with a complex inner loop: user → asst → tool_call → tool_result
		//                                  → asst → tool_call → tool_result → dev
		// The cachePoint should land BEFORE `user`, not in the middle of the
		// asst/tool sequence. If it landed mid-sequence, the next outer turn's
		// rebuild could shift the bytes inside the cached prefix (e.g. tool
		// result compaction stubs the content — bytes change → cache miss).
		const messages: LLMMessage[] = [
			makeMsg("user", 500, "u1"),
			makeMsg("assistant", 500, "a1"),
			makeMsg("user", 800, "uN"),
			makeMsg("tool_call", 100, "tc1"),
			makeMsg("tool_result", 1500, "tr1"),
			makeMsg("assistant", 200, "aR"),
			makeMsg("tool_call", 100, "tc2"),
			makeMsg("tool_result", 1500, "tr2"),
			makeMsg("developer", 600, "vt"),
		];
		const placement = coldPathPlaceCacheMarker(
			messages,
			{ bucketTokens: 10000, estimateTokens: charEstimate },
			CAPS,
		);
		expect(placement.placed).toBe(true);
		// The marker should sit BEFORE user_N (index 2), not between any
		// tool_call/tool_result pair within the inner loop.
		const insertedIdx = messages.findIndex((m) => m.role === "cache");
		const target = messages[insertedIdx - 1];
		// The cachePoint target message should be a user/assistant from a
		// PRIOR turn — not a tool_call/tool_result from the current inner
		// loop. This is the structural invariant.
		expect(["user", "assistant"]).toContain(target.role);
	});
});
