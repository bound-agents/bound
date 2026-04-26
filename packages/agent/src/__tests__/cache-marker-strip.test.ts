/**
 * Regression tests for receiver-side cache-marker stripping.
 *
 * Background: the requester-side gate in agent-loop.ts uses the remote host's
 * advertised `capabilities.prompt_caching`. But stale host-capability data,
 * legacy hosts.models formats, or pre-fix requester binaries can still send
 * `{ role: "cache" }` markers to a spoke whose backend doesn't support them.
 * Without a receiver-side strip, those markers would then get forwarded to
 * AWS as providerOptions.bedrock.cachePoint, producing the 403
 * "unsupported model or your request did not allow prompt caching."
 *
 * `stripCacheMarkersIfUnsupported(messages, caps)` filters out cache-role
 * messages when `caps.prompt_caching === false`. This is the defense-in-depth
 * line the relay-processor runs before dispatching to `backend.chat()`.
 */

import { describe, expect, it } from "bun:test";
import type { LLMMessage } from "@bound/llm";
import { stripCacheMarkersIfUnsupported } from "../cache-marker";

describe("stripCacheMarkersIfUnsupported", () => {
	it("removes cache-role messages when caps.prompt_caching is false", () => {
		const messages: LLMMessage[] = [
			{ role: "user", content: "hi" },
			{ role: "cache", content: "" },
			{ role: "assistant", content: "hey" },
			{ role: "user", content: "hello" },
		];
		const out = stripCacheMarkersIfUnsupported(messages, { prompt_caching: false });
		expect(out).toHaveLength(3);
		expect(out.some((m) => m.role === "cache")).toBe(false);
		// Non-cache messages preserve order and identity
		expect(out[0]).toEqual(messages[0]);
		expect(out[1]).toEqual(messages[2]);
		expect(out[2]).toEqual(messages[3]);
	});

	it("preserves cache markers when caps.prompt_caching is true", () => {
		const messages: LLMMessage[] = [
			{ role: "user", content: "hi" },
			{ role: "cache", content: "" },
			{ role: "assistant", content: "hey" },
		];
		const out = stripCacheMarkersIfUnsupported(messages, { prompt_caching: true });
		expect(out).toHaveLength(3);
		expect(out.some((m) => m.role === "cache")).toBe(true);
	});

	it("preserves cache markers when caps are undefined (unknown → permissive)", () => {
		const messages: LLMMessage[] = [
			{ role: "user", content: "hi" },
			{ role: "cache", content: "" },
			{ role: "assistant", content: "hey" },
		];
		const out = stripCacheMarkersIfUnsupported(messages, undefined);
		expect(out).toHaveLength(3);
		expect(out.some((m) => m.role === "cache")).toBe(true);
	});

	it("preserves cache markers when caps omit prompt_caching", () => {
		const messages: LLMMessage[] = [
			{ role: "user", content: "hi" },
			{ role: "cache", content: "" },
			{ role: "assistant", content: "hey" },
		];
		const out = stripCacheMarkersIfUnsupported(messages, { streaming: true } as unknown as {
			prompt_caching?: boolean;
		});
		expect(out).toHaveLength(3);
		expect(out.some((m) => m.role === "cache")).toBe(true);
	});

	it("returns the same array reference when no cache markers are present (zero-copy fast path)", () => {
		const messages: LLMMessage[] = [
			{ role: "user", content: "hi" },
			{ role: "assistant", content: "hey" },
		];
		const out = stripCacheMarkersIfUnsupported(messages, { prompt_caching: false });
		expect(out).toBe(messages);
	});

	it("drops multiple cache markers in a single pass", () => {
		const messages: LLMMessage[] = [
			{ role: "user", content: "hi" },
			{ role: "cache", content: "" },
			{ role: "assistant", content: "hey" },
			{ role: "cache", content: "" },
			{ role: "user", content: "hello" },
		];
		const out = stripCacheMarkersIfUnsupported(messages, { prompt_caching: false });
		expect(out).toHaveLength(3);
		expect(out.filter((m) => m.role === "cache")).toHaveLength(0);
	});

	it("does not mutate the input array", () => {
		const messages: LLMMessage[] = [
			{ role: "user", content: "hi" },
			{ role: "cache", content: "" },
			{ role: "assistant", content: "hey" },
		];
		const lenBefore = messages.length;
		stripCacheMarkersIfUnsupported(messages, { prompt_caching: false });
		expect(messages).toHaveLength(lenBefore);
		expect(messages[1].role).toBe("cache");
	});
});
