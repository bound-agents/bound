/**
 * Provider discovery-fetch helpers (slice 6, R-MC3, 2026-11-21-model-catalog.md
 * §4.1). Pure parse helpers over the two models-list endpoint shapes that have a
 * concrete driver in-tree: Anthropic `/v1/models` (which also captures
 * per-model `allowed_fallback_models` under the fallback beta) and the
 * OpenAI-compatible `/v1/models`. Transport lives in the driver; these parse the
 * JSON body into `DiscoveredModel[]` and never throw on a malformed row.
 */

import { describe, expect, it } from "bun:test";
import {
	parseAnthropicModelsList,
	parseBedrockFoundationModels,
	parseBedrockInferenceProfiles,
	parseOllamaTags,
	parseOpenAIModelsList,
} from "./discovery-fetch";

describe("parseAnthropicModelsList", () => {
	it("maps the /v1/models data array to DiscoveredModel ids", () => {
		const body = {
			data: [
				{ id: "claude-opus-4-20250101", display_name: "Claude Opus 4", type: "model" },
				{ id: "claude-sonnet-4-20250101", type: "model" },
			],
		};
		const out = parseAnthropicModelsList(body);
		expect(out.map((m) => m.providerModelId)).toEqual([
			"claude-opus-4-20250101",
			"claude-sonnet-4-20250101",
		]);
		expect(out[0]?.vendor).toBe("anthropic");
	});

	it("captures per-model allowed_fallback_models when present (fallback beta)", () => {
		const body = {
			data: [
				{
					id: "claude-opus-4",
					allowed_fallback_models: ["claude-sonnet-4", "claude-haiku-4"],
				},
			],
		};
		const out = parseAnthropicModelsList(body);
		expect(out[0]?.allowedFallbackModels).toEqual(["claude-sonnet-4", "claude-haiku-4"]);
	});

	it("skips malformed rows and tolerates a missing data array", () => {
		expect(parseAnthropicModelsList({ data: [{ no_id: true }, 42, null] })).toEqual([]);
		expect(parseAnthropicModelsList({})).toEqual([]);
		expect(parseAnthropicModelsList(null)).toEqual([]);
	});
});

describe("parseOpenAIModelsList", () => {
	it("maps the /v1/models data array to DiscoveredModel ids", () => {
		const body = {
			object: "list",
			data: [
				{ id: "gpt-6", object: "model" },
				{ id: "gpt-6-mini", object: "model" },
			],
		};
		const out = parseOpenAIModelsList(body);
		expect(out.map((m) => m.providerModelId)).toEqual(["gpt-6", "gpt-6-mini"]);
	});

	it("skips malformed rows and tolerates a missing data array", () => {
		expect(parseOpenAIModelsList({ data: [{}, "x", undefined] })).toEqual([]);
		expect(parseOpenAIModelsList("nope")).toEqual([]);
	});
});

describe("parseBedrockFoundationModels", () => {
	it("maps ListFoundationModels modelSummaries to DiscoveredModel ids with vendor", () => {
		const body = {
			modelSummaries: [
				{
					modelId: "anthropic.claude-opus-4-20250101-v1:0",
					providerName: "Anthropic",
					inputModalities: ["TEXT", "IMAGE"],
					responseStreamingSupported: true,
				},
				{ modelId: "meta.llama4-70b-v1:0", providerName: "Meta", inputModalities: ["TEXT"] },
			],
		};
		const out = parseBedrockFoundationModels(body);
		expect(out.map((m) => m.providerModelId)).toEqual([
			"anthropic.claude-opus-4-20250101-v1:0",
			"meta.llama4-70b-v1:0",
		]);
		expect(out[0]?.vendor).toBe("Anthropic");
		// IMAGE input modality surfaces as a vision capability.
		expect(out[0]?.capabilities?.vision).toBe(true);
		// TEXT-only lineup carries no vision claim (left for lower layers).
		expect(out[1]?.capabilities?.vision).toBeUndefined();
	});

	it("reads converse.maxTokensMaximum as the provider output limit; null/absent leaves it unset", () => {
		const body = {
			modelSummaries: [
				{
					modelId: "openai.gpt-6-sol",
					providerName: "OpenAI",
					inputModalities: ["TEXT", "IMAGE"],
					converse: { maxTokensMaximum: 131072, maxTokensDefault: null },
				},
				// maxTokensMaximum null → left for the lower layers (no invented value).
				{
					modelId: "anthropic.claude-opus-4-20250101-v1:0",
					providerName: "Anthropic",
					converse: { maxTokensMaximum: null },
				},
				// No converse block at all → unset.
				{ modelId: "meta.llama4-70b-v1:0", providerName: "Meta" },
			],
		};
		const out = parseBedrockFoundationModels(body);
		expect(out[0]?.maxOutputTokens).toBe(131072);
		expect(out[1]?.maxOutputTokens).toBeUndefined();
		expect(out[2]?.maxOutputTokens).toBeUndefined();
	});

	it("skips malformed rows and tolerates a missing modelSummaries array", () => {
		expect(parseBedrockFoundationModels({ modelSummaries: [{ no_id: true }, 42, null] })).toEqual(
			[],
		);
		expect(parseBedrockFoundationModels({})).toEqual([]);
		expect(parseBedrockFoundationModels(null)).toEqual([]);
	});
});

describe("parseBedrockInferenceProfiles", () => {
	it("maps ListInferenceProfiles inferenceProfileSummaries to DiscoveredModel ids", () => {
		const body = {
			inferenceProfileSummaries: [
				{
					inferenceProfileId: "us.anthropic.claude-opus-4-20250101-v1:0",
					inferenceProfileName: "US Claude Opus 4",
					status: "ACTIVE",
					type: "SYSTEM_DEFINED",
				},
				{ inferenceProfileId: "eu.meta.llama4-70b-v1:0", status: "ACTIVE" },
			],
		};
		const out = parseBedrockInferenceProfiles(body);
		expect(out.map((m) => m.providerModelId)).toEqual([
			"us.anthropic.claude-opus-4-20250101-v1:0",
			"eu.meta.llama4-70b-v1:0",
		]);
	});

	it("skips malformed rows and tolerates a missing summaries array", () => {
		expect(
			parseBedrockInferenceProfiles({ inferenceProfileSummaries: [{ no_id: true }, 42] }),
		).toEqual([]);
		expect(parseBedrockInferenceProfiles({})).toEqual([]);
		expect(parseBedrockInferenceProfiles(null)).toEqual([]);
	});
});

describe("parseOllamaTags", () => {
	it("maps /api/tags models to DiscoveredModel ids", () => {
		const body = {
			models: [
				{ name: "llama4:latest", model: "llama4:latest", size: 4661211808 },
				{ name: "qwen3:30b", model: "qwen3:30b" },
			],
		};
		const out = parseOllamaTags(body);
		expect(out.map((m) => m.providerModelId)).toEqual(["llama4:latest", "qwen3:30b"]);
	});

	it("prefers model over name and skips rows with neither", () => {
		const body = {
			models: [{ name: "display-only", model: "canonical-id" }, { name: "name-only" }, { size: 1 }],
		};
		const out = parseOllamaTags(body);
		expect(out.map((m) => m.providerModelId)).toEqual(["canonical-id", "name-only"]);
	});

	it("skips malformed rows and tolerates a missing models array", () => {
		expect(parseOllamaTags({ models: [42, null, "x"] })).toEqual([]);
		expect(parseOllamaTags({})).toEqual([]);
		expect(parseOllamaTags(null)).toEqual([]);
	});
});
