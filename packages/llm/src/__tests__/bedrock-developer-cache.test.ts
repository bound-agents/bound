/**
 * Tests for developer and cache role mapping in Bedrock converter.
 * Verifies AC4.1, AC4.5, and AC4.9 from cache-stable-prefix design.
 */

import { describe, expect, it } from "bun:test";
import { toBedrockMessages } from "../bedrock/convert";
import type { LLMMessage } from "../types";

describe("Bedrock developer and cache role mapping", () => {
	describe("AC4.5 — developer role handling", () => {
		it("prepends developer message to next user message in system-context wrapper", () => {
			const messages: LLMMessage[] = [
				{ role: "developer" as "user", content: "This is system context" },
				{ role: "user", content: "What is 2+2?" },
			];

			const result = toBedrockMessages(messages);

			// Should have exactly one user message (developer + user merged)
			expect(result).toHaveLength(1);
			expect(result[0].role).toBe("user");

			// Content should have developer context wrapped in system-context tags, then user text
			const textBlocks = result[0].content as Array<{ text?: string }>;
			const textContents = textBlocks.filter((b) => b.text).map((b) => b.text);
			expect(textContents).toHaveLength(2);
			expect(textContents[0]).toContain("<system-context>");
			expect(textContents[0]).toContain("This is system context");
			expect(textContents[0]).toContain("</system-context>");
			expect(textContents[1]).toBe("What is 2+2?");
		});

		it("developer message with no subsequent user message creates new user message", () => {
			const messages: LLMMessage[] = [
				{ role: "user", content: "Start" },
				{ role: "developer" as "user", content: "Ending context" },
			];

			const result = toBedrockMessages(messages);

			// Developer message at end creates new user message, which then gets merged with
			// the preceding user message during consecutive-same-role merging. So we end up
			// with a single user message containing both the original and developer content.
			expect(result).toHaveLength(1);
			expect(result[0].role).toBe("user");

			// The user message should contain the developer context
			const content = result[0].content as Array<{ text?: string }>;
			const allText = content.map((b) => b.text).join("");
			expect(allText).toContain("<system-context>");
			expect(allText).toContain("Ending context");
		});

		it("multiple consecutive developer messages buffered to next user message", () => {
			const messages: LLMMessage[] = [
				{ role: "developer" as "user", content: "Context line 1" },
				{ role: "developer" as "user", content: "Context line 2" },
				{ role: "user", content: "Question" },
			];

			const result = toBedrockMessages(messages);

			// Should have one user message with all developer contexts prepended
			const userMessages = result.filter((m) => m.role === "user");
			expect(userMessages).toHaveLength(1);

			const textBlocks = userMessages[0].content as Array<{ text?: string }>;
			const textContent = textBlocks
				.filter((b) => b.text)
				.map((b) => b.text)
				.join("\n");

			// Both developer contexts should be present
			expect(textContent).toContain("Context line 1");
			expect(textContent).toContain("Context line 2");
			expect(textContent).toContain("Question");
		});

		it("developer content with ContentBlock array extracts text properly", () => {
			const messages: LLMMessage[] = [
				{
					role: "developer" as "user",
					content: [
						{ type: "text" as const, text: "Extracted from blocks" },
						{ type: "text" as const, text: "Second block" },
					],
				},
				{ role: "user", content: "Now ask" },
			];

			const result = toBedrockMessages(messages);

			expect(result).toHaveLength(1);
			const textBlocks = result[0].content as Array<{ text?: string }>;
			const allText = textBlocks.map((b) => b.text).join("");

			expect(allText).toContain("<system-context>");
			expect(allText).toContain("Extracted from blocks");
			expect(allText).toContain("Second block");
		});
	});

	describe("AC4.1 — cache role handling", () => {
		it("cache message appends cachePoint block to previous message", () => {
			const messages: LLMMessage[] = [
				{ role: "user", content: "First message" },
				{ role: "cache" as "user", content: "" },
				{ role: "assistant", content: "Response" },
				{ role: "user", content: "Second message" },
			];

			const result = toBedrockMessages(messages);

			// Should have three messages: user (with cachePoint), assistant, user
			expect(result).toHaveLength(3);
			expect(result[0].role).toBe("user");
			expect(result[1].role).toBe("assistant");
			expect(result[2].role).toBe("user");

			// First user message should have cachePoint block appended (just before it becomes assistant)
			const firstContent = result[0].content as Array<Record<string, unknown>>;
			expect(firstContent.at(-1)).toEqual({ cachePoint: { type: "default" } });
		});

		it("cache message with no previous message is dropped silently", () => {
			const messages: LLMMessage[] = [
				{ role: "cache" as "user", content: "" },
				{ role: "user", content: "First user message" },
			];

			const result = toBedrockMessages(messages);

			// Cache message at start should be dropped (no previous message to cache)
			// Result should just have the user message
			expect(result).toHaveLength(1);
			expect(result[0].role).toBe("user");
			expect(result[0].content).toEqual([{ text: "First user message" }]);
		});

		it("multiple cache messages each append to their preceding message", () => {
			const messages: LLMMessage[] = [
				{ role: "user", content: "Message 1" },
				{ role: "cache" as "user", content: "" },
				{ role: "assistant", content: "Response 1" },
				{ role: "cache" as "user", content: "" },
				{ role: "user", content: "Message 2" },
			];

			const result = toBedrockMessages(messages);

			// Should have 3 messages: user + assistant + user
			const isNotSystemNotif = (m: Record<string, unknown>) =>
				m.role !== "user" || m.content[0]?.text !== "<system-notification />";
			const nonSystemMessages = result.filter(isNotSystemNotif);
			expect(nonSystemMessages.length).toBeGreaterThanOrEqual(3);

			// Both user and assistant messages should have cachePoint
			const findMessage1 = (m: Record<string, unknown>) =>
				(m.content as Array<{ text?: string }>)?.[0]?.text === "Message 1";
			const firstMsg = result.find(findMessage1);
			expect((firstMsg?.content as Array<Record<string, unknown>>).at(-1)).toEqual({
				cachePoint: { type: "default" },
			});
		});
	});

	describe("AC4.9 — tool caching with cache messages", () => {
		it("cache messages + tools place cachePoint in toolConfig", () => {
			const { toBedrockRequest } = require("../bedrock/convert");
			const input = {
				params: {
					messages: [
						{ role: "user", content: "Call bash" },
						{ role: "cache" as "user", content: "" },
					],
					tools: [
						{
							type: "function",
							function: {
								name: "bash",
								description: "Run shell command",
								parameters: { type: "object", properties: { command: { type: "string" } } },
							},
						},
					],
				},
				defaultModel: "anthropic.claude-3-5-sonnet-20241022-v2:0",
			};

			const raw = toBedrockRequest(input);

			// toolConfig should have cachePoint when cache messages are present
			const toolConfig = raw.toolConfig as Record<string, unknown>;
			expect(toolConfig).toBeDefined();
			expect(toolConfig.cachePoint).toEqual({ type: "default" });
		});

		it("cache messages present but no tools — no crash", () => {
			const { toBedrockRequest } = require("../bedrock/convert");
			const input = {
				params: {
					messages: [
						{ role: "user", content: "Just talking" },
						{ role: "cache" as "user", content: "" },
					],
					tools: undefined,
				},
				defaultModel: "anthropic.claude-3-5-sonnet-20241022-v2:0",
			};

			const raw = toBedrockRequest(input);

			// Should not crash; toolConfig should be undefined
			expect(raw.toolConfig).toBeUndefined();
		});

		it("multiple tools with cache messages — cachePoint on all tools", () => {
			const { toBedrockRequest } = require("../bedrock/convert");
			const input = {
				params: {
					messages: [
						{ role: "user", content: "Multi-tool" },
						{ role: "cache" as "user", content: "" },
					],
					tools: [
						{
							type: "function",
							function: {
								name: "bash",
								description: "Run shell",
								parameters: { type: "object", properties: { cmd: { type: "string" } } },
							},
						},
						{
							type: "function",
							function: {
								name: "python",
								description: "Run Python",
								parameters: { type: "object", properties: { code: { type: "string" } } },
							},
						},
					],
				},
				defaultModel: "anthropic.claude-3-5-sonnet-20241022-v2:0",
			};

			const raw = toBedrockRequest(input);

			// toolConfig should exist and have cachePoint
			const toolConfig = raw.toolConfig as Record<string, unknown>;
			expect(toolConfig.cachePoint).toEqual({ type: "default" });
			expect(toolConfig.tools as Array<unknown>).toHaveLength(2);
		});
	});

	describe("combined developer + cache behavior", () => {
		it("developer and cache messages work together in same conversation", () => {
			const messages: LLMMessage[] = [
				{ role: "developer" as "user", content: "System instruction" },
				{ role: "user", content: "User question" },
				{ role: "cache" as "user", content: "" },
				{ role: "assistant", content: "Assistant response" },
				{ role: "user", content: "Follow-up" },
			];

			const result = toBedrockMessages(messages);

			// First message should merge developer + user with system-context wrapper
			const firstUser = result[0];
			expect(firstUser.role).toBe("user");
			const firstContent = firstUser.content as Array<{ text?: string }>;
			const firstText = firstContent.find((b) => b.text?.includes("System instruction"));
			expect(firstText).toBeDefined();

			// Should have cachePoint on one of the messages (appended by cache message)
			const hasCachePoint = result.some(
				(msg) =>
					Array.isArray(msg.content) &&
					(msg.content as Array<Record<string, unknown>>).some((b) => "cachePoint" in b),
			);
			expect(hasCachePoint).toBe(true);
		});

		it("deterministic output with developer and cache messages", () => {
			const { toBedrockRequest } = require("../bedrock/convert");
			const input = {
				params: {
					messages: [
						{ role: "developer" as "user", content: "Context" },
						{ role: "user", content: "Question" },
						{ role: "cache" as "user", content: "" },
					],
					tools: [
						{
							type: "function",
							function: {
								name: "tool1",
								description: "Test",
								parameters: { type: "object" },
							},
						},
					],
				},
				defaultModel: "anthropic.claude-3-5-sonnet-20241022-v2:0",
			};

			const a = toBedrockRequest(input);
			const b = toBedrockRequest(input);

			// Messages should be byte-for-byte identical
			const aMessages = JSON.stringify(a.messages);
			const bMessages = JSON.stringify(b.messages);
			expect(aMessages).toBe(bMessages);

			// toolConfig should be identical
			const aToolConfig = JSON.stringify(a.toolConfig);
			const bToolConfig = JSON.stringify(b.toolConfig);
			expect(aToolConfig).toBe(bToolConfig);
		});
	});
});
