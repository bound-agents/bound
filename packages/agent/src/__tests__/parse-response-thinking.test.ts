import { describe, expect, it } from "bun:test";
import type { StreamChunk } from "@bound/llm";

/**
 * Test that parseResponseChunks correctly handles thinking chunks:
 * - Thinking content is collected into a separate field
 * - Thinking content is NOT included in textContent
 * - Usage is still extracted correctly
 *
 * Since parseResponseChunks is a private method on AgentLoop, we test the
 * exported parseStreamChunks helper function instead.
 */
let parseStreamChunks: any;
try {
	const mod = await import("../agent-loop-utils");
	parseStreamChunks = mod.parseStreamChunks;
} catch {
	// Will be defined after implementation
}

describe("parseStreamChunks thinking handling", () => {
	it("collects thinking content separately from text content", () => {
		const chunks: StreamChunk[] = [
			{ type: "thinking", content: "Let me analyze " },
			{ type: "thinking", content: "this problem." },
			{ type: "text", content: "Here is my answer." },
			{
				type: "done",
				usage: {
					input_tokens: 100,
					output_tokens: 50,
					cache_write_tokens: null,
					cache_read_tokens: null,
					estimated: false,
				},
			},
		];

		const result = parseStreamChunks(chunks);
		expect(result.textContent).toBe("Here is my answer.");
		expect(result.thinking).toBe("Let me analyze this problem.");
	});

	it("returns null thinking when no thinking chunks present", () => {
		const chunks: StreamChunk[] = [
			{ type: "text", content: "Just a normal response." },
			{
				type: "done",
				usage: {
					input_tokens: 50,
					output_tokens: 20,
					cache_write_tokens: null,
					cache_read_tokens: null,
					estimated: false,
				},
			},
		];

		const result = parseStreamChunks(chunks);
		expect(result.textContent).toBe("Just a normal response.");
		expect(result.thinking).toBeNull();
	});

	it("handles thinking-only response (no text content)", () => {
		const chunks: StreamChunk[] = [
			{ type: "thinking", content: "Deep reasoning here..." },
			{
				type: "done",
				usage: {
					input_tokens: 50,
					output_tokens: 20,
					cache_write_tokens: null,
					cache_read_tokens: null,
					estimated: false,
				},
			},
		];

		const result = parseStreamChunks(chunks);
		expect(result.textContent).toBe("");
		expect(result.thinking).toBe("Deep reasoning here...");
	});

	it("still extracts tool calls correctly alongside thinking", () => {
		const chunks: StreamChunk[] = [
			{ type: "thinking", content: "I should use the bash tool." },
			{ type: "tool_use_start", id: "tool-1", name: "bash" },
			{ type: "tool_use_args", id: "tool-1", partial_json: '{"command":"ls"}' },
			{ type: "tool_use_end", id: "tool-1" },
			{
				type: "done",
				usage: {
					input_tokens: 100,
					output_tokens: 50,
					cache_write_tokens: null,
					cache_read_tokens: null,
					estimated: false,
				},
			},
		];

		const result = parseStreamChunks(chunks);
		expect(result.thinking).toBe("I should use the bash tool.");
		expect(result.toolCalls).toHaveLength(1);
		expect(result.toolCalls[0].name).toBe("bash");
		expect(result.toolCalls[0].input).toEqual({ command: "ls" });
	});

	it("extracts usage correctly with thinking chunks", () => {
		const chunks: StreamChunk[] = [
			{ type: "thinking", content: "Reasoning..." },
			{ type: "text", content: "Answer." },
			{
				type: "done",
				usage: {
					input_tokens: 200,
					output_tokens: 100,
					cache_write_tokens: 50,
					cache_read_tokens: 150,
					estimated: false,
				},
			},
		];

		const result = parseStreamChunks(chunks);
		expect(result.usage.inputTokens).toBe(200);
		expect(result.usage.outputTokens).toBe(100);
		expect(result.usage.cacheWriteTokens).toBe(50);
		expect(result.usage.cacheReadTokens).toBe(150);
	});
});
