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

	it("captures signature from thinking chunk", () => {
		const chunks: StreamChunk[] = [
			{ type: "thinking", content: "Let me analyze " },
			{ type: "thinking", content: "this problem." },
			{ type: "thinking", content: "", signature: "WaUjzkypQ2mUEVM36O2T..." },
			{ type: "text", content: "Answer." },
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
		expect(result.thinking).toBe("Let me analyze this problem.");
		expect(result.thinkingSignature).toBe("WaUjzkypQ2mUEVM36O2T...");
	});

	it("returns null thinkingSignature when no signature present", () => {
		const chunks: StreamChunk[] = [
			{ type: "thinking", content: "Just thinking..." },
			{ type: "text", content: "Answer." },
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
		expect(result.thinking).toBe("Just thinking...");
		expect(result.thinkingSignature).toBeNull();
	});

	it("last signature wins when multiple thinking chunks have signatures", () => {
		const chunks: StreamChunk[] = [
			{ type: "thinking", content: "Part 1", signature: "first-sig" },
			{ type: "thinking", content: "Part 2", signature: "last-sig" },
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
		expect(result.thinkingSignature).toBe("last-sig");
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

describe("parseStreamChunks truncation handling", () => {
	// Regression: 2026-04-24 empty-args false-truncation bug (burned 23M tokens).
	// A zero-argument tool call emits tool_use_start + tool_use_end with no
	// tool_use_args chunks in between. Accumulator becomes "" (not undefined),
	// so `?? "{}"` fallback didn't catch it and JSON.parse("") threw.
	it("zero-argument tool call parses as {} (not truncated)", () => {
		const chunks: StreamChunk[] = [
			{ type: "tool_use_start", id: "tool-1", name: "retrieve_task" },
			// No tool_use_args chunks — zero-arg call.
			{ type: "tool_use_end", id: "tool-1" },
			{
				type: "done",
				usage: {
					input_tokens: 100,
					output_tokens: 20,
					cache_write_tokens: null,
					cache_read_tokens: null,
					estimated: false,
				},
			},
		];

		const result = parseStreamChunks(chunks);
		expect(result.toolCalls).toHaveLength(1);
		expect(result.toolCalls[0].name).toBe("retrieve_task");
		expect(result.toolCalls[0].input).toEqual({});
		expect(result.toolCalls[0].truncated).toBe(false);
		expect(result.toolCalls[0].argsJson).toBe("{}");
	});

	it("explicit empty-object args parses as {} (not truncated)", () => {
		const chunks: StreamChunk[] = [
			{ type: "tool_use_start", id: "tool-1", name: "ping" },
			{ type: "tool_use_args", id: "tool-1", partial_json: "{}" },
			{ type: "tool_use_end", id: "tool-1" },
			{
				type: "done",
				usage: {
					input_tokens: 50,
					output_tokens: 10,
					cache_write_tokens: null,
					cache_read_tokens: null,
					estimated: false,
				},
			},
		];

		const result = parseStreamChunks(chunks);
		expect(result.toolCalls[0].input).toEqual({});
		expect(result.toolCalls[0].truncated).toBe(false);
	});

	it("genuinely malformed args are still flagged truncated", () => {
		const chunks: StreamChunk[] = [
			{ type: "tool_use_start", id: "tool-1", name: "bash" },
			// Cut off mid-JSON — classic output truncation shape.
			{ type: "tool_use_args", id: "tool-1", partial_json: '{"command":"ls -la /very/long' },
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
		expect(result.toolCalls[0].truncated).toBe(true);
		expect(result.toolCalls[0].input).toEqual({});
	});

	it("drops truncated tool-call prefixes superseded by a later complete call", () => {
		const chunks: StreamChunk[] = [
			{ type: "tool_use_start", id: "call_2", name: "boundless_write" },
			{
				type: "tool_use_args",
				id: "call_2",
				partial_json: '{"content":"#!/usr/bin/env bun\\nimport',
			},
			{ type: "tool_use_end", id: "call_2" },
			{ type: "tool_use_start", id: "call_4", name: "boundless_write" },
			{
				type: "tool_use_args",
				id: "call_4",
				partial_json:
					'{"content":"#!/usr/bin/env bun\\nimport { test } from \\"bun:test\\";","file_path":"/tmp/probe.ts"}',
			},
			{ type: "tool_use_end", id: "call_4" },
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
		expect(result.toolCalls.map((tc) => tc.id)).toEqual(["call_4"]);
		expect(result.toolCalls[0].truncated).toBe(false);
		expect(result.toolCalls[0].input).toEqual({
			content: '#!/usr/bin/env bun\nimport { test } from "bun:test";',
			file_path: "/tmp/probe.ts",
		});
	});

	it("drops repeated empty same-tool drafts superseded by a later complete call", () => {
		const chunks: StreamChunk[] = [
			{ type: "tool_use_start", id: "call_2", name: "boundless_write" },
			{ type: "tool_use_args", id: "call_2", partial_json: "{}" },
			{ type: "tool_use_end", id: "call_2" },
			{ type: "tool_use_start", id: "call_4", name: "boundless_write" },
			{ type: "tool_use_args", id: "call_4", partial_json: "{}" },
			{ type: "tool_use_end", id: "call_4" },
			{ type: "tool_use_start", id: "call_6", name: "boundless_write" },
			{
				type: "tool_use_args",
				id: "call_6",
				partial_json: '{"content":"real","file_path":"/tmp/probe.ts"}',
			},
			{ type: "tool_use_end", id: "call_6" },
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
		expect(result.toolCalls.map((tc) => tc.id)).toEqual(["call_6"]);
		expect(result.toolCalls[0].input).toEqual({
			content: "real",
			file_path: "/tmp/probe.ts",
		});
	});

	it("keeps truncated tool calls that are not prefixes of a later complete call", () => {
		const chunks: StreamChunk[] = [
			{ type: "tool_use_start", id: "bad", name: "boundless_write" },
			{ type: "tool_use_args", id: "bad", partial_json: '{"content":"broken-a' },
			{ type: "tool_use_end", id: "bad" },
			{ type: "tool_use_start", id: "good", name: "boundless_write" },
			{
				type: "tool_use_args",
				id: "good",
				partial_json: '{"content":"different","file_path":"/tmp/other.ts"}',
			},
			{ type: "tool_use_end", id: "good" },
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
		expect(result.toolCalls.map((tc: any) => tc.id)).toEqual(["bad", "good"]);
		expect(result.toolCalls[0].truncated).toBe(true);
		expect(result.toolCalls[1].truncated).toBe(false);
	});
});
