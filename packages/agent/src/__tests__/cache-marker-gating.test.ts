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
import { maybePlaceCacheMarker } from "../cache-marker";

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
	it("places a cache marker at length-1 when caps allow caching", () => {
		const messages: LLMMessage[] = [
			{ role: "user", content: "msg1" },
			{ role: "assistant", content: "msg2" },
		];
		const placed = maybePlaceCacheMarker(messages, "fixed", CACHING_CAPS);
		expect(placed).toBe(true);
		expect(messages).toHaveLength(3);
		expect(messages[1]).toEqual({ role: "cache", content: "" });
	});

	it("skips marker when caps.prompt_caching is false", () => {
		const messages: LLMMessage[] = [
			{ role: "user", content: "msg1" },
			{ role: "assistant", content: "msg2" },
		];
		const placed = maybePlaceCacheMarker(messages, "fixed", NO_CACHING_CAPS);
		expect(placed).toBe(false);
		expect(messages).toHaveLength(2);
		expect(messages.some((m) => m.role === "cache")).toBe(false);
	});

	it("places marker when caps are undefined (no resolution info)", () => {
		const messages: LLMMessage[] = [
			{ role: "user", content: "msg1" },
			{ role: "assistant", content: "msg2" },
		];
		const placed = maybePlaceCacheMarker(messages, "fixed", undefined);
		// Undefined means "no caps info at all" (rare — misconfigured cluster).
		// Historically permissive; the relay-processor receiver-side strip now
		// catches unsupported markers before they reach AWS.
		expect(placed).toBe(true);
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
		const placed = maybePlaceCacheMarker(messages, "fixed", remoteCaps);
		expect(placed).toBe(false);
		expect(messages.some((m) => m.role === "cache")).toBe(false);
	});

	it("accepts a partial capabilities shape and places when prompt_caching:true", () => {
		const messages: LLMMessage[] = [
			{ role: "user", content: "msg1" },
			{ role: "assistant", content: "msg2" },
		];
		const remoteCaps = { prompt_caching: true };
		const placed = maybePlaceCacheMarker(messages, "fixed", remoteCaps);
		expect(placed).toBe(true);
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
		const placed = maybePlaceCacheMarker(messages, "fixed", remoteCaps);
		expect(placed).toBe(true);
	});

	it("does not place when messages.length < 2", () => {
		const messages: LLMMessage[] = [{ role: "user", content: "hi" }];
		const placed = maybePlaceCacheMarker(messages, "fixed", CACHING_CAPS);
		expect(placed).toBe(false);
		expect(messages).toHaveLength(1);
	});
});

describe("maybePlaceCacheMarker — rolling (warm path)", () => {
	it("places rolling marker at length-1 when caps allow caching", () => {
		const messages: LLMMessage[] = [
			{ role: "user", content: "msg1" },
			{ role: "cache", content: "" },
			{ role: "assistant", content: "msg2" },
			{ role: "user", content: "msg3" },
		];
		const placed = maybePlaceCacheMarker(messages, "rolling", CACHING_CAPS);
		expect(placed).toBe(true);
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
		const placed = maybePlaceCacheMarker(messages, "rolling", NO_CACHING_CAPS);
		expect(placed).toBe(false);
		expect(messages).toHaveLength(3);
		expect(messages.some((m) => m.role === "cache")).toBe(false);
	});

	it("skips when messages.length < 2", () => {
		const messages: LLMMessage[] = [{ role: "user", content: "msg1" }];
		const placed = maybePlaceCacheMarker(messages, "rolling", CACHING_CAPS);
		expect(placed).toBe(false);
		expect(messages).toHaveLength(1);
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
