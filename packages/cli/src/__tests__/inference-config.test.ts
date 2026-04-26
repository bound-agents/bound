/**
 * Regression tests for the ModelBackendsConfig → ModelRouter hand-off
 * performed by `initInference` in commands/start/inference.ts.
 *
 * Historical bug (2026-04-25): `initInference` hand-picks fields from the
 * parsed schema to build the router's BackendConfig. The `thinking` field
 * was never copied, so even after the Zod schema was fixed to preserve
 * `thinking`, the router received `undefined` and extended thinking stayed
 * off. These tests lock the contract: anything the router reads (thinking,
 * price_per_m_* knobs, capabilities, etc.) must survive the hand-off.
 */

import { describe, expect, it } from "bun:test";
import { createModelRouter } from "@bound/llm";
import type { ModelBackendsConfig as SharedModelBackendsConfig } from "@bound/shared";
import { toRouterConfig } from "../commands/start/inference";

// Minimal, schema-shaped backend config. Using this literal form (rather
// than modelBackendsSchema.parse) keeps the test focused on the CLI
// mapping layer; schema preservation is covered in
// packages/shared/src/__tests__/config-schemas.test.ts.
function bedrockOpusWithThinking(): SharedModelBackendsConfig {
	return {
		backends: [
			{
				id: "opus",
				provider: "bedrock",
				model: "global.anthropic.claude-opus-4-7",
				region: "us-west-2",
				profile: "test-profile",
				context_window: 200000,
				tier: 1,
				price_per_m_input: 5,
				price_per_m_output: 25,
				thinking: { type: "enabled" },
			},
		],
		default: "opus",
	};
}

describe("toRouterConfig", () => {
	it("propagates `thinking` so router.getThinkingConfig() reports enabled", () => {
		const routerConfig = toRouterConfig(bedrockOpusWithThinking());
		const router = createModelRouter(routerConfig);

		const thinking = router.getThinkingConfig("opus");
		expect(thinking).toBeDefined();
		expect(thinking?.type).toBe("enabled");
		// When budget_tokens is omitted upstream, the router applies the
		// default budget (10000). The key assertion is "enabled", not the
		// specific number.
		expect(thinking?.budget_tokens).toBeGreaterThan(0);
	});

	it("propagates `thinking: { budget_tokens: 15000 }` with the custom budget", () => {
		const cfg = bedrockOpusWithThinking();
		cfg.backends[0].thinking = { type: "enabled", budget_tokens: 15000 };

		const router = createModelRouter(toRouterConfig(cfg));
		const thinking = router.getThinkingConfig("opus");
		expect(thinking?.type).toBe("enabled");
		expect(thinking?.budget_tokens).toBe(15000);
	});

	it("leaves thinking undefined on the router when not configured", () => {
		const cfg = bedrockOpusWithThinking();
		cfg.backends[0].thinking = undefined;

		const router = createModelRouter(toRouterConfig(cfg));
		expect(router.getThinkingConfig("opus")).toBeUndefined();
	});

	it("propagates `max_output_tokens` so router.getMaxOutputTokens() returns it", () => {
		// Nova Pro caps at 10_000; without this hand-off the default
		// DEFAULT_MAX_OUTPUT_TOKENS (16_384) lands at Bedrock and triggers
		// "max_tokens exceeds model limit of 10000". Locking in the
		// snake_case → camelCase copy here prevents silent regressions.
		const cfg: SharedModelBackendsConfig = {
			backends: [
				{
					id: "nova-pro",
					provider: "bedrock",
					model: "us.amazon.nova-pro-v1:0",
					region: "us-west-2",
					context_window: 300000,
					tier: 2,
					price_per_m_input: 0.8,
					price_per_m_output: 3.2,
					max_output_tokens: 8192,
				},
			],
			default: "nova-pro",
		};
		const router = createModelRouter(toRouterConfig(cfg));
		expect(router.getMaxOutputTokens("nova-pro")).toBe(8192);
	});

	it("leaves max_output_tokens undefined when not configured", () => {
		const router = createModelRouter(toRouterConfig(bedrockOpusWithThinking()));
		expect(router.getMaxOutputTokens("opus")).toBeUndefined();
	});
});
