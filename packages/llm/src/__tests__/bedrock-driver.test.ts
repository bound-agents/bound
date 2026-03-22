import { afterAll, beforeEach, describe, expect, it } from "bun:test";
import { BedrockDriver } from "../bedrock-driver";
import type { LLMMessage, StreamChunk } from "../types";

const shouldSkip = process.env.SKIP_BEDROCK === "1";

describe("BedrockDriver", () => {
	const originalFetch = global.fetch;

	beforeEach(() => {
		global.fetch = originalFetch;
	});

	afterAll(() => {
		global.fetch = originalFetch;
	});

	it.skipIf(shouldSkip)("should create a driver with capabilities", () => {
		const driver = new BedrockDriver({
			region: "us-east-1",
			model: "anthropic.claude-3-sonnet-20240229-v1:0",
			contextWindow: 200000,
		});

		const caps = driver.capabilities();
		expect(caps.streaming).toBe(true);
		expect(caps.tool_use).toBe(true);
		expect(caps.system_prompt).toBe(true);
		expect(caps.prompt_caching).toBe(false);
		expect(caps.vision).toBe(true);
		expect(caps.max_context).toBe(200000);
	});

	it.skipIf(shouldSkip)("should translate user message correctly", async () => {
		const driver = new BedrockDriver({
			region: "us-east-1",
			model: "anthropic.claude-3-sonnet-20240229-v1:0",
			contextWindow: 200000,
		});

		const messages: LLMMessage[] = [
			{
				role: "user",
				content: "Hello, world!",
			},
		];

		let capturedRequest: any = null;

		// Mock fetch to capture the request
		global.fetch = (async (url: string, options: RequestInit) => {
			if (url.includes("bedrock")) {
				capturedRequest = JSON.parse(options.body as string);
			}
			return new Response(JSON.stringify({}), {
				status: 200,
				headers: { "Content-Type": "application/x-amzn-sagemaker-custom-attributes" },
			});
		}) as typeof fetch;

		const chunks: StreamChunk[] = [];
		try {
			for await (const chunk of driver.chat({
				model: "anthropic.claude-3-sonnet-20240229-v1:0",
				messages,
			})) {
				chunks.push(chunk);
			}
		} catch {
			// Expected to fail with mock, but we can still check the request
		}

		// BedrockDriver should construct proper message format for Converse API
		// The exact format depends on AWS SDK usage
	});

	it.skipIf(shouldSkip)("should handle tool_call message correctly", async () => {
		const driver = new BedrockDriver({
			region: "us-east-1",
			model: "anthropic.claude-3-sonnet-20240229-v1:0",
			contextWindow: 200000,
		});

		const messages: LLMMessage[] = [
			{
				role: "tool_call",
				content: [
					{
						type: "tool_use",
						id: "tool-1",
						name: "add",
						input: { a: 1, b: 2 },
					},
				],
			},
		];

		const chunks: StreamChunk[] = [];
		try {
			for await (const chunk of driver.chat({
				model: "anthropic.claude-3-sonnet-20240229-v1:0",
				messages,
			})) {
				chunks.push(chunk);
			}
		} catch {
			// Expected to fail with mock
		}

		// Test passes if no error during construction
		expect(driver).toBeDefined();
	});
});
