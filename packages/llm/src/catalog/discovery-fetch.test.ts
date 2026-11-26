/**
 * Provider discovery-fetch helpers (R-MC3, 2026-11-21-model-catalog.md §4.1). Pure parse helpers over the two models-list endpoint shapes that have a
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

	it("captures lineup-filter fields: inferenceAPIsSupported, explicitPromptCaching, modelLifecycle, inferenceTypesSupported, modalities", () => {
		const body = {
			modelSummaries: [
				{
					modelId: "openai.gpt-6.1-sol",
					modelArn: "arn:aws:bedrock:us-east-2::foundation-model/openai.gpt-6.1-sol",
					providerName: "OpenAI",
					inputModalities: ["TEXT", "IMAGE"],
					outputModalities: ["TEXT"],
					modelLifecycle: { status: "ACTIVE" },
					inferenceTypesSupported: ["INFERENCE_PROFILE"],
					inferenceAPIsSupported: {
						converse: { streaming: true, sync: true },
						openAiResponses: true,
						openAiChatCompletions: true,
					},
					explicitPromptCaching: { isSupported: true },
				},
				{
					modelId: "moonshotai.kimi-k2.5",
					modelArn: "arn:aws:bedrock:us-west-2::foundation-model/moonshotai.kimi-k2.5",
					providerName: "Moonshot AI",
					inputModalities: ["TEXT"],
					outputModalities: ["TEXT"],
					modelLifecycle: { status: "ACTIVE" },
					inferenceTypesSupported: ["ON_DEMAND"],
					inferenceAPIsSupported: {
						converse: { streaming: true, sync: true },
						openAiResponses: false,
					},
					explicitPromptCaching: { isSupported: false },
				},
				// A LEGACY model's status is surfaced so the filter can exclude it.
				{
					modelId: "anthropic.claude-opus-4-7",
					modelArn: "arn:aws:bedrock:us-east-1::foundation-model/anthropic.claude-opus-4-7",
					providerName: "Anthropic",
					inputModalities: ["TEXT", "IMAGE"],
					outputModalities: ["TEXT"],
					modelLifecycle: { status: "LEGACY" },
					inferenceTypesSupported: ["INFERENCE_PROFILE"],
					inferenceAPIsSupported: {
						converse: { streaming: true, sync: true },
						openAiResponses: false,
					},
					explicitPromptCaching: { isSupported: true },
				},
			],
		};
		const out = parseBedrockFoundationModels(body);
		const gpt = out[0];
		expect(gpt?.bedrock?.modelArn).toBe(
			"arn:aws:bedrock:us-east-2::foundation-model/openai.gpt-6.1-sol",
		);
		expect(gpt?.bedrock?.lifecycleStatus).toBe("ACTIVE");
		expect(gpt?.bedrock?.inferenceTypes).toEqual(["INFERENCE_PROFILE"]);
		expect(gpt?.bedrock?.inputText).toBe(true);
		expect(gpt?.bedrock?.outputTextOnly).toBe(true);
		expect(gpt?.bedrock?.openAiResponses).toBe(true);
		expect(gpt?.bedrock?.converseStreaming).toBe(true);
		expect(gpt?.bedrock?.explicitPromptCaching).toBe(true);
		const kimi = out[1];
		expect(kimi?.bedrock?.openAiResponses).toBe(false);
		expect(kimi?.bedrock?.inferenceTypes).toEqual(["ON_DEMAND"]);
		expect(kimi?.bedrock?.explicitPromptCaching).toBe(false);
		const legacy = out[2];
		expect(legacy?.bedrock?.lifecycleStatus).toBe("LEGACY");
	});

	it("leaves bedrock block fields unset when inferenceAPIsSupported/explicitPromptCaching are absent", () => {
		const out = parseBedrockFoundationModels({
			modelSummaries: [{ modelId: "meta.llama4-70b-v1:0", providerName: "Meta" }],
		});
		expect(out[0]?.bedrock?.openAiResponses).toBeUndefined();
		expect(out[0]?.bedrock?.explicitPromptCaching).toBeUndefined();
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
