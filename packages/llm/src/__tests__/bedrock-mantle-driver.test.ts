import { describe, expect, it } from "bun:test";
import { BedrockMantleDriver, deriveMantleBaseUrl } from "../bedrock-mantle-driver";

describe("deriveMantleBaseUrl", () => {
	it("derives the region-scoped mantle Responses base URL when no override is given", () => {
		expect(deriveMantleBaseUrl("us-west-2")).toBe(
			"https://bedrock-mantle.us-west-2.api.aws/openai/v1",
		);
		expect(deriveMantleBaseUrl("us-east-2")).toBe(
			"https://bedrock-mantle.us-east-2.api.aws/openai/v1",
		);
	});

	it("honors an explicit base URL override verbatim", () => {
		expect(deriveMantleBaseUrl("us-west-2", "https://example.test/openai/v1")).toBe(
			"https://example.test/openai/v1",
		);
	});
});

describe("BedrockMantleDriver", () => {
	const make = () =>
		new BedrockMantleDriver({
			region: "us-west-2",
			model: "openai.gpt-5.4",
			contextWindow: 272_000,
			profile: "test-profile",
		});

	it("constructs without resolving credentials (the provider is lazy)", () => {
		// Credential resolution happens per-request inside the SigV4 fetch, never
		// at construction — so building a driver must not touch the AWS chain.
		expect(() => make()).not.toThrow();
	});

	it("reports vision + automatic prompt caching and the configured context window", () => {
		const caps = make().capabilities();
		expect(caps.max_context).toBe(272_000);
		expect(caps.streaming).toBe(true);
		expect(caps.tool_use).toBe(true);
		expect(caps.vision).toBe(true);
		// Mantle GPT-5.x caches automatically (prefix-based, no markers) — the
		// capability is honest even though the driver places no cache breakpoints.
		expect(caps.prompt_caching).toBe(true);
	});
});
