import { describe, expect, it } from "bun:test";
import {
	classifyOpenCodeGoProtocol,
	deriveOpenCodeGoBaseUrl,
	stripOpenCodeGoModelPrefix,
} from "./opencode-go";

/**
 * Pure helpers for the OpenCode Go driver: base-URL derivation, model-prefix
 * stripping, and protocol classification (the subscription exposes two protocol
 * surfaces behind one key, selected by model family).
 */

describe("deriveOpenCodeGoBaseUrl", () => {
	it("falls back to the default zen endpoint when no override is given", () => {
		expect(deriveOpenCodeGoBaseUrl()).toBe("https://opencode.ai/zen/go/v1");
	});

	it("uses the override verbatim when present", () => {
		expect(deriveOpenCodeGoBaseUrl("https://proxy.example/v1")).toBe("https://proxy.example/v1");
	});
});

describe("stripOpenCodeGoModelPrefix", () => {
	it("removes a leading opencode-go/ prefix", () => {
		expect(stripOpenCodeGoModelPrefix("opencode-go/glm-4.6")).toBe("glm-4.6");
	});

	it("leaves an unprefixed model id unchanged", () => {
		expect(stripOpenCodeGoModelPrefix("glm-4.6")).toBe("glm-4.6");
	});
});

describe("classifyOpenCodeGoProtocol", () => {
	it("routes minimax models to the Anthropic surface", () => {
		expect(classifyOpenCodeGoProtocol("opencode-go/minimax-m2")).toBe("anthropic");
	});

	it("routes qwen models to the Anthropic surface", () => {
		expect(classifyOpenCodeGoProtocol("qwen3-max")).toBe("anthropic");
	});

	it("routes everything else to the OpenAI-compatible surface", () => {
		expect(classifyOpenCodeGoProtocol("opencode-go/glm-4.6")).toBe("openai-compatible");
		expect(classifyOpenCodeGoProtocol("kimi-k2")).toBe("openai-compatible");
	});

	it("classifies case-insensitively", () => {
		expect(classifyOpenCodeGoProtocol("opencode-go/MiniMax-M2")).toBe("anthropic");
	});
});
