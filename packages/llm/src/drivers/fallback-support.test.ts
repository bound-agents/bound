import { describe, expect, it } from "bun:test";
import { AnthropicDriver } from "./anthropic";
import { BedrockDriver } from "./bedrock";
import { BedrockMantleDriver } from "./bedrock-mantle";
import { OpenAICompatibleDriver } from "./openai-compatible";
import { OpenCodeGoDriver } from "./opencode-go";

/**
 * Each driver declares a static `DriverFallbackSupport` descriptor (R-MC7,
 * catalog §4.2 table). Routing and refusal-fallback logic branches on these
 * flags, never on provider names. This pins the table in the spec to the code.
 */
describe("driver fallbackSupport() descriptors (catalog §4.2)", () => {
	it("anthropic: server_side_auto, publishes_allowed_targets, supports_fallback_credit all true", () => {
		const d = new AnthropicDriver({ id: "a", provider: "anthropic", model: "m", apiKey: "k" });
		expect(d.fallbackSupport()).toEqual({
			server_side_auto: true,
			publishes_allowed_targets: true,
			supports_fallback_credit: true,
		});
	});

	it("bedrock: only supports_fallback_credit", () => {
		const d = new BedrockDriver({ id: "b", provider: "bedrock", model: "m", region: "us-east-1" });
		expect(d.fallbackSupport()).toEqual({
			server_side_auto: false,
			publishes_allowed_targets: false,
			supports_fallback_credit: true,
		});
	});

	it("bedrock-mantle: only supports_fallback_credit", () => {
		const d = new BedrockMantleDriver({
			id: "m",
			provider: "bedrock-mantle",
			model: "m",
			region: "us-east-1",
			mantleBaseUrl: "https://example.invalid",
		});
		expect(d.fallbackSupport()).toEqual({
			server_side_auto: false,
			publishes_allowed_targets: false,
			supports_fallback_credit: true,
		});
	});

	it("openai-compatible: no fallback protocol support", () => {
		const d = new OpenAICompatibleDriver({
			id: "o",
			provider: "openai-compatible",
			model: "m",
			baseURL: "https://example.invalid",
			apiKey: "k",
		});
		expect(d.fallbackSupport()).toEqual({
			server_side_auto: false,
			publishes_allowed_targets: false,
			supports_fallback_credit: false,
		});
	});

	it("opencode-go: no fallback protocol support", () => {
		const d = new OpenCodeGoDriver({
			id: "g",
			provider: "opencode-go",
			model: "m",
			baseURL: "https://example.invalid",
			apiKey: "k",
		});
		expect(d.fallbackSupport()).toEqual({
			server_side_auto: false,
			publishes_allowed_targets: false,
			supports_fallback_credit: false,
		});
	});
});
