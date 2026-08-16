import { describe, expect, it } from "bun:test";
import type { LLMMessage } from "@bound/llm";
import fc from "fast-check";
import { stripCacheMarkersIfUnsupported } from "../cache-marker";

const messageArb = fc
	.record({
		role: fc.constantFrom<LLMMessage["role"]>(
			"user",
			"assistant",
			"tool_call",
			"tool_result",
			"developer",
			"cache",
		),
		content: fc.string({ maxLength: 80 }),
	})
	.map(({ role, content }) => ({ role, content }) as LLMMessage);

const messagesArb = fc.array(messageArb, { maxLength: 24 });

describe("stripCacheMarkersIfUnsupported", () => {
	it("removes cache markers while retaining non-cache identity, order, and input", () => {
		fc.assert(
			fc.property(messagesArb, (messages) => {
				const input = [...messages];
				const retained = input.filter((message) => message.role !== "cache");
				const result = stripCacheMarkersIfUnsupported(messages, { prompt_caching: false });

				return (
					messages.length === input.length &&
					messages.every((message, index) => message === input[index]) &&
					result.length === retained.length &&
					result.every((message, index) => message === retained[index])
				);
			}),
			{ numRuns: 200 },
		);
	});

	it("preserves cache markers when capability is unknown", () => {
		const messages: LLMMessage[] = [
			{ role: "user", content: "hi" },
			{ role: "cache", content: "" },
			{ role: "assistant", content: "hey" },
		];

		expect(stripCacheMarkersIfUnsupported(messages, undefined)).toBe(messages);
		expect(
			stripCacheMarkersIfUnsupported(messages, {
				streaming: true,
			} as { prompt_caching?: boolean }),
		).toBe(messages);
	});

	it("returns the same array when disabled capability has nothing to strip", () => {
		const messages: LLMMessage[] = [
			{ role: "user", content: "hi" },
			{ role: "assistant", content: "hey" },
		];

		expect(stripCacheMarkersIfUnsupported(messages, { prompt_caching: false })).toBe(messages);
	});
});
