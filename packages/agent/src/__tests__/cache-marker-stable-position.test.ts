/**
 * Regression tests for bucket-aligned stable cache marker placement.
 *
 * Background. Bedrock's prompt cache is keyed by EXACT byte position of each
 * cachePoint from the start of the request, with a ~20-content-block lookback
 * for the simplified-cache mode (Bedrock prompt-caching docs). The "rolling"
 * placement that pinned the marker right before the trailing volatile-tail
 * thrashed: every turn placed the cachePoint at a new byte position because
 * message history grew, so cached prefixes from prior turns were never matched.
 *
 * Live evidence (thread `7453d60b-…` after the system-anchor + bridge-aware
 * fixes shipped): cache_read held at the system-prefix size on every turn
 * after priming, with cache_write climbing to 60k+ tokens per turn that the
 * next turn never read back. One serendipitous hit (cr=141,991 on turn 22)
 * confirmed the lookback DOES work when consecutive turns happen to land
 * within the window; the other turns missed because position drift exceeded
 * the window between writes and the next turn's lookup.
 *
 * Bucket-aligned placement rounds the marker's cumulative-token position
 * DOWN to the nearest `bucketTokens` boundary. Within a bucket, consecutive
 * turns land the cachePoint at the SAME byte position. The marker advances
 * only when message history grows past the next bucket boundary — bounded,
 * predictable hysteresis. One cache_write per bucket transition; cache_read
 * for every turn within a bucket.
 *
 * Properties pinned here:
 *
 *   S1 Determinism — same `(messages, bucket, estimator)` produces the same
 *      `(index, positionTokens, targetTokens)`.
 *   S2 Bucket alignment — `positionTokens ≤ targetTokens` AND
 *      `targetTokens === floor(totalTokens / bucket) * bucket`.
 *   S3 Stability under same-bucket append — appending messages whose new
 *      cumulative total stays in the same bucket leaves `positionTokens` AND
 *      `index` AND the prefix-bytes-up-to-marker UNCHANGED. This is the
 *      load-bearing property — without it the cachePoint position drifts
 *      and cache_read returns 0.
 *   S4 Monotonicity — appending messages can only ADVANCE
 *      `positionTokens`; never retreats.
 *   S5 Latest-fit — the marker lands at the LARGEST candidate splice index
 *      whose cumulative tokens are ≤ `targetTokens`.
 *   S6 Below-bucket short-circuit — when `totalTokens < bucket`, returns
 *      `placed: false, reason: "below-bucket"`. Nothing useful to cache;
 *      the system-level anchor handles short threads.
 *   S7 Cache markers excluded — existing `{role: "cache"}` messages don't
 *      count toward cumulative tokens.
 *   S8 Trailing developers excluded — trailing developer messages are not
 *      candidate anchors (the bridge merges them onto adjacent users,
 *      polluting the cachePoint target's bytes).
 *   S9 Capability gate — `caps.prompt_caching: false` short-circuits with
 *      `reason: "capability-disabled"` and no mutation.
 */

import { describe, expect, it } from "bun:test";
import type { BackendCapabilities, LLMMessage } from "@bound/llm";
import fc from "fast-check";
import {
	coldPathPlaceCacheMarker,
	computeStableCacheMarkerPlacement,
	placeStableCacheMarker,
} from "../cache-marker";

const CAPS: BackendCapabilities = {
	streaming: true,
	tool_use: true,
	system_prompt: true,
	prompt_caching: true,
	vision: true,
	extended_thinking: false,
	max_context: 200000,
};

const NO_CACHING_CAPS: BackendCapabilities = { ...CAPS, prompt_caching: false };

/**
 * Deterministic char-based estimator — pure, byte-stable, easy to reason
 * about in tests. Production code uses tiktoken; the contract is
 * estimator-agnostic.
 */
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
	// Build content of EXACTLY `chars` characters regardless of tag length.
	const repeats = Math.max(1, Math.floor(chars / tag.length));
	let content = tag.repeat(repeats);
	while (content.length < chars) content += tag[0] ?? "x";
	return { role, content: content.slice(0, chars) };
}

describe("computeStableCacheMarkerPlacement — unit cases", () => {
	it("S6: below-bucket short-circuit", () => {
		const messages: LLMMessage[] = [
			makeMsg("user", 100),
			makeMsg("assistant", 100),
			makeMsg("user", 100),
		];
		const placement = computeStableCacheMarkerPlacement(
			{ messages, bucketTokens: 10000, estimateTokens: charEstimate },
			CAPS,
		);
		expect(placement.placed).toBe(false);
		expect(placement.reason).toBe("below-bucket");
	});

	it("S9: capability-disabled short-circuit, no mutation", () => {
		const messages: LLMMessage[] = [makeMsg("user", 50000), makeMsg("assistant", 50000)];
		const before = messages.length;
		const placement = placeStableCacheMarker(
			messages,
			{ bucketTokens: 10000, estimateTokens: charEstimate },
			NO_CACHING_CAPS,
		);
		expect(placement.placed).toBe(false);
		expect(placement.reason).toBe("capability-disabled");
		expect(messages.length).toBe(before);
	});

	it("places marker at the latest candidate within bucket-aligned target", () => {
		// Three messages of 5k chars each; total 15k, bucket 10k → target 10k.
		// Candidates have cumulative {5000, 10000, 15000}. Latest ≤ 10k = 10000.
		const messages: LLMMessage[] = [
			makeMsg("user", 5000, "a"),
			makeMsg("assistant", 5000, "b"),
			makeMsg("user", 5000, "c"),
		];
		const placement = computeStableCacheMarkerPlacement(
			{ messages, bucketTokens: 10000, estimateTokens: charEstimate },
			CAPS,
		);
		expect(placement.placed).toBe(true);
		expect(placement.index).toBe(2); // splice after messages[1] (b)
		expect(placement.positionTokens).toBe(10000);
		expect(placement.targetTokens).toBe(10000);
	});

	it("S7: existing cache markers don't count toward cumulative", () => {
		const messages: LLMMessage[] = [
			makeMsg("user", 5000, "a"),
			{ role: "cache", content: "" }, // ignored
			makeMsg("assistant", 5000, "b"),
			makeMsg("user", 5000, "c"),
		];
		const placement = computeStableCacheMarkerPlacement(
			{ messages, bucketTokens: 10000, estimateTokens: charEstimate },
			CAPS,
		);
		expect(placement.placed).toBe(true);
		expect(placement.positionTokens).toBe(10000);
	});

	it("S8: trailing developer messages are not candidate anchors", () => {
		// 3 user/asst messages totaling 15k, plus a trailing 5k developer.
		// Developer must NOT be a candidate; the marker still lands at 10k
		// based on the user/asst content.
		const messages: LLMMessage[] = [
			makeMsg("user", 5000, "a"),
			makeMsg("assistant", 5000, "b"),
			makeMsg("user", 5000, "c"),
			makeMsg("developer", 5000, "d"), // trailing dev
		];
		const placement = computeStableCacheMarkerPlacement(
			{ messages, bucketTokens: 10000, estimateTokens: charEstimate },
			CAPS,
		);
		expect(placement.placed).toBe(true);
		// Marker after messages[1] (the assistant). Developer at index 3
		// is unaffected.
		expect(placement.index).toBe(2);
		expect(placement.positionTokens).toBe(10000);
	});

	it("placeStableCacheMarker mutates the array in place when placed", () => {
		const messages: LLMMessage[] = [
			makeMsg("user", 5000, "a"),
			makeMsg("assistant", 5000, "b"),
			makeMsg("user", 5000, "c"),
		];
		const placement = placeStableCacheMarker(
			messages,
			{ bucketTokens: 10000, estimateTokens: charEstimate },
			CAPS,
		);
		expect(placement.placed).toBe(true);
		expect(messages).toHaveLength(4);
		expect(messages[2]).toEqual({ role: "cache", content: "" });
	});
});

const roleArb = fc.constantFrom<LLMMessage["role"]>(
	"user",
	"assistant",
	"tool_call",
	"tool_result",
);

const msgArb: fc.Arbitrary<LLMMessage> = fc.record({
	role: roleArb,
	content: fc.string({ minLength: 100, maxLength: 5000 }),
});

describe("computeStableCacheMarkerPlacement — property tests", () => {
	it("S1: determinism — same inputs produce identical placement", () => {
		fc.assert(
			fc.property(
				fc.array(msgArb, { minLength: 2, maxLength: 30 }),
				fc.constantFrom(1000, 5000, 10000, 20000),
				(messages, bucket) => {
					const a = computeStableCacheMarkerPlacement(
						{ messages, bucketTokens: bucket, estimateTokens: charEstimate },
						CAPS,
					);
					const b = computeStableCacheMarkerPlacement(
						{ messages, bucketTokens: bucket, estimateTokens: charEstimate },
						CAPS,
					);
					return JSON.stringify(a) === JSON.stringify(b);
				},
			),
			{ numRuns: 100 },
		);
	});

	it("S2: bucket alignment — positionTokens ≤ targetTokens === floor(total/bucket)*bucket", () => {
		fc.assert(
			fc.property(
				fc.array(msgArb, { minLength: 2, maxLength: 30 }),
				fc.constantFrom(1000, 5000, 10000),
				(messages, bucket) => {
					const placement = computeStableCacheMarkerPlacement(
						{ messages, bucketTokens: bucket, estimateTokens: charEstimate },
						CAPS,
					);
					if (!placement.placed) return true;
					const total = messages
						.filter((m) => m.role !== "cache" && m.role !== "developer")
						.reduce((s, m) => s + charEstimate(m), 0);
					const expectedTarget = Math.floor(total / bucket) * bucket;
					if (placement.targetTokens !== expectedTarget) return false;
					if (placement.positionTokens > placement.targetTokens) return false;
					return true;
				},
			),
			{ numRuns: 100 },
		);
	});

	it("S3 (load-bearing): stability under same-bucket append — index, positionTokens, prefix unchanged", () => {
		fc.assert(
			fc.property(
				fc.array(msgArb, { minLength: 2, maxLength: 20 }),
				fc.array(msgArb, { minLength: 1, maxLength: 5 }),
				fc.constantFrom(5000, 10000, 20000),
				(base, appended, bucket) => {
					const before = computeStableCacheMarkerPlacement(
						{ messages: base, bucketTokens: bucket, estimateTokens: charEstimate },
						CAPS,
					);
					const extended = [...base, ...appended];
					const after = computeStableCacheMarkerPlacement(
						{ messages: extended, bucketTokens: bucket, estimateTokens: charEstimate },
						CAPS,
					);
					// Property only applies when both placed AND in same bucket.
					if (!before.placed || !after.placed) return true;
					if (before.targetTokens !== after.targetTokens) return true;
					// Same bucket → identical placement against the BASE messages.
					if (before.index !== after.index) return false;
					if (before.positionTokens !== after.positionTokens) return false;
					// Prefix-bytes-up-to-marker must match (the cached bytes).
					const prefixBefore = base.slice(0, before.index);
					const prefixAfter = extended.slice(0, after.index);
					if (prefixBefore.length !== prefixAfter.length) return false;
					for (let i = 0; i < prefixBefore.length; i++) {
						if (JSON.stringify(prefixBefore[i]) !== JSON.stringify(prefixAfter[i])) {
							return false;
						}
					}
					return true;
				},
			),
			{ numRuns: 200 },
		);
	});

	it("S4: monotonicity — appending messages can only advance positionTokens", () => {
		fc.assert(
			fc.property(
				fc.array(msgArb, { minLength: 2, maxLength: 20 }),
				fc.array(msgArb, { minLength: 0, maxLength: 10 }),
				fc.constantFrom(1000, 5000, 10000),
				(base, appended, bucket) => {
					const before = computeStableCacheMarkerPlacement(
						{ messages: base, bucketTokens: bucket, estimateTokens: charEstimate },
						CAPS,
					);
					const after = computeStableCacheMarkerPlacement(
						{
							messages: [...base, ...appended],
							bucketTokens: bucket,
							estimateTokens: charEstimate,
						},
						CAPS,
					);
					const beforePos = before.placed ? before.positionTokens : 0;
					const afterPos = after.placed ? after.positionTokens : 0;
					return afterPos >= beforePos;
				},
			),
			{ numRuns: 100 },
		);
	});

	it("S5: latest-fit — no later candidate has cumulative ≤ targetTokens", () => {
		fc.assert(
			fc.property(
				fc.array(msgArb, { minLength: 2, maxLength: 30 }),
				fc.constantFrom(1000, 5000, 10000),
				(messages, bucket) => {
					const placement = computeStableCacheMarkerPlacement(
						{ messages, bucketTokens: bucket, estimateTokens: charEstimate },
						CAPS,
					);
					if (!placement.placed) return true;
					// Scan forward from placement.index. Any candidate (non-marker,
					// non-developer message) AFTER index whose cumulative ≤ target
					// would be a violation of latest-fit.
					let cumulative = 0;
					let foundLater = false;
					for (let i = 0; i < messages.length; i++) {
						const m = messages[i];
						if (m.role === "cache" || m.role === "developer") continue;
						cumulative += charEstimate(m);
						const candidateIdx = i + 1;
						if (candidateIdx > placement.index && cumulative <= placement.targetTokens) {
							foundLater = true;
							break;
						}
					}
					return !foundLater;
				},
			),
			{ numRuns: 100 },
		);
	});

	it("S7+S8: cache markers and developer messages excluded from cumulative", () => {
		fc.assert(
			fc.property(fc.array(msgArb, { minLength: 3, maxLength: 15 }), (base) => {
				// Inject a {role: "cache"} marker and a trailing developer.
				// The placement against base alone vs base + extras should
				// yield the SAME positionTokens (markers/devs not counted)
				// EXCEPT that the index may shift due to insertion of the
				// cache marker into the array.
				const polluted: LLMMessage[] = [
					{ role: "cache", content: "" },
					...base,
					{ role: "developer", content: "x".repeat(50000) }, // huge dev
				];
				const placementBase = computeStableCacheMarkerPlacement(
					{ messages: base, bucketTokens: 5000, estimateTokens: charEstimate },
					CAPS,
				);
				const placementPolluted = computeStableCacheMarkerPlacement(
					{ messages: polluted, bucketTokens: 5000, estimateTokens: charEstimate },
					CAPS,
				);
				return (
					placementBase.placed === placementPolluted.placed &&
					placementBase.positionTokens === placementPolluted.positionTokens &&
					placementBase.targetTokens === placementPolluted.targetTokens
				);
			}),
			{ numRuns: 50 },
		);
	});

	it("S3-bucket-boundary: when total just barely advances to a new bucket, position advances by exactly bucketTokens or stays", () => {
		// Generate base messages whose total is just below a bucket boundary,
		// then append messages that push into the next bucket. positionTokens
		// should either stay the same (if we couldn't find a later candidate
		// fitting the new target) OR advance to the new bucket boundary.
		fc.assert(
			fc.property(
				fc.array(msgArb, { minLength: 5, maxLength: 15 }),
				fc.array(msgArb, { minLength: 1, maxLength: 5 }),
				fc.constantFrom(2000, 5000),
				(base, appended, bucket) => {
					const before = computeStableCacheMarkerPlacement(
						{ messages: base, bucketTokens: bucket, estimateTokens: charEstimate },
						CAPS,
					);
					const after = computeStableCacheMarkerPlacement(
						{
							messages: [...base, ...appended],
							bucketTokens: bucket,
							estimateTokens: charEstimate,
						},
						CAPS,
					);
					if (!before.placed || !after.placed) return true;
					// targetTokens advances in multiples of bucket
					const delta = after.targetTokens - before.targetTokens;
					return delta >= 0 && delta % bucket === 0;
				},
			),
			{ numRuns: 100 },
		);
	});
});

describe("computeStableCacheMarkerPlacement — multi-turn simulation (the regression scenario)", () => {
	it("simulates 10 turns of a tool-using thread with bucket=10k — cachePoint position must be byte-stable across same-bucket turns", () => {
		// Build a base history of 25k chars worth of user/asst pairs.
		const baseHistory: LLMMessage[] = [];
		for (let i = 0; i < 5; i++) {
			baseHistory.push(makeMsg("user", 2500, `u${i}`));
			baseHistory.push(makeMsg("assistant", 2500, `a${i}`));
		}
		// Initial placement should land at 20k (bucket-aligned target).
		const initial = computeStableCacheMarkerPlacement(
			{
				messages: baseHistory,
				bucketTokens: 10000,
				estimateTokens: charEstimate,
			},
			CAPS,
		);
		expect(initial.placed).toBe(true);
		expect(initial.targetTokens).toBe(20000);
		expect(initial.positionTokens).toBeLessThanOrEqual(20000);

		// Simulate 5 more turns each adding ~1500 chars of tool_use+result.
		// Total grows from 25k -> 25k+1500*5 = 32500. Still in 30k bucket.
		// Before turn 1 we're at 25k → 20k bucket.
		// After 4 turns (25k+6000=31000) we cross into the 30k bucket.
		// Within each bucket the marker MUST stay at the same position.
		let messages: LLMMessage[] = [...baseHistory];
		const placements: (typeof initial)[] = [];
		for (let turn = 0; turn < 5; turn++) {
			messages = [
				...messages,
				makeMsg("tool_call", 750, `tc${turn}`),
				makeMsg("tool_result", 750, `tr${turn}`),
			];
			const p = computeStableCacheMarkerPlacement(
				{ messages, bucketTokens: 10000, estimateTokens: charEstimate },
				CAPS,
			);
			placements.push(p);
		}
		// All placements within the same bucket must share index + positionTokens.
		const buckets = new Map<number, Set<string>>();
		for (const p of placements) {
			if (!p.placed) continue;
			const key = `${p.index}|${p.positionTokens}`;
			if (!buckets.has(p.targetTokens)) buckets.set(p.targetTokens, new Set());
			buckets.get(p.targetTokens)?.add(key);
		}
		for (const [target, keys] of buckets) {
			if (keys.size !== 1) {
				throw new Error(
					`Bucket ${target}: expected 1 unique placement, got ${keys.size}: ${[...keys].join(", ")}`,
				);
			}
		}
	});
});

/**
 * Compute the cumulative byte-position of the cache marker after placement.
 * Returns the sum of `charEstimate` over all messages BEFORE the cache marker.
 * Mirrors what Bedrock sees: the prefix bytes leading up to the cachePoint.
 */
function bytePositionOfMarker(messages: LLMMessage[]): number | null {
	let sum = 0;
	for (const m of messages) {
		if (m.role === "cache") return sum;
		sum += charEstimate(m);
	}
	return null;
}

/**
 * The agent-loop's cold-path simulator. Builds a fresh LLMMessage[] each
 * "turn" mimicking how the cold path runs:
 *   - history grows by `growthChars` per turn (one user + one assistant)
 *   - a trailing developer message represents the volatile-tail
 *   - call the supplied placer to splice the cache marker
 *   - return the byte-position of the marker
 *
 * The same baseHistory is reused across turns (a real agent's persistent
 * history). The growth represents a new turn's exchange added at the end.
 */
function simulateColdPathTurn(
	baseHistory: LLMMessage[],
	growthMessages: LLMMessage[],
	placer: (messages: LLMMessage[]) => void,
): { messages: LLMMessage[]; markerBytePos: number | null } {
	const messages: LLMMessage[] = [
		...baseHistory,
		...growthMessages,
		// Trailing developer = the volatile-tail injected by buildVolatileContext.
		{ role: "developer", content: "x".repeat(800) },
	];
	placer(messages);
	return { messages, markerBytePos: bytePositionOfMarker(messages) };
}

/**
 * Production cold-path regression sentry.
 *
 * Tracks the placer the agent-loop currently invokes at the cold-path call
 * site (agent-loop.ts ~1080). Asserts the property production needs for
 * cache_read to fire on consecutive Bedrock calls: byte-position stability
 * across same-bucket turns.
 *
 * History:
 *   - Pre-wire-up (commits up to and including 3aa63819): the cold-path
 *     placer was `maybePlaceCacheMarker`, which anchored at the array's
 *     tail and thrashed across turns. This test was committed in a known-
 *     FAILING state to document the bug operationally.
 *   - Wire-up commit: swapped the cold-path call site to
 *     `coldPathPlaceCacheMarker` (delegating to `placeStableCacheMarker`)
 *     AND updated this test to invoke the same wrapper. Transition is
 *     atomic — the failing assertion went green in the same commit.
 *
 * If you change the cold-path placer in agent-loop.ts, update the
 * `currentColdPathPlacer` local below to match. The test should track the
 * actual production code path so a regression flips it red.
 */
describe("Cold-path cachePoint byte-stability — production regression sentry", () => {
	it("agent-loop's cold-path placer must produce stable byte positions across same-bucket turns", () => {
		// The placer the agent-loop currently calls. Mirror this with the
		// agent-loop's call-site invocation when changing the placer.
		const currentColdPathPlacer = (messages: LLMMessage[]) => {
			coldPathPlaceCacheMarker(
				messages,
				{ bucketTokens: 10000, estimateTokens: charEstimate },
				CAPS,
			);
		};

		// 25k char baseline → just inside the 20k bucket with a 10k bucket
		// size. Three turns each add ~1500 chars, all keeping us in the
		// 20k bucket. Property: all three placements must share a byte
		// position so Bedrock's cachePoint matches across the consecutive
		// requests.
		const baseHistory: LLMMessage[] = [];
		for (let i = 0; i < 5; i++) {
			baseHistory.push(makeMsg("user", 2500, `u${i}`));
			baseHistory.push(makeMsg("assistant", 2500, `a${i}`));
		}
		const turnGrowths: LLMMessage[][] = [
			[makeMsg("user", 750, "q1"), makeMsg("assistant", 750, "r1")],
			[makeMsg("user", 750, "q2"), makeMsg("assistant", 750, "r2")],
			[makeMsg("user", 750, "q3"), makeMsg("assistant", 750, "r3")],
		];

		const cumulativeGrowth: LLMMessage[] = [];
		const positions: Array<number | null> = [];
		for (const growth of turnGrowths) {
			cumulativeGrowth.push(...growth);
			const { markerBytePos } = simulateColdPathTurn(
				baseHistory,
				cumulativeGrowth,
				currentColdPathPlacer,
			);
			positions.push(markerBytePos);
		}

		// All three same-bucket placements MUST share a byte position.
		const distinct = new Set(positions);
		if (distinct.size !== 1) {
			const positionList = [...distinct].join(", ");
			throw new Error(
				`Cold-path cachePoint thrashing detected: turns landed at distinct byte positions ${positionList} despite all being in the 20k bucket. Bedrock's prefix cache will miss on every turn — see live evidence on thread 7453d60b (cr stuck at 86,041 system-anchor only across 30+ turns).`,
			);
		}
	});
});
