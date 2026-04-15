import { describe, expect, it } from "bun:test";
import type { BackendCapabilities, ChatParams, StreamChunk } from "../types";

describe("Extended thinking types", () => {
	it("StreamChunk includes thinking type in union", () => {
		// A thinking chunk should be a valid StreamChunk
		const chunk: StreamChunk = { type: "thinking", content: "Let me reason about this..." };
		expect(chunk.type).toBe("thinking");
		expect(chunk.content).toBe("Let me reason about this...");
	});

	it("ChatParams accepts thinking configuration", () => {
		const params: ChatParams = {
			messages: [{ role: "user", content: "Hello" }],
			thinking: {
				type: "enabled",
				budget_tokens: 10000,
			},
		};
		expect(params.thinking).toBeDefined();
		expect(params.thinking?.type).toBe("enabled");
		expect(params.thinking?.budget_tokens).toBe(10000);
	});

	it("ChatParams.thinking is optional", () => {
		const params: ChatParams = {
			messages: [{ role: "user", content: "Hello" }],
		};
		expect(params.thinking).toBeUndefined();
	});

	it("BackendCapabilities includes extended_thinking field", () => {
		const caps: BackendCapabilities = {
			streaming: true,
			tool_use: true,
			system_prompt: true,
			prompt_caching: true,
			vision: true,
			max_context: 200000,
			extended_thinking: true,
		};
		expect(caps.extended_thinking).toBe(true);
	});

	it("BackendCapabilities extended_thinking can be false", () => {
		const caps: BackendCapabilities = {
			streaming: true,
			tool_use: true,
			system_prompt: true,
			prompt_caching: false,
			vision: false,
			max_context: 4096,
			extended_thinking: false,
		};
		expect(caps.extended_thinking).toBe(false);
	});
});
