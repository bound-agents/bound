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

describe("refreshInnerLoopRollingMarker", () => {
	it("evicts a prior rolling marker and places a fresh one before the volatile-tail", () => {
		// Shape: [user_1, FIXED_cache, assistant, user_tool_result_1,
		//         OLD_rolling_cache, developer_tail].
		// After refresh: prior rolling at idx 4 is evicted, new rolling
		// is spliced before the developer tail (computeCacheMarkerIndex
		// places before the user the bridge will merge dev into; here the
		// last non-developer is `user_tool_result_1`).
		const messages: LLMMessage[] = [
			{ role: "user", content: "u1" },
			{ role: "cache", content: "" },
			{ role: "assistant", content: "a1" },
			{ role: "user", content: "tr1" },
			{ role: "cache", content: "" },
			{ role: "developer", content: "vt" },
		];
		const placement = refreshInnerLoopRollingMarker(messages, 1, CACHING_CAPS);
		expect(placement.placed).toBe(true);
		expect(placement.variant).toBe("rolling");
		const cacheMsgs = messages.filter((m) => m.role === "cache");
		expect(cacheMsgs.length).toBe(2);
		// The fixed marker stays at its original index 1.
		expect(messages[1].role).toBe("cache");
	});

	it("places a rolling marker even when no prior rolling exists", () => {
		const messages: LLMMessage[] = [
			{ role: "user", content: "u1" },
			{ role: "cache", content: "" },
			{ role: "assistant", content: "a1" },
			{ role: "user", content: "tr1" },
			{ role: "developer", content: "vt" },
		];
		const placement = refreshInnerLoopRollingMarker(messages, 1, CACHING_CAPS);
		expect(placement.placed).toBe(true);
		expect(messages.filter((m) => m.role === "cache").length).toBe(2);
	});

	it("preserves the fixed marker index across multiple inner-loop refreshes", () => {
		const messages: LLMMessage[] = [
			{ role: "user", content: "u1" },
			{ role: "cache", content: "" },
			{ role: "assistant", content: "a1" },
			{ role: "user", content: "tr1" },
			{ role: "developer", content: "vt" },
		];
		// First refresh — places rolling.
		refreshInnerLoopRollingMarker(messages, 1, CACHING_CAPS);
		expect(messages[1].role).toBe("cache");

		// Simulate the inner loop's next iter appending another tool round.
		// The dev tail moves further down; the pre-existing rolling marker
		// is still in place and must be evicted on the next refresh.
		const beforeRefresh = messages.length;
		messages.push({ role: "assistant", content: "a2" });
		messages.push({ role: "user", content: "tr2" });
		expect(messages.length).toBe(beforeRefresh + 2);

		refreshInnerLoopRollingMarker(messages, 1, CACHING_CAPS);
		// Still exactly 2 cache markers — fixed + new rolling, prior rolling evicted.
		expect(messages.filter((m) => m.role === "cache").length).toBe(2);
		// Fixed at index 1 untouched.
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
		// Eviction still ran. The fixed marker survives because the eviction
		// loop preserves indices == fixedCacheIdx.
		expect(messages.filter((m) => m.role === "cache").length).toBe(1);
		expect(messages[1].role).toBe("cache");
	});

	it("evicts ALL prior rolling markers in one call (defense against accumulation)", () => {
		// Pathological input: somehow two rolling markers landed in the
		// array. The eviction loop must drop both, not just one.
		const messages: LLMMessage[] = [
			{ role: "user", content: "u1" },
			{ role: "cache", content: "" },
			{ role: "assistant", content: "a1" },
			{ role: "cache", content: "" },
			{ role: "user", content: "tr1" },
			{ role: "cache", content: "" },
			{ role: "developer", content: "vt" },
		];
		refreshInnerLoopRollingMarker(messages, 1, CACHING_CAPS);
		// Exactly 2 left: the fixed (untouched) and the new rolling.
		expect(messages.filter((m) => m.role === "cache").length).toBe(2);
	});
});
