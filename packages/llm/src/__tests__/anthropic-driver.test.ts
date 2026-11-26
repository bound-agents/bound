/**
 * Unit tests for the Anthropic direct driver's pure helpers (issue #176).
 *
 * The streaming path goes through `@ai-sdk/anthropic` + the shared
 * `ai-sdk-bridge`, both exercised elsewhere; here we lock in the driver-owned
 * decisions that don't need the network:
 *   - reasoning-option construction (thinking discriminant + top-level effort)
 *   - system-block cache anchoring (the `buildCachedSystemMessage("anthropic")` mirror of
 *     the Bedrock system-cachePoint trick) and its independent enable gate
 *   - capability advertisement
 */

import { describe, expect, it } from "bun:test";
import { buildAnthropicReasoningOptions } from "../drivers/anthropic";
import {
	buildCachedSystemMessage,
	hasMessageCacheMarker,
	shouldEnableSystemCache,
} from "../drivers/system-cache";

describe("buildAnthropicReasoningOptions", () => {
	it("returns undefined when neither thinking nor effort is set", () => {
		expect(buildAnthropicReasoningOptions({ messages: [] })).toBeUndefined();
	});

	it("maps enabled thinking to { thinking: { type: enabled, budgetTokens } }", () => {
		const opts = buildAnthropicReasoningOptions({
			messages: [],
			thinking: { type: "enabled", budget_tokens: 8192 },
		});
		expect(opts).toEqual({ thinking: { type: "enabled", budgetTokens: 8192 } });
	});

	it("maps adaptive thinking and carries display through", () => {
		const opts = buildAnthropicReasoningOptions({
			messages: [],
			thinking: { type: "adaptive", display: "summarized" },
		});
		expect(opts).toEqual({ thinking: { type: "adaptive", display: "summarized" } });
	});

	it("omits display on adaptive thinking when unset", () => {
		const opts = buildAnthropicReasoningOptions({
			messages: [],
			thinking: { type: "adaptive" },
		});
		expect(opts).toEqual({ thinking: { type: "adaptive" } });
	});

	it("forwards effort as the top-level output_config knob", () => {
		const opts = buildAnthropicReasoningOptions({ messages: [], effort: "xhigh" });
		expect(opts).toEqual({ effort: "xhigh" });
	});

	it("combines adaptive thinking with effort", () => {
		const opts = buildAnthropicReasoningOptions({
			messages: [],
			thinking: { type: "adaptive" },
			effort: "high",
		});
		expect(opts).toEqual({ thinking: { type: "adaptive" }, effort: "high" });
	});
});

describe("buildCachedSystemMessage (anthropic)", () => {
	it("returns null when system is empty/missing", () => {
		expect(buildCachedSystemMessage("anthropic", { system: "", cacheEnabled: true })).toBeNull();
		expect(
			buildCachedSystemMessage("anthropic", { system: undefined, cacheEnabled: true }),
		).toBeNull();
	});

	it("emits a system message without providerOptions when caching is disabled", () => {
		const msg = buildCachedSystemMessage("anthropic", {
			system: "you are a bear",
			cacheEnabled: false,
		});
		expect(msg).toEqual({ role: "system", content: "you are a bear" });
	});

	it("attaches anthropic.cacheControl when caching is enabled", () => {
		const msg = buildCachedSystemMessage("anthropic", { system: "sys", cacheEnabled: true });
		expect(msg).toEqual({
			role: "system",
			content: "sys",
			providerOptions: { anthropic: { cacheControl: { type: "ephemeral" } } },
		});
	});

	it("forwards the TTL onto cacheControl when provided", () => {
		const msg = buildCachedSystemMessage("anthropic", {
			system: "sys",
			cacheEnabled: true,
			cacheTtl: "1h",
		});
		expect(msg?.providerOptions).toEqual({
			anthropic: { cacheControl: { type: "ephemeral", ttl: "1h" } },
		});
	});
});

describe("hasMessageCacheMarker (anthropic)", () => {
	it("is false when no message carries an anthropic cacheControl", () => {
		expect(hasMessageCacheMarker("anthropic", [{ role: "user", content: "hi" }])).toBe(false);
	});

	it("is true when a message carries providerOptions.anthropic.cacheControl", () => {
		expect(
			hasMessageCacheMarker("anthropic", [
				{
					role: "user",
					content: "hi",
					providerOptions: { anthropic: { cacheControl: { type: "ephemeral" } } },
				},
			]),
		).toBe(true);
	});

	it("ignores a bedrock cachePoint marker (wrong provider bucket)", () => {
		expect(
			hasMessageCacheMarker("anthropic", [
				{
					role: "user",
					content: "hi",
					providerOptions: { bedrock: { cachePoint: { type: "default" } } },
				},
			]),
		).toBe(false);
	});
});

describe("shouldEnableSystemCache (anthropic)", () => {
	it("enables when cache_ttl is set, regardless of message markers", () => {
		expect(shouldEnableSystemCache("anthropic", { cacheTtl: "5m", bridgeMessages: [] })).toBe(true);
	});

	it("falls back to message-level marker presence when cache_ttl is unset", () => {
		expect(
			shouldEnableSystemCache("anthropic", {
				cacheTtl: undefined,
				bridgeMessages: [
					{
						role: "user",
						content: "hi",
						providerOptions: { anthropic: { cacheControl: { type: "ephemeral" } } },
					},
				],
			}),
		).toBe(true);
	});

	it("disables when neither cache_ttl nor a marker is present", () => {
		expect(
			shouldEnableSystemCache("anthropic", {
				cacheTtl: undefined,
				bridgeMessages: [{ role: "user", content: "hi" }],
			}),
		).toBe(false);
	});
});
