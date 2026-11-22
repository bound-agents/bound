/**
 * Layered metadata resolution + `field_sources` (slice 6, R-MC2/R-MC3/R-MC4,
 * 2026-11-21-model-catalog.md §3). Pure merge of three layers in strict
 * precedence — local config overrides (1) > live provider discovery (2) >
 * `models.dev` cache (3) — recording the winning source per field and gating a
 * backend as unready when `max_context` is absent from all three layers.
 */

import { describe, expect, it } from "bun:test";
import { resolveModelMetadata } from "./resolve-metadata";
import type { MetadataLayer } from "./resolve-metadata";

const providerModelId = "claude-opus-4";

describe("resolveModelMetadata", () => {
	describe("precedence (R-MC2 / acceptance: precedence order)", () => {
		it("local config overrides live provider metadata for a shared field", () => {
			const config: MetadataLayer = { capabilities: { max_context: 100 } };
			const provider: MetadataLayer = { capabilities: { max_context: 200 } };
			const modelsDev: MetadataLayer = { capabilities: { max_context: 300 } };
			const r = resolveModelMetadata({ providerModelId, config, provider, modelsDev });
			expect(r.metadata.capabilities.max_context).toBe(100);
			expect(r.metadata.field_sources.max_context).toBe("config");
		});

		it("live provider metadata overrides models.dev for a shared field", () => {
			const provider: MetadataLayer = { capabilities: { max_context: 200 } };
			const modelsDev: MetadataLayer = { capabilities: { max_context: 300 } };
			const r = resolveModelMetadata({ providerModelId, config: {}, provider, modelsDev });
			expect(r.metadata.capabilities.max_context).toBe(200);
			expect(r.metadata.field_sources.max_context).toBe("provider");
		});

		it("models.dev fills only fields unset by config and provider", () => {
			const config: MetadataLayer = { capabilities: { max_context: 100 } };
			const provider: MetadataLayer = { max_output_tokens: 8000 };
			const modelsDev: MetadataLayer = {
				capabilities: { max_context: 999, vision: true },
				pricing: { input_per_m: 3 },
			};
			const r = resolveModelMetadata({ providerModelId, config, provider, modelsDev });
			// config wins max_context; provider wins max_output_tokens; models.dev
			// only fills vision + pricing which neither higher layer set.
			expect(r.metadata.capabilities.max_context).toBe(100);
			expect(r.metadata.field_sources.max_context).toBe("config");
			expect(r.metadata.max_output_tokens).toBe(8000);
			expect(r.metadata.field_sources.max_output_tokens).toBe("provider");
			expect(r.metadata.capabilities.vision).toBe(true);
			expect(r.metadata.field_sources.vision).toBe("models_dev");
			expect(r.metadata.pricing?.input_per_m).toBe(3);
			expect(r.metadata.field_sources["pricing.input_per_m"]).toBe("models_dev");
		});
	});

	describe("field_sources provenance", () => {
		it("records a source for every resolved field across layers", () => {
			const config: MetadataLayer = { capabilities: { max_context: 100, tool_use: true } };
			const provider: MetadataLayer = {
				capabilities: { vision: true },
				pricing: { input_per_m: 3, output_per_m: 15 },
			};
			const modelsDev: MetadataLayer = { vendor: "anthropic" };
			const r = resolveModelMetadata({ providerModelId, config, provider, modelsDev });
			expect(r.metadata.field_sources.max_context).toBe("config");
			expect(r.metadata.field_sources.tool_use).toBe("config");
			expect(r.metadata.field_sources.vision).toBe("provider");
			expect(r.metadata.field_sources["pricing.input_per_m"]).toBe("provider");
			expect(r.metadata.field_sources.vendor).toBe("models_dev");
		});

		it("carries provider-published allowed_fallback_models through", () => {
			const provider: MetadataLayer = {
				capabilities: { max_context: 200 },
				allowed_fallback_models: ["claude-sonnet-4", "claude-haiku-4"],
			};
			const r = resolveModelMetadata({ providerModelId, config: {}, provider, modelsDev: {} });
			expect(r.metadata.allowed_fallback_models).toEqual(["claude-sonnet-4", "claude-haiku-4"]);
			expect(r.metadata.field_sources.allowed_fallback_models).toBe("provider");
		});
	});

	describe("completeness gate (R-MC4)", () => {
		it("is ready when max_context comes from any single layer", () => {
			expect(
				resolveModelMetadata({
					providerModelId,
					config: { capabilities: { max_context: 100 } },
					provider: {},
					modelsDev: {},
				}).ready,
			).toBe(true);
			expect(
				resolveModelMetadata({
					providerModelId,
					config: {},
					provider: { capabilities: { max_context: 200 } },
					modelsDev: {},
				}).ready,
			).toBe(true);
			expect(
				resolveModelMetadata({
					providerModelId,
					config: {},
					provider: {},
					modelsDev: { capabilities: { max_context: 300 } },
				}).ready,
			).toBe(true);
		});

		it("is unready with a config gap when max_context is absent from all three layers", () => {
			const r = resolveModelMetadata({
				providerModelId,
				config: { capabilities: { vision: true } },
				provider: { pricing: { input_per_m: 3 } },
				modelsDev: { vendor: "anthropic" },
			});
			expect(r.ready).toBe(false);
			expect(r.metadata.capabilities.max_context).toBeUndefined();
			expect(r.configGap).toContain("max_context");
		});
	});

	describe("logical_model carry-through", () => {
		it("records logical_model from config when present", () => {
			const r = resolveModelMetadata({
				providerModelId,
				config: { logical_model: "opus", capabilities: { max_context: 100 } },
				provider: {},
				modelsDev: {},
			});
			expect(r.metadata.logical_model).toBe("opus");
			expect(r.metadata.field_sources.logical_model).toBe("config");
		});

		it("defaults logical_model to null (grouping is resolved separately)", () => {
			const r = resolveModelMetadata({
				providerModelId,
				config: { capabilities: { max_context: 100 } },
				provider: {},
				modelsDev: {},
			});
			expect(r.metadata.logical_model).toBeNull();
		});
	});
});
