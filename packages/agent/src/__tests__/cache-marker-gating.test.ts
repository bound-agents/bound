/**
 * Regression tests for cache-marker gating by backend capability.
 *
 * Background: when a Bedrock backend is configured for a model that does NOT
 * support the Converse API `cachePoint` feature (e.g. minimax.minimax-m2.5),
 * operators disable caching via `capabilities.prompt_caching: false` in
 * `model_backends.json`. The router honors the override at routing time, but
 * prior to this fix the agent-loop still injected `{ role: "cache" }` markers
 * into the message array, which the bedrock driver then translated into
 * `providerOptions.bedrock.cachePoint`. AWS rejected those requests with:
 *
 *   403 AccessDeniedException: "You invoked an unsupported model or your
 *   request did not allow prompt caching."
 *
 * The fix gates cache-marker injection on the effective backend capabilities.
 * These tests lock that behavior in so a future refactor can't silently
 * reintroduce the 403.
 */

import { describe, expect, it } from "bun:test";
import type { BackendCapabilities, LLMMessage } from "@bound/llm";
import type { ContextSection } from "@bound/shared";
import {
	buildCacheMarkers,
	maybePlaceCacheMarker,
	refreshInnerLoopRollingMarker,
} from "../cache-marker";

const CACHING_CAPS: BackendCapabilities = {
	streaming: true,
	tool_use: true,
	system_prompt: true,
	prompt_caching: true,
	vision: true,
	extended_thinking: false,
	max_context: 200000,
};

const NO_CACHING_CAPS: BackendCapabilities = {
	...CACHING_CAPS,
	prompt_caching: false,
};

describe("maybePlaceCacheMarker — fixed (cold path)", () => {
	it("places a cache marker at length-2 when caps allow caching", () => {
		const messages: LLMMessage[] = [
			{ role: "user", content: "msg1" },
			{ role: "assistant", content: "msg2" },
		];
		const placement = maybePlaceCacheMarker(messages, "fixed", CACHING_CAPS);
		expect(placement.placed).toBe(true);
		expect(placement.variant).toBe("fixed");
		expect(placement.index).toBe(1);
		expect(placement.reason).toBeUndefined();
		expect(messages).toHaveLength(3);
		expect(messages[1]).toEqual({ role: "cache", content: "" });
	});

	it("skips marker when caps.prompt_caching is false and reports capability-disabled", () => {
		const messages: LLMMessage[] = [
			{ role: "user", content: "msg1" },
			{ role: "assistant", content: "msg2" },
		];
		const placement = maybePlaceCacheMarker(messages, "fixed", NO_CACHING_CAPS);
		expect(placement.placed).toBe(false);
		expect(placement.variant).toBe("fixed");
		expect(placement.index).toBe(-1);
		expect(placement.reason).toBe("capability-disabled");
		expect(messages).toHaveLength(2);
		expect(messages.some((m) => m.role === "cache")).toBe(false);
	});

	it("places marker when caps are undefined (no resolution info)", () => {
		const messages: LLMMessage[] = [
			{ role: "user", content: "msg1" },
			{ role: "assistant", content: "msg2" },
		];
		const placement = maybePlaceCacheMarker(messages, "fixed", undefined);
		// Undefined means "no caps info at all" (rare — misconfigured cluster).
		// Historically permissive; the relay-processor receiver-side strip now
		// catches unsupported markers before they reach AWS.
		expect(placement.placed).toBe(true);
	});

	it("accepts a partial capabilities shape (EligibleHost.capabilities) and skips when prompt_caching:false", () => {
		// Remote-host capability entries in `hosts.models` carry only a subset
		// of BackendCapabilities (streaming, tool_use, system_prompt,
		// prompt_caching, vision, max_context — no extended_thinking). The
		// gate accepts that partial shape so requester agent-loops can pass
		// `resolution.hosts[0].capabilities` directly without synthesizing a
		// full BackendCapabilities object.
		const messages: LLMMessage[] = [
			{ role: "user", content: "msg1" },
			{ role: "assistant", content: "msg2" },
		];
		const remoteCaps = { prompt_caching: false };
		const placement = maybePlaceCacheMarker(messages, "fixed", remoteCaps);
		expect(placement.placed).toBe(false);
		expect(placement.reason).toBe("capability-disabled");
		expect(messages.some((m) => m.role === "cache")).toBe(false);
	});

	it("accepts a partial capabilities shape and places when prompt_caching:true", () => {
		const messages: LLMMessage[] = [
			{ role: "user", content: "msg1" },
			{ role: "assistant", content: "msg2" },
		];
		const remoteCaps = { prompt_caching: true };
		const placement = maybePlaceCacheMarker(messages, "fixed", remoteCaps);
		expect(placement.placed).toBe(true);
	});

	it("places marker when partial caps omit prompt_caching (unknown → permissive)", () => {
		const messages: LLMMessage[] = [
			{ role: "user", content: "msg1" },
			{ role: "assistant", content: "msg2" },
		];
		// An EligibleHost could legally have capabilities without
		// prompt_caching set (legacy hosts.models format). Treat that as
		// "unknown, place optimistically" — defense-in-depth strip on the
		// receiver side catches mismatches.
		const remoteCaps = { streaming: true };
		const placement = maybePlaceCacheMarker(messages, "fixed", remoteCaps);
		expect(placement.placed).toBe(true);
	});

	it("does not place when messages.length < 2 and reports too-short", () => {
		const messages: LLMMessage[] = [{ role: "user", content: "hi" }];
		const placement = maybePlaceCacheMarker(messages, "fixed", CACHING_CAPS);
		expect(placement.placed).toBe(false);
		expect(placement.reason).toBe("too-short");
		expect(messages).toHaveLength(1);
	});
});

describe("maybePlaceCacheMarker — rolling (warm path)", () => {
	it("places rolling marker at length-2 when caps allow caching", () => {
		const messages: LLMMessage[] = [
			{ role: "user", content: "msg1" },
			{ role: "cache", content: "" },
			{ role: "assistant", content: "msg2" },
			{ role: "user", content: "msg3" },
		];
		const placement = maybePlaceCacheMarker(messages, "rolling", CACHING_CAPS);
		expect(placement.placed).toBe(true);
		expect(placement.variant).toBe("rolling");
		expect(placement.index).toBe(3);
		expect(messages).toHaveLength(5);
		// Rolling marker inserted before the last message
		expect(messages[3]).toEqual({ role: "cache", content: "" });
		expect(messages[4]).toEqual({ role: "user", content: "msg3" });
	});

	it("skips rolling marker when caps.prompt_caching is false", () => {
		const messages: LLMMessage[] = [
			{ role: "user", content: "msg1" },
			{ role: "assistant", content: "msg2" },
			{ role: "user", content: "msg3" },
		];
		const placement = maybePlaceCacheMarker(messages, "rolling", NO_CACHING_CAPS);
		expect(placement.placed).toBe(false);
		expect(placement.variant).toBe("rolling");
		expect(placement.reason).toBe("capability-disabled");
		expect(messages).toHaveLength(3);
		expect(messages.some((m) => m.role === "cache")).toBe(false);
	});

	it("skips when messages.length < 2", () => {
		const messages: LLMMessage[] = [{ role: "user", content: "msg1" }];
		const placement = maybePlaceCacheMarker(messages, "rolling", CACHING_CAPS);
		expect(placement.placed).toBe(false);
		expect(placement.reason).toBe("too-short");
		expect(messages).toHaveLength(1);
	});
});

describe("buildCacheMarkers", () => {
	const sections: ContextSection[] = [
		{ name: "system", tokens: 5000 },
		{ name: "skill-context", tokens: 1500 },
		{ name: "volatile-prefix", tokens: 3500 },
		{ name: "history", tokens: 80000 },
		{ name: "volatile-tail", tokens: 4000 },
		{ name: "tools", tokens: 2000 },
	];
	// stable prefix (#97): tool definitions ride in the cacheable prefix
	// (Anthropic/Bedrock order: tools → system → messages), so the system-level
	// breakpoint caches them. The offset therefore includes the tools section:
	//   system + skill-context + volatile-prefix + tools = 5000 + 1500 + 3500 + 2000 = 12000
	//   message boundary: 12000 + 80000 = 92000

	it("emits system + message markers when message placement succeeded (cold path)", () => {
		const markers = buildCacheMarkers({
			sections,
			messagePlacement: { placed: true, variant: "fixed", index: 14 },
			ttl: "1h",
		});
		expect(markers).toHaveLength(2);
		expect(markers[0]).toEqual({
			kind: "system",
			positionTokens: 12000,
			variant: "fixed",
			ttl: "1h",
			capabilityEnabled: true,
		});
		expect(markers[1]).toEqual({
			kind: "message",
			positionTokens: 92000,
			variant: "fixed",
			ttl: "1h",
			capabilityEnabled: true,
		});
	});

	it("includes tool-definition tokens in the system-prefix offset (#97)", () => {
		// Tools are part of the cached prefix; dropping the tools section must
		// shrink the system marker by exactly the tool-token count.
		const withTools = buildCacheMarkers({
			sections,
			messagePlacement: { placed: true, variant: "fixed", index: 14 },
			ttl: "1h",
		});
		const withoutTools = buildCacheMarkers({
			sections: sections.filter((s) => s.name !== "tools"),
			messagePlacement: { placed: true, variant: "fixed", index: 14 },
			ttl: "1h",
		});
		expect(withTools[0].positionTokens - withoutTools[0].positionTokens).toBe(2000);
		expect(withTools[1].positionTokens - withoutTools[1].positionTokens).toBe(2000);
	});

	it("emits markers with rolling variant when message placement was warm-path", () => {
		const markers = buildCacheMarkers({
			sections,
			messagePlacement: { placed: true, variant: "rolling", index: 18 },
			ttl: "5m",
		});
		expect(markers).toHaveLength(2);
		expect(markers[0].variant).toBe("fixed"); // system marker doesn't roll
		expect(markers[0].ttl).toBe("5m");
		expect(markers[1].variant).toBe("rolling");
		expect(markers[1].ttl).toBe("5m");
	});

	it("emits zero markers when capability is explicitly disabled", () => {
		const markers = buildCacheMarkers({
			sections,
			messagePlacement: {
				placed: false,
				variant: "fixed",
				index: -1,
				reason: "capability-disabled",
			},
			ttl: "1h",
		});
		expect(markers).toEqual([]);
	});

	it("still emits markers when placement was structurally suppressed (too-short)", () => {
		// On a brand-new thread the message-level marker can't be placed yet,
		// but the backend supports caching in principle. The UI should still see
		// the position so it can render an idle tick at the right offset.
		const markers = buildCacheMarkers({
			sections,
			messagePlacement: { placed: false, variant: "fixed", index: -1, reason: "too-short" },
			ttl: "1h",
		});
		expect(markers).toHaveLength(2);
		expect(markers[0].capabilityEnabled).toBe(true);
		expect(markers[1].capabilityEnabled).toBe(true);
	});

	it("treats missing optional sections as zero tokens (no NaN, no skip)", () => {
		// skill-context is optional; on threads with no skills it's absent.
		const sparseSections: ContextSection[] = [
			{ name: "system", tokens: 5000 },
			{ name: "volatile-prefix", tokens: 3500 },
			{ name: "history", tokens: 80000 },
		];
		const markers = buildCacheMarkers({
			sections: sparseSections,
			messagePlacement: { placed: true, variant: "fixed", index: 5 },
			ttl: "1h",
		});
		expect(markers[0].positionTokens).toBe(8500); // 5000 + 0 + 3500
		expect(markers[1].positionTokens).toBe(88500); // 8500 + 80000
	});
});

describe("maybePlaceCacheMarker — MiniMax regression scenario", () => {
	it("no cache markers accumulate across multi-turn simulation for a no-caching backend", () => {
		// Mirror the multi-turn warm-path accumulation test, but with
		// prompt_caching:false. After any number of turns, the final message
		// array MUST have zero cache markers so the bedrock driver never
		// emits providerOptions.bedrock.cachePoint.
		const messages: LLMMessage[] = [
			{ role: "user", content: "initial" },
			{ role: "assistant", content: "reply" },
		];

		maybePlaceCacheMarker(messages, "fixed", NO_CACHING_CAPS);
		// Add delta, try to place rolling marker
		messages.push({ role: "user", content: "turn2" });
		maybePlaceCacheMarker(messages, "rolling", NO_CACHING_CAPS);
		messages.push({ role: "assistant", content: "reply2" });
		messages.push({ role: "user", content: "turn3" });
		maybePlaceCacheMarker(messages, "rolling", NO_CACHING_CAPS);

		const cacheCount = messages.filter((m) => m.role === "cache").length;
		expect(cacheCount).toBe(0);
	});
});

describe("refreshInnerLoopRollingMarker — trailing-pair", () => {
	// CONTRACT (2026-06-01, trailing-pair fix):
	// The single rolling marker the inner loop placed last iteration moves
	// every iteration, so Bedrock's exact-byte-position cache has no breakpoint
	// at the PRIOR write position and must rely on its ~20-block auto-lookback
	// to bridge P_{K-1} → P_K. Live data (May 29-31) shows that lookback does
	// NOT bridge for heavy coding threads: a single large tool_result blows past
	// the window, the prior write is orphaned, and `cr` stays pinned at the
	// fixed floor while `cw` re-writes the whole grown prefix (ratio ~1.12).
	//
	// Fix: keep the MOST RECENT prior rolling marker in place as an EXPLICIT
	// "previous write position" breakpoint, and place a fresh rolling marker at
	// the tip. Iteration K then reads back iteration K-1's write at an exact
	// byte-position match — no reliance on lookback. Older rolling markers are
	// evicted so the pair stays bounded at exactly two (prev + new); with the
	// fixed marker and the system-level marker that is 4 cachePoints on the
	// wire, exactly at Anthropic's per-request cap.

	it("keeps the single prior rolling as prev and places a fresh tip marker (3 total)", () => {
		// Shape: [user_1, FIXED@1, a1, tr1, PREV_rolling@4, a2, tr2, dev_tail].
		// PREV@4 was placed by iteration K-1 (riding tr1's roundtrip); iteration
		// K-1's inference then appended a2 + tr2. On this refresh PREV@4 is the
		// MOST RECENT prior rolling, so it is KEPT as the explicit prev-write
		// breakpoint, and a fresh rolling is spliced at the tip (riding a2,
		// downstream of PREV). Total = fixed + prev + new = 3, distinct positions.
		const messages: LLMMessage[] = [
			{ role: "user", content: "u1" },
			{ role: "cache", content: "" },
			{ role: "assistant", content: "a1" },
			{ role: "user", content: "tr1" },
			{ role: "cache", content: "" },
			{ role: "assistant", content: "a2" },
			{ role: "user", content: "tr2" },
			{ role: "developer", content: "vt" },
		];
		const placement = refreshInnerLoopRollingMarker(messages, 1, CACHING_CAPS);
		expect(placement.placed).toBe(true);
		expect(placement.variant).toBe("rolling");
		const cacheMsgs = messages.filter((m) => m.role === "cache");
		expect(cacheMsgs.length).toBe(3);
		// The fixed marker stays at its original index 1.
		expect(messages[1].role).toBe("cache");
		// Exactly two NON-fixed markers (prev + new), at distinct positions, and
		// the new tip marker sits strictly after the kept prev marker.
		const nonFixed = messages
			.map((m, i) => (m.role === "cache" ? i : -1))
			.filter((i) => i >= 0 && i !== 1);
		expect(nonFixed.length).toBe(2);
		expect(nonFixed[0]).toBeLessThan(nonFixed[1]);
	});

	it("places a single rolling marker on the first refresh when no prior rolling exists", () => {
		const messages: LLMMessage[] = [
			{ role: "user", content: "u1" },
			{ role: "cache", content: "" },
			{ role: "assistant", content: "a1" },
			{ role: "user", content: "tr1" },
			{ role: "developer", content: "vt" },
		];
		const placement = refreshInnerLoopRollingMarker(messages, 1, CACHING_CAPS);
		expect(placement.placed).toBe(true);
		// fixed + new = 2 (no prior rolling to keep yet).
		expect(messages.filter((m) => m.role === "cache").length).toBe(2);
	});

	it("converges to a bounded trailing pair across multiple inner-loop refreshes", () => {
		const messages: LLMMessage[] = [
			{ role: "user", content: "u1" },
			{ role: "cache", content: "" },
			{ role: "assistant", content: "a1" },
			{ role: "user", content: "tr1" },
			{ role: "developer", content: "vt" },
		];
		// First refresh — fixed + new = 2 (no prior rolling).
		refreshInnerLoopRollingMarker(messages, 1, CACHING_CAPS);
		expect(messages.filter((m) => m.role === "cache").length).toBe(2);
		expect(messages[1].role).toBe("cache");

		// Inner loop's next iter appends another tool round; the dev tail moves
		// further down and the prior rolling marker stays in place.
		messages.push({ role: "assistant", content: "a2" });
		messages.push({ role: "user", content: "tr2" });

		// Second refresh — prior rolling kept as prev, new placed at tip:
		// fixed + prev + new = 3.
		refreshInnerLoopRollingMarker(messages, 1, CACHING_CAPS);
		expect(messages.filter((m) => m.role === "cache").length).toBe(3);
		expect(messages[1].role).toBe("cache");

		// Third refresh after another round — the pair stays bounded at 3
		// (older prev evicted, most-recent prev kept, new placed).
		messages.push({ role: "assistant", content: "a3" });
		messages.push({ role: "user", content: "tr3" });
		refreshInnerLoopRollingMarker(messages, 1, CACHING_CAPS);
		expect(messages.filter((m) => m.role === "cache").length).toBe(3);
		expect(messages[1].role).toBe("cache");
	});

	it("refuses placement and reports capability-disabled when caps disable caching", () => {
		const messages: LLMMessage[] = [
			{ role: "user", content: "u1" },
			{ role: "cache", content: "" },
			{ role: "assistant", content: "a1" },
			{ role: "user", content: "tr1" },
			{ role: "developer", content: "vt" },
		];
		const placement = refreshInnerLoopRollingMarker(messages, 1, NO_CACHING_CAPS);
		expect(placement.placed).toBe(false);
		expect(placement.reason).toBe("capability-disabled");
		// With caching disabled, every non-fixed marker is evicted and nothing
		// is placed — only the fixed marker survives.
		expect(messages.filter((m) => m.role === "cache").length).toBe(1);
		expect(messages[1].role).toBe("cache");
	});

	it("evicts a stale rolling pile down to a single prev plus the new tip (bounded)", () => {
		// Pathological input: three rolling markers somehow accumulated. Only the
		// MOST RECENT survives as prev; the older two are evicted; a new tip is
		// placed. Result = fixed + prev + new = 3 (never grows unbounded).
		const messages: LLMMessage[] = [
			{ role: "user", content: "u1" },
			{ role: "cache", content: "" },
			{ role: "assistant", content: "a1" },
			{ role: "cache", content: "" },
			{ role: "user", content: "tr1" },
			{ role: "cache", content: "" },
			{ role: "assistant", content: "a2" },
			{ role: "cache", content: "" },
			{ role: "user", content: "tr2" },
			{ role: "developer", content: "vt" },
		];
		refreshInnerLoopRollingMarker(messages, 1, CACHING_CAPS);
		expect(messages.filter((m) => m.role === "cache").length).toBe(3);
		expect(messages[1].role).toBe("cache");
	});
});
