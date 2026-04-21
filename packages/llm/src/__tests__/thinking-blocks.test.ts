import { describe, expect, it } from "bun:test";
import { toAnthropicMessages } from "../anthropic-driver";
import { toBedrockMessages } from "../bedrock/convert";
import { toOllamaMessages } from "../ollama-driver";
import { toOpenAIMessages } from "../openai-driver";
import type { LLMMessage } from "../types";

/**
 * Tests for thinking block preservation across all driver message converters.
 * Thinking blocks must be preserved in tool_call messages for multi-turn
 * tool use with extended thinking (Anthropic, Bedrock).
 */

describe("toAnthropicMessages — thinking blocks", () => {
	it("preserves thinking blocks in tool_call messages (array content)", () => {
		const messages: LLMMessage[] = [
			{
				role: "tool_call",
				content: [
					{ type: "thinking", thinking: "Let me analyze this...", signature: "sig123" },
					{ type: "tool_use", id: "tool-1", name: "bash", input: { command: "ls" } },
				],
			},
		];

		const result = toAnthropicMessages(messages);
		expect(result).toHaveLength(1);
		expect(result[0].role).toBe("assistant");

		const content = result[0].content;
		expect(content).toHaveLength(2);
		expect(content[0]).toEqual({
			type: "thinking",
			thinking: "Let me analyze this...",
			signature: "sig123",
		});
		expect(content[1]).toMatchObject({
			type: "tool_use",
			id: "tool-1",
			name: "bash",
		});
	});

	it("preserves thinking blocks in tool_call messages (JSON string content from DB)", () => {
		const messages: LLMMessage[] = [
			{
				role: "tool_call",
				content: JSON.stringify([
					{ type: "thinking", thinking: "Deep reasoning...", signature: "sig456" },
					{ type: "tool_use", id: "tool-1", name: "query", input: { sql: "SELECT 1" } },
				]),
			},
		];

		const result = toAnthropicMessages(messages);
		expect(result).toHaveLength(1);
		const content = result[0].content;
		expect(content).toHaveLength(2);
		expect(content[0]).toEqual({
			type: "thinking",
			thinking: "Deep reasoning...",
			signature: "sig456",
		});
	});

	it("preserves thinking blocks without signature", () => {
		const messages: LLMMessage[] = [
			{
				role: "tool_call",
				content: [
					{ type: "thinking", thinking: "No signature thinking" },
					{ type: "tool_use", id: "tool-1", name: "bash", input: {} },
				],
			},
		];

		const result = toAnthropicMessages(messages);
		const content = result[0].content;
		expect(content[0]).toEqual({
			type: "thinking",
			thinking: "No signature thinking",
		});
	});
});

describe("toBedrockMessages — thinking blocks", () => {
	it("converts thinking ContentBlocks to reasoningContent format (array content)", () => {
		// Include a user message first so Bedrock doesn't prepend a placeholder
		const messages: LLMMessage[] = [
			{ role: "user", content: "What's the weather?" },
			{
				role: "tool_call",
				content: [
					{ type: "thinking", thinking: "Step by step analysis...", signature: "bedrock-sig" },
					{ type: "tool_use", id: "tool-1", name: "bash", input: { command: "ls" } },
				],
			},
		];

		const result = toBedrockMessages(messages);
		expect(result).toHaveLength(3); // user + assistant(tool_call) + trailing user placeholder
		// Second message is the assistant tool_call
		const assistantMsg = result[1];
		expect(assistantMsg.role).toBe("assistant");

		const content = assistantMsg.content ?? [];
		expect(content).toHaveLength(2);
		expect(content[0]).toEqual({
			reasoningContent: {
				reasoningText: {
					text: "Step by step analysis...",
					signature: "bedrock-sig",
				},
			},
		});
		expect(content[1]).toHaveProperty("toolUse");
	});

	it("converts thinking blocks from JSON string content (DB path)", () => {
		const messages: LLMMessage[] = [
			{ role: "user", content: "Hello" },
			{
				role: "tool_call",
				content: JSON.stringify([
					{ type: "thinking", thinking: "Reasoning...", signature: "sig789" },
					{ type: "tool_use", id: "tool-1", name: "query", input: {} },
				]),
			},
		];

		const result = toBedrockMessages(messages);
		const content = result[1].content ?? [];
		expect(content).toHaveLength(2);
		expect(content[0]).toEqual({
			reasoningContent: {
				reasoningText: {
					text: "Reasoning...",
					signature: "sig789",
				},
			},
		});
	});

	it("omits signature field when not present", () => {
		const messages: LLMMessage[] = [
			{ role: "user", content: "Hello" },
			{
				role: "tool_call",
				content: [
					{ type: "thinking", thinking: "No sig" },
					{ type: "tool_use", id: "tool-1", name: "bash", input: {} },
				],
			},
		];

		const result = toBedrockMessages(messages);
		const content = result[1].content ?? [];
		expect(content[0]).toEqual({
			reasoningContent: {
				reasoningText: {
					text: "No sig",
				},
			},
		});
	});
});

describe("toOpenAIMessages — thinking blocks", () => {
	it("strips thinking blocks from tool_call messages", () => {
		const messages: LLMMessage[] = [
			{
				role: "tool_call",
				content: [
					{ type: "thinking", thinking: "This should be removed", signature: "sig" },
					{ type: "tool_use", id: "tool-1", name: "bash", input: { command: "ls" } },
				],
			},
		];

		const result = toOpenAIMessages(messages);
		// +1 for user-first placeholder (tool_call starts the sequence)
		expect(result).toHaveLength(2);
		expect(result[0].role).toBe("user");
		expect(result[1].role).toBe("assistant");
		// Should have tool_calls but no thinking content
		expect(result[1].tool_calls).toHaveLength(1);
		// Content should be null (no text content after stripping thinking)
		expect(result[1].content).toBeNull();
	});

	it("preserves text blocks alongside stripped thinking blocks", () => {
		const messages: LLMMessage[] = [
			{
				role: "tool_call",
				content: [
					{ type: "thinking", thinking: "Removed" },
					{ type: "text", text: "I'll help with that." },
					{ type: "tool_use", id: "tool-1", name: "bash", input: {} },
				],
			},
		];

		const result = toOpenAIMessages(messages);
		// result[0] is user-first placeholder, result[1] is the assistant message
		expect(result[1].content).toBe("I'll help with that.");
		expect(result[1].tool_calls).toHaveLength(1);
	});
});

describe("toOllamaMessages — thinking blocks", () => {
	it("extracts thinking text from thinking ContentBlocks and sets thinking field", () => {
		const messages: LLMMessage[] = [
			{
				role: "tool_call",
				content: [
					{ type: "thinking", thinking: "Let me reason about this..." },
					{ type: "tool_use", id: "tool-1", name: "bash", input: { command: "ls" } },
				],
			},
		];

		const result = toOllamaMessages(messages);
		expect(result).toHaveLength(1);
		expect(result[0].role).toBe("assistant");
		expect(result[0].thinking).toBe("Let me reason about this...");
		expect(result[0].tool_calls).toHaveLength(1);
	});

	it("concatenates multiple thinking blocks", () => {
		const messages: LLMMessage[] = [
			{
				role: "tool_call",
				content: [
					{ type: "thinking", thinking: "First thought. " },
					{ type: "thinking", thinking: "Second thought." },
					{ type: "tool_use", id: "tool-1", name: "bash", input: {} },
				],
			},
		];

		const result = toOllamaMessages(messages);
		expect(result[0].thinking).toBe("First thought. Second thought.");
	});

	it("omits thinking field when no thinking blocks present", () => {
		const messages: LLMMessage[] = [
			{
				role: "tool_call",
				content: [{ type: "tool_use", id: "tool-1", name: "bash", input: {} }],
			},
		];

		const result = toOllamaMessages(messages);
		expect(result[0].thinking).toBeUndefined();
	});
});
