/**
 * Bedrock namespace lineup filter (2026-11-21-model-catalog.md §2.1). Pure: given the two control-plane fixtures (foundation models +
 * inference profiles) parsed into `DiscoveredModel[]` and a `cross_region`
 * preference, it decides which models are in the namespace lineup, the callable
 * id each uses (bare model id for ON_DEMAND, else a SYSTEM_DEFINED profile), and
 * the wire protocol (Responses on bedrock-runtime vs Converse). Every decision
 * traces to a published field; no model-ID branch.
 */

import { describe, expect, it } from "bun:test";
import { selectBedrockLineup, selectMantleLineupWithExclusions } from "./bedrock-lineup";
import type { DiscoveredModel } from "./discovery";

// A foundation-model row for `region`, with the lineup-filter fields the filter
// reads. Defaults describe a callable, ACTIVE, text-in/text-out model.
function fm(
	id: string,
	region: string,
	over: Partial<NonNullable<DiscoveredModel["bedrock"]>> = {},
): DiscoveredModel {
	return {
		providerModelId: id,
		bedrock: {
			modelArn: `arn:aws:bedrock:${region}::foundation-model/${id}`,
			lifecycleStatus: "ACTIVE",
			inferenceTypes: ["INFERENCE_PROFILE"],
			inputText: true,
			outputTextOnly: true,
			openAiResponses: false,
			converseStreaming: true,
			explicitPromptCaching: true,
			...over,
		},
	};
}

// A SYSTEM_DEFINED inference profile covering `coveredModelId` in `region`. A
// `global.`/`us.` profile covers both the region-qualified and the bare ARN.
function profile(profileId: string, region: string, coveredModelId: string): DiscoveredModel {
	return {
		providerModelId: profileId,
		bedrock: {
			profileType: "SYSTEM_DEFINED",
			profileStatus: "ACTIVE",
			profileModelArns: [
				`arn:aws:bedrock:::foundation-model/${coveredModelId}`,
				`arn:aws:bedrock:${region}::foundation-model/${coveredModelId}`,
			],
		},
	};
}

describe("selectBedrockLineup", () => {
	it("includes an ON_DEMAND model by its bare id over Converse", () => {
		const discovery = [fm("zai.glm-5", "us-west-2", { inferenceTypes: ["ON_DEMAND"] })];
		const out = selectBedrockLineup(discovery, { region: "us-west-2" });
		expect(out).toHaveLength(1);
		expect(out[0]).toMatchObject({
			providerModelId: "zai.glm-5",
			callableId: "zai.glm-5",
			protocol: "converse",
			promptCaching: true,
		});
	});

	it("includes an INFERENCE_PROFILE-only model via the preferred SYSTEM_DEFINED profile, default global", () => {
		const discovery = [
			fm("anthropic.claude-haiku-5-5", "us-east-1"),
			profile("global.anthropic.claude-haiku-5-5", "us-east-1", "anthropic.claude-haiku-5-5"),
			profile("us.anthropic.claude-haiku-5-5", "us-east-1", "anthropic.claude-haiku-5-5"),
		];
		const out = selectBedrockLineup(discovery, { region: "us-east-1" });
		expect(out).toHaveLength(1);
		// Default cross_region preference is "global".
		expect(out[0]).toMatchObject({
			providerModelId: "anthropic.claude-haiku-5-5",
			callableId: "global.anthropic.claude-haiku-5-5",
			protocol: "converse",
		});
	});

	it("honors an explicit cross_region preference, falling back to the geo profile when absent", () => {
		const discovery = [
			fm("openai.gpt-6.1-sol", "us-east-1", { openAiResponses: true }),
			// No global. profile — only a us. geo profile exists.
			profile("us.openai.gpt-6.1-sol", "us-east-1", "openai.gpt-6.1-sol"),
		];
		const out = selectBedrockLineup(discovery, { region: "us-east-1", crossRegion: "global" });
		// global. requested but only us. covers this ARN → fall back to the geo profile.
		expect(out[0]?.callableId).toBe("us.openai.gpt-6.1-sol");
	});

	it("routes an openAiResponses=true model to the responses protocol", () => {
		const discovery = [
			fm("openai.gpt-6.1-sol", "us-east-1", { openAiResponses: true }),
			profile("global.openai.gpt-6.1-sol", "us-east-1", "openai.gpt-6.1-sol"),
		];
		const out = selectBedrockLineup(discovery, { region: "us-east-1" });
		expect(out[0]).toMatchObject({
			providerModelId: "openai.gpt-6.1-sol",
			callableId: "global.openai.gpt-6.1-sol",
			protocol: "responses",
		});
	});

	it("excludes a non-ACTIVE model", () => {
		const discovery = [fm("anthropic.claude-opus-4-7", "us-east-1", { lifecycleStatus: "LEGACY" })];
		expect(selectBedrockLineup(discovery, { region: "us-east-1" })).toEqual([]);
	});

	it("excludes a model that is not text-in or not text-only-out", () => {
		const discovery = [
			fm("some.image-only", "us-east-1", { inputText: false }),
			fm("some.multimodal-out", "us-east-1", { outputTextOnly: false }),
		];
		expect(selectBedrockLineup(discovery, { region: "us-east-1" })).toEqual([]);
	});

	it("excludes an INFERENCE_PROFILE-only model with no covering SYSTEM_DEFINED profile", () => {
		// No profile row at all → not callable in this region.
		const discovery = [fm("anthropic.claude-opus-5-5", "us-east-1")];
		expect(selectBedrockLineup(discovery, { region: "us-east-1" })).toEqual([]);
	});

	it("excludes a model with no usable protocol (openAiResponses=false AND converse.streaming=false)", () => {
		const discovery = [
			fm("some.async-only", "us-east-1", {
				inferenceTypes: ["ON_DEMAND"],
				openAiResponses: false,
				converseStreaming: false,
			}),
		];
		expect(selectBedrockLineup(discovery, { region: "us-east-1" })).toEqual([]);
	});

	it("surfaces explicitPromptCaching=false as promptCaching=false", () => {
		const discovery = [
			fm("moonshotai.kimi-k2.5", "us-west-2", {
				inferenceTypes: ["ON_DEMAND"],
				explicitPromptCaching: false,
			}),
		];
		const out = selectBedrockLineup(discovery, { region: "us-west-2" });
		expect(out[0]?.promptCaching).toBe(false);
	});

	it("prefers the bare ON_DEMAND id even when a profile also exists", () => {
		const discovery = [
			fm("amazon.nova-pro-v1:0", "us-west-2", {
				inferenceTypes: ["ON_DEMAND", "INFERENCE_PROFILE"],
			}),
			profile("us.amazon.nova-pro-v1:0", "us-west-2", "amazon.nova-pro-v1:0"),
		];
		const out = selectBedrockLineup(discovery, { region: "us-west-2" });
		expect(out[0]?.callableId).toBe("amazon.nova-pro-v1:0");
	});

	it("ignores a non-SYSTEM_DEFINED (application) inference profile", () => {
		const discovery = [
			fm("anthropic.claude-haiku-5-5", "us-east-1"),
			{
				providerModelId: "my-app-profile",
				bedrock: {
					profileType: "APPLICATION",
					profileStatus: "ACTIVE",
					profileModelArns: [
						"arn:aws:bedrock:us-east-1::foundation-model/anthropic.claude-haiku-5-5",
					],
				},
			},
		];
		// INFERENCE_PROFILE-only model with only an APPLICATION profile → excluded.
		expect(selectBedrockLineup(discovery, { region: "us-east-1" })).toEqual([]);
	});
});

// A Mantle `/v1/models` row (bare vendor-prefixed id, e.g. `openai.gpt-5.6-sol`).
function mantleRow(id: string): DiscoveredModel {
	return { providerModelId: id };
}

// A foundation-model row the Mantle id joins on for its protocol signal.
function fmRow(
	id: string,
	over: Partial<NonNullable<DiscoveredModel["bedrock"]>> = {},
): DiscoveredModel {
	return {
		providerModelId: id,
		bedrock: {
			modelArn: `arn:aws:bedrock:us-east-2::foundation-model/${id}`,
			lifecycleStatus: "ACTIVE",
			inferenceTypes: ["INFERENCE_PROFILE"],
			inputText: true,
			outputTextOnly: true,
			openAiResponses: true,
			converseStreaming: true,
			explicitPromptCaching: true,
			...over,
		},
	};
}

describe("selectMantleLineupWithExclusions", () => {
	it("includes a Mantle model that joins a foundation model, protocol from the join", () => {
		const mantle = [mantleRow("openai.gpt-5.6-sol")];
		const foundation = [fmRow("openai.gpt-5.6-sol", { openAiResponses: true })];
		const out = selectMantleLineupWithExclusions(mantle, foundation).lineup;
		expect(out).toHaveLength(1);
		expect(out[0]).toMatchObject({
			providerModelId: "openai.gpt-5.6-sol",
			callableId: "openai.gpt-5.6-sol",
			protocol: "responses",
			promptCaching: true,
		});
	});

	it("uses converse when the joined model advertises converse.streaming but not openAiResponses", () => {
		const mantle = [mantleRow("moonshotai.kimi-k2.5")];
		const foundation = [
			fmRow("moonshotai.kimi-k2.5", {
				openAiResponses: false,
				converseStreaming: true,
				explicitPromptCaching: false,
			}),
		];
		const out = selectMantleLineupWithExclusions(mantle, foundation).lineup;
		expect(out[0]).toMatchObject({ protocol: "converse", promptCaching: false });
	});

	it("EXCLUDES a Mantle model with no foundation-model join (unjoinable id)", () => {
		// A versioned snapshot id / Anthropic Messages model has no fm join.
		const mantle = [
			mantleRow("openai.gpt-5.5-2026-04-23"),
			mantleRow("anthropic.claude-haiku-4-5"),
		];
		const foundation = [fmRow("openai.gpt-5.5", { openAiResponses: true })];
		expect(selectMantleLineupWithExclusions(mantle, foundation).lineup).toEqual([]);
	});

	it("EXCLUDES a joined model whose protocol signal is neither responses nor converse-streaming", () => {
		const mantle = [mantleRow("some.async-only")];
		const foundation = [
			fmRow("some.async-only", { openAiResponses: false, converseStreaming: false }),
		];
		expect(selectMantleLineupWithExclusions(mantle, foundation).lineup).toEqual([]);
	});

	it("returns the list of excluded ids for the operator report", () => {
		const mantle = [mantleRow("openai.gpt-5.6-sol"), mantleRow("anthropic.claude-haiku-4-5")];
		const foundation = [fmRow("openai.gpt-5.6-sol", { openAiResponses: true })];
		const { lineup, excluded } = selectMantleLineupWithExclusions(mantle, foundation);
		expect(lineup.map((e) => e.providerModelId)).toEqual(["openai.gpt-5.6-sol"]);
		expect(excluded).toContain("anthropic.claude-haiku-4-5");
	});
});
