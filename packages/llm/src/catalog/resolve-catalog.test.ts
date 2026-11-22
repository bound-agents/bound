/**
 * Catalog orchestrator (slice 6, R-MC2/R-MC3/R-MC4/R-MC8/R-MC9,
 * 2026-11-21-model-catalog.md §3–§6). Ties the three per-backend metadata
 * layers (local config, live provider discovery, cached `models.dev`) and the
 * two-pass logical-model grouping into one `Map<backendId, ResolvedBackend>`
 * the production start path consumes. Pure over its declared inputs: discovery
 * results and the `models.dev` index are supplied by the caller, so the
 * orchestrator never performs IO and is fully unit-testable.
 */

import { describe, expect, it } from "bun:test";
import { resolveCatalog } from "./resolve-catalog";
import type { MetadataLayer } from "./resolve-metadata";

describe("resolveCatalog", () => {
	it("merges the three layers with config > provider > models.dev precedence (R-MC2)", () => {
		const modelsDev = new Map<string, MetadataLayer>([
			[
				"claude-opus-4",
				{
					capabilities: { max_context: 200000, vision: true },
					pricing: { input_per_m: 15, output_per_m: 75 },
				},
			],
		]);
		const result = resolveCatalog({
			backends: [
				{
					backendId: "opus",
					provider: "anthropic",
					providerModelId: "claude-opus-4-20250101",
					config: { capabilities: { max_context: 300000 } },
					discovery: [{ providerModelId: "claude-opus-4-20250101" }],
				},
			],
			modelsDev,
			aliases: new Map(),
		});
		const opus = result.get("opus");
		expect(opus?.ready).toBe(true);
		// Config max_context (300000) overrides the models.dev value (200000).
		expect(opus?.metadata.capabilities.max_context).toBe(300000);
		expect(opus?.metadata.field_sources.max_context).toBe("config");
		// Pricing is unset in config + provider → filled from models.dev.
		expect(opus?.metadata.pricing?.input_per_m).toBe(15);
		expect(opus?.metadata.field_sources["pricing.input_per_m"]).toBe("models_dev");
	});

	it("marks a backend unready when max_context is unresolved across all layers (R-MC4)", () => {
		const result = resolveCatalog({
			backends: [
				{
					backendId: "mystery",
					provider: "openai-compatible",
					providerModelId: "local-thing",
					config: {},
					discovery: [{ providerModelId: "local-thing" }],
				},
			],
			modelsDev: new Map(),
			aliases: new Map(),
		});
		const r = result.get("mystery");
		expect(r?.ready).toBe(false);
		expect(r?.configGap).toContain("max_context");
	});

	it("auto-groups a backend whose normalized key matches models.dev (R-MC9)", () => {
		const modelsDev = new Map<string, MetadataLayer>([
			["claude-opus-4", { capabilities: { max_context: 200000 } }],
		]);
		const result = resolveCatalog({
			backends: [
				{
					backendId: "opus",
					provider: "anthropic",
					providerModelId: "claude-opus-4-20250101",
					config: {},
					discovery: [],
				},
			],
			modelsDev,
			aliases: new Map(),
		});
		const r = result.get("opus");
		expect(r?.logicalModel).toBe("claude-opus-4");
		expect(r?.groupingSource).toBe("normalization");
	});

	it("groups a second backend onto a logical model confirmed by a config override (two-pass)", () => {
		// Backend A declares logical_model via config → confirms the key.
		// Backend B (bedrock) has no config/alias; its normalized key matches A's
		// confirmed key, so the confirmed-key pass lets it auto-group even though
		// the key is absent from models.dev.
		const result = resolveCatalog({
			backends: [
				{
					backendId: "a",
					provider: "anthropic",
					providerModelId: "claude-opus-4-20250101",
					config: { logical_model: "claude-opus-4" },
					discovery: [],
				},
				{
					backendId: "b",
					provider: "bedrock",
					providerModelId: "us.anthropic.claude-opus-4-20250101-v1:0",
					config: { capabilities: { max_context: 200000 } },
					discovery: [],
				},
			],
			modelsDev: new Map(),
			aliases: new Map(),
		});
		expect(result.get("a")?.logicalModel).toBe("claude-opus-4");
		expect(result.get("a")?.groupingSource).toBe("config");
		expect(result.get("b")?.logicalModel).toBe("claude-opus-4");
		expect(result.get("b")?.groupingSource).toBe("normalization");
	});

	it("leaves an unqualified local tag unassigned (R-MC9 / acceptance)", () => {
		const result = resolveCatalog({
			backends: [
				{
					backendId: "local",
					provider: "openai-compatible",
					providerModelId: "my-local-thing",
					config: { capabilities: { max_context: 8192 } },
					discovery: [{ providerModelId: "my-local-thing" }],
				},
			],
			modelsDev: new Map(),
			aliases: new Map(),
		});
		const r = result.get("local");
		expect(r?.logicalModel).toBeNull();
		expect(r?.groupingSource).toBe("unassigned");
		// Still ready — unassigned is about grouping, not readiness.
		expect(r?.ready).toBe(true);
	});

	it("honors a synced alias override and its explicit-null ungrouping", () => {
		const result = resolveCatalog({
			backends: [
				{
					backendId: "a",
					provider: "anthropic",
					providerModelId: "claude-opus-4-20250101",
					config: { capabilities: { max_context: 200000 }, logical_model: "config-opus" },
					discovery: [],
				},
				{
					backendId: "b",
					provider: "anthropic",
					providerModelId: "claude-sonnet-4-20250101",
					config: { capabilities: { max_context: 200000 }, logical_model: "config-sonnet" },
					discovery: [],
				},
			],
			modelsDev: new Map(),
			aliases: new Map([
				["anthropic:claude-opus-4-20250101", "opus"],
				["anthropic:claude-sonnet-4-20250101", null],
			]),
		});
		expect(result.get("a")?.logicalModel).toBe("opus");
		expect(result.get("a")?.groupingSource).toBe("alias");
		expect(result.get("b")?.logicalModel).toBeNull();
		expect(result.get("b")?.groupingSource).toBe("alias");
	});

	it("folds provider discovery metadata into the middle layer", () => {
		// Provider discovery supplies vendor + allowed_fallback_models; models.dev
		// supplies max_context. Config supplies nothing.
		const modelsDev = new Map<string, MetadataLayer>([
			["claude-opus-4", { capabilities: { max_context: 200000 } }],
		]);
		const result = resolveCatalog({
			backends: [
				{
					backendId: "opus",
					provider: "anthropic",
					providerModelId: "claude-opus-4-20250101",
					config: {},
					discovery: [
						{
							providerModelId: "claude-opus-4-20250101",
							vendor: "anthropic",
							allowedFallbackModels: ["claude-sonnet-4"],
						},
					],
				},
			],
			modelsDev,
			aliases: new Map(),
		});
		const r = result.get("opus");
		expect(r?.metadata.vendor).toBe("anthropic");
		expect(r?.metadata.field_sources.vendor).toBe("provider");
		expect(r?.metadata.allowed_fallback_models).toEqual(["claude-sonnet-4"]);
		expect(r?.metadata.field_sources.allowed_fallback_models).toBe("provider");
		expect(r?.metadata.capabilities.max_context).toBe(200000);
		expect(r?.metadata.field_sources.max_context).toBe("models_dev");
	});

	it("ignores discovery rows that do not match the backend's providerModelId", () => {
		// A backend's discovery list is the whole provider lineup; only the row
		// whose id matches this backend contributes to its provider layer.
		const result = resolveCatalog({
			backends: [
				{
					backendId: "opus",
					provider: "anthropic",
					providerModelId: "claude-opus-4-20250101",
					config: { capabilities: { max_context: 200000 } },
					discovery: [
						{ providerModelId: "claude-haiku-4", vendor: "wrong" },
						{ providerModelId: "claude-opus-4-20250101", vendor: "anthropic" },
					],
				},
			],
			modelsDev: new Map(),
			aliases: new Map(),
		});
		expect(result.get("opus")?.metadata.vendor).toBe("anthropic");
	});
});
