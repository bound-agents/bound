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
 *
 *   B5 (regression sentry) — fresh thread with the only user at index 0
 *      still yields a placement (best-effort always-on for non-disabled
 *      caps), keeping the system anchor floor enabled.
 *
 *   B6 (regression sentry, single fixture) — leading developer prepended
 *      by Stage 1.7 with the only user at index 1 must not yield a
 *      placement the bridge would silently drop. Live regression on
 *      thread `91a31a43-...` 2026-05-26: 40 turns of cw=0 because
 *      `result[result.length-1]` was empty when the bridge processed
 *      the cache marker.
 *
 *   P_B6 (placer property) — for ANY message sequence, when
 *      coldPathPlaceCacheMarker reports placed=true, there is at least
 *      one non-developer, non-cache message strictly before the chosen
 *      index (so positionTokens > 0). Encoded as a fast-check property
 *      over the role alphabet so any future placement-strategy change
 *      that forgets the bridge's accumulator behavior fails in CI.
 *
 *   P_B7 (placer-bridge integration property) — for ANY message sequence
 *      where the placer reports placed=true, the bridge simulator
 *      successfully attaches the cachePoint to a result entry (i.e.
 *      simulateBridgeCachePointAttachments returns exactly 1). This is
 *      the load-bearing assertion that the placer's "placed" output
 *      corresponds to an actual on-wire cachePoint, not a marker the
 *      bridge silently drops. Catches the entire class of bridge-drop
 *      regressions without requiring the test author to enumerate every
 *      pathological role-shape upfront.
 *
 *   P_B8 (capability-disabled property) — when caps.prompt_caching is
 *      false, placement is always refused with reason="capability-disabled"
 *      regardless of message shape; no marker is ever spliced into
 *      `messages`. Pins the structural-vs-policy split the relay-
 *      processor strip relies on.
 */

import { describe, expect, it } from "bun:test";
import type { BackendCapabilities, LLMMessage } from "@bound/llm";
import fc from "fast-check";
import { coldPathPlaceCacheMarker } from "../cache-marker";

/**
 * Faithful simulation of the AI SDK bridge's `role: "cache"` handling
 * (ai-sdk-bridge.ts lines 270-288). Used by the placer-bridge integration
 * property tests below to assert that the placer never produces output
 * the bridge would silently drop on the wire.
 *
 * The bridge:
 *   - accumulates developer content into `pendingDev` (no result entry yet)
 *   - emits result entries for user/assistant/tool_call/tool_result
 *   - on `role: "cache"`, attaches a cachePoint to result[result.length-1]
 *     if result is non-empty; otherwise SILENTLY DROPS the marker
 *
 * Returns the count of cache markers that successfully attached a
 * cachePoint on the simulated wire. The placer's contract: if placed=true
 * is reported, this count must equal exactly 1 (the marker landed and the
 * bridge will produce a cachePoint).
 */
function simulateBridgeCachePointAttachments(messages: LLMMessage[]): number {
	const result: { role: string; hasCachePoint: boolean }[] = [];
	const pendingDev: string[] = [];
	let attached = 0;
	for (const msg of messages) {
		if (msg.role === "developer") {
			pendingDev.push(typeof msg.content === "string" ? msg.content : "");
			continue;
		}
		if (msg.role === "cache") {
			const prev = result[result.length - 1];
			if (prev) {
				prev.hasCachePoint = true;
				attached++;
			}
			// else: silently dropped — the bug we're guarding against.
			continue;
		}
		// user / assistant / tool_call / tool_result emit a result entry.
		// (We don't model the dev→user merge here; we only need to know
		// what the result array looks like at the moment the bridge
		// processes a cache marker.)
		result.push({ role: msg.role, hasCachePoint: false });
		if (msg.role === "user") pendingDev.length = 0;
	}
	return attached;
}

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

	it("B5 (regression sentry): a marker MUST be placed for any thread with ≥2 messages so the system anchor stays enabled", () => {
		// Live regression observed on thread `a191e01f-…` 2026-05-25:
		// the semantic-anchor placer returned no-eligible-anchor when the
		// latest user message was at index 0 (a fresh boundless thread
		// where user_1 starts the conversation). With no marker placed,
		// `hasBedrockMessageCachePoint` returned false → the bedrock
		// driver disabled the SYSTEM cachePoint too → cr=0 across all
		// 79 turns of the thread, hit rate 11.41%.
		//
		// The contract: placement is best-effort ALWAYS when caps allow
		// caching. A semantic-anchor failure must fall back to a less-
		// optimal but functional position, never to "no marker" (which
		// would gate the system anchor off).
		const messages: LLMMessage[] = [
			makeMsg("user", 800, "u1"), // user at index 0 — no semantic anchor candidate
			makeMsg("assistant", 200, "a1"),
			makeMsg("tool_call", 100, "tc1"),
			makeMsg("tool_result", 1500, "tr1"),
			makeMsg("developer", 600, "vt"),
		];
		const placement = coldPathPlaceCacheMarker(
			messages,
			{ bucketTokens: 0, estimateTokens: charEstimate },
			CAPS,
		);
		expect(placement.placed).toBe(true);
	});

	it("B6 (load-bearing): a leading developer + latest user at index 1 must NOT place a cachePoint with positionTokens=0 — bridge silently drops it", () => {
		// Live regression on thread `91a31a43-...` 2026-05-26: an autonomous
		// task thread with exactly 1 user message at the start of history.
		// Stage 1.7 history compaction prepends a developer-role summary
		// stub at messages[0]; the user_1 message ends up at index 1 of the
		// assembled context. The semantic-anchor placer correctly identifies
		// user_1 as the latest user and places insertAt=1, but every message
		// before that index is a developer — so the cache marker's wire
		// position has 0 preceding non-developer bytes.
		//
		// The AI SDK bridge (ai-sdk-bridge.ts:270-288) handles role="cache"
		// by attaching a cachePoint to `result[result.length-1]`. When all
		// preceding messages are developers (which accumulate in pendingDev
		// without producing result entries), `result` is empty when the
		// cache marker is processed and the marker is silently dropped.
		// The on-wire request has only the system-level cachePoint, no
		// message-level cachePoint, so cumulative caching never accumulates
		// past the system anchor floor.
		//
		// Live evidence: 44 turns, system anchor floor of 87,388 read on
		// every turn, but cw=0 for 40 consecutive turns — cumulative cache
		// frozen at the system prefix. Hit rate 38.37% (driven entirely by
		// the system anchor floor; no message-level extension).
		//
		// The contract: when there are 0 non-developer, non-cache messages
		// before the placer's chosen insertAt, the placer MUST return
		// placed=false with a non-capability-disabled reason. The bedrock
		// driver's shouldEnableSystemCachePoint gate (post-67596ec0)
		// keeps the system anchor riding on cacheTtl, so this fallback
		// preserves the system anchor floor while signaling that
		// message-level caching has no anchor on this turn.
		const messages: LLMMessage[] = [
			makeMsg("developer", 800, "summary_stub"), // Stage 1.7 prepended summary
			makeMsg("user", 600, "u1"), // the only user message in this thread
			makeMsg("tool_call", 200, "tc1"),
			makeMsg("tool_result", 1200, "tr1"),
			makeMsg("assistant", 400, "a1"),
			makeMsg("tool_call", 200, "tc2"),
			makeMsg("tool_result", 1200, "tr2"),
			makeMsg("developer", 500, "vt"), // volatile-tail
		];
		const placement = coldPathPlaceCacheMarker(
			messages,
			{ bucketTokens: 0, estimateTokens: charEstimate },
			CAPS,
		);
		// Either: refuse placement (preferred — caller falls through to
		// system anchor floor only), OR place at a position with > 0
		// preceding non-developer bytes. The current implementation
		// returns placed=true with positionTokens=0, which means the
		// bridge will silently drop the marker on the wire.
		if (placement.placed) {
			// If we DO place, the marker must have at least one
			// non-developer, non-cache message before it.
			const insertedIdx = messages.findIndex((m) => m.role === "cache");
			let nonDevBefore = 0;
			for (let i = 0; i < insertedIdx; i++) {
				const m = messages[i];
				if (m.role !== "developer" && m.role !== "cache") nonDevBefore++;
			}
			expect(nonDevBefore).toBeGreaterThan(0);
		} else {
			// If we refuse, the reason must NOT be capability-disabled
			// (caps allow caching). The cold path will skip the message-
			// level marker; the system anchor still rides via cacheTtl
			// in the bedrock driver gate.
			expect(placement.reason).not.toBe("capability-disabled");
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

/**
 * Role alphabet for property-test message generation. Excludes "cache"
 * and "system": "cache" is what the placer inserts (so generators
 * shouldn't pre-populate it), and "system" is forbidden in the messages
 * array under invariant #19 (see CONTRIBUTING.md). The remaining roles
 * are exactly what the agent loop hands to the placer in production.
 */
const placerRoleArb = fc.constantFrom<LLMMessage["role"]>(
	"user",
	"assistant",
	"tool_call",
	"tool_result",
	"developer",
);

const placerMessagesArb = fc
	.array(placerRoleArb, { minLength: 2, maxLength: 12 })
	.map((roles) => roles.map((role, i) => makeMsg(role, 200, `m${i}`)) as LLMMessage[]);

describe("Semantic-anchor cache marker placement — property invariants", () => {
	it("P_B6: when placer reports placed=true, ≥1 non-developer, non-cache message strictly precedes the marker (positionTokens > 0)", () => {
		fc.assert(
			fc.property(placerMessagesArb, (messages) => {
				const placement = coldPathPlaceCacheMarker(
					messages,
					{ bucketTokens: 0, estimateTokens: charEstimate },
					CAPS,
				);
				if (!placement.placed) return true; // refused placements vacuously satisfy
				const insertedIdx = messages.findIndex((m) => m.role === "cache");
				if (insertedIdx <= 0) return false; // index 0 means no preceding bytes
				let nonDevBefore = 0;
				for (let i = 0; i < insertedIdx; i++) {
					const role = messages[i].role;
					if (role !== "developer" && role !== "cache") nonDevBefore++;
				}
				return nonDevBefore > 0;
			}),
			{ numRuns: 200 },
		);
	});

	it("P_B7 (placer-bridge integration): when placer reports placed=true, the bridge attaches exactly 1 cachePoint on the simulated wire", () => {
		// This is the load-bearing assertion that the placer's contract
		// matches the bridge's actual behavior. Any future placement
		// strategy that splices a marker into a position the bridge will
		// silently drop fails here.
		fc.assert(
			fc.property(placerMessagesArb, (messages) => {
				const placement = coldPathPlaceCacheMarker(
					messages,
					{ bucketTokens: 0, estimateTokens: charEstimate },
					CAPS,
				);
				if (!placement.placed) {
					// Refused placements — no marker should have been spliced.
					return !messages.some((m) => m.role === "cache");
				}
				// Placed: bridge must attach the cachePoint to a result entry.
				const attached = simulateBridgeCachePointAttachments(messages);
				return attached === 1;
			}),
			{ numRuns: 200 },
		);
	});

	it("P_B8: caps.prompt_caching=false ALWAYS refuses placement with capability-disabled, no marker spliced", () => {
		const disabledCaps: BackendCapabilities = { ...CAPS, prompt_caching: false };
		fc.assert(
			fc.property(placerMessagesArb, (messages) => {
				const before = messages.length;
				const placement = coldPathPlaceCacheMarker(
					messages,
					{ bucketTokens: 0, estimateTokens: charEstimate },
					disabledCaps,
				);
				if (placement.placed) return false;
				if (placement.reason !== "capability-disabled") return false;
				if (messages.length !== before) return false;
				if (messages.some((m) => m.role === "cache")) return false;
				return true;
			}),
			{ numRuns: 200 },
		);
	});

	it("P_B6_explicit_dev_prefix: messages starting with N developers force the bridge-drop guard regardless of latest-user position", () => {
		// Targeted generator: prepend 1-4 developer messages, then a
		// random suffix containing at least one user. Without the
		// bridge-drop guard the placer would happily put the marker at
		// the latest user's index and report positionTokens=0.
		fc.assert(
			fc.property(
				fc.integer({ min: 1, max: 4 }),
				fc.array(placerRoleArb, { minLength: 1, maxLength: 8 }),
				(devCount, suffixRoles) => {
					// Ensure at least one user in the suffix.
					const suffix = [...suffixRoles];
					if (!suffix.includes("user")) suffix[0] = "user";
					const messages: LLMMessage[] = [];
					for (let i = 0; i < devCount; i++) {
						messages.push(makeMsg("developer", 200, `d${i}`));
					}
					for (let i = 0; i < suffix.length; i++) {
						messages.push(makeMsg(suffix[i], 200, `s${i}`));
					}
					const placement = coldPathPlaceCacheMarker(
						messages,
						{ bucketTokens: 0, estimateTokens: charEstimate },
						CAPS,
					);
					if (!placement.placed) {
						// Refusal is acceptable; reason must not be
						// capability-disabled (caps allow caching).
						return placement.reason !== "capability-disabled";
					}
					// Placed: bridge must successfully attach.
					const attached = simulateBridgeCachePointAttachments(messages);
					return attached === 1;
				},
			),
			{ numRuns: 200 },
		);
	});
});
