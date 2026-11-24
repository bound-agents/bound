/**
 * Bedrock self-configuring namespace (2026-11-21-model-catalog.md §2.1,
 * requirement 1/2). A `bedrock` entry with no `model` is a namespace for its
 * (profile, region): its `readiness` fetches the two control-plane endpoints,
 * runs `selectBedrockLineup`, and registers one per-model backend — a Converse
 * `BedrockDriver` for a `converse` model, a Responses driver (bedrock-runtime,
 * SigV4) for an `openAiResponses` model. Mirrors the Copilot/umans readiness
 * contract; no model-ID branch.
 */

import { describe, expect, it } from "bun:test";
import type { BackendReadiness, LLMBackend, ModelDescriptor } from "../types";
import { BedrockNamespaceDriver } from "./bedrock-namespace";

// Minimal foundation-models + inference-profiles fixture bodies the discovery
// fetch returns. The two endpoints are served by path.
function fixtureFetch(bodies: {
	foundationModels: unknown;
	inferenceProfiles: unknown;
	requests?: string[];
}): typeof fetch {
	return (async (input: RequestInfo | URL, init?: RequestInit) => {
		const req = new Request(input, init);
		bodies.requests?.push(new URL(req.url).pathname);
		const path = new URL(req.url).pathname;
		if (path.endsWith("/foundation-models")) {
			return new Response(JSON.stringify(bodies.foundationModels), { status: 200 });
		}
		if (path.endsWith("/inference-profiles")) {
			return new Response(JSON.stringify(bodies.inferenceProfiles), { status: 200 });
		}
		return new Response("not found", { status: 404 });
	}) as typeof fetch;
}

/** Drain one register call from a namespace driver's readiness run. */
async function expand(
	driver: BedrockNamespaceDriver,
): Promise<Array<{ descriptor: ModelDescriptor; backend: LLMBackend }>> {
	const readiness = driver.readiness as BackendReadiness;
	let registered: Array<{ descriptor: ModelDescriptor; backend: LLMBackend }> = [];
	readiness.start({
		register(_providerId, models) {
			registered = models;
		},
	});
	for (let i = 0; i < 20 && !readiness.isReady(); i++) {
		await new Promise((r) => setTimeout(r, 0));
	}
	return registered;
}

const foundationModels = {
	modelSummaries: [
		{
			modelId: "anthropic.claude-haiku-5-5",
			modelArn: "arn:aws:bedrock:us-east-1::foundation-model/anthropic.claude-haiku-5-5",
			providerName: "Anthropic",
			inputModalities: ["TEXT", "IMAGE"],
			outputModalities: ["TEXT"],
			modelLifecycle: { status: "ACTIVE" },
			inferenceTypesSupported: ["INFERENCE_PROFILE"],
			inferenceAPIsSupported: { converse: { streaming: true, sync: true }, openAiResponses: false },
			explicitPromptCaching: { isSupported: true },
		},
		{
			modelId: "openai.gpt-6.1-sol",
			modelArn: "arn:aws:bedrock:us-east-1::foundation-model/openai.gpt-6.1-sol",
			providerName: "OpenAI",
			inputModalities: ["TEXT", "IMAGE"],
			outputModalities: ["TEXT"],
			modelLifecycle: { status: "ACTIVE" },
			inferenceTypesSupported: ["INFERENCE_PROFILE"],
			inferenceAPIsSupported: { converse: { streaming: true, sync: true }, openAiResponses: true },
			explicitPromptCaching: { isSupported: true },
		},
		{
			modelId: "zai.glm-5",
			modelArn: "arn:aws:bedrock:us-east-1::foundation-model/zai.glm-5",
			providerName: "Z.AI",
			inputModalities: ["TEXT"],
			outputModalities: ["TEXT"],
			modelLifecycle: { status: "ACTIVE" },
			inferenceTypesSupported: ["ON_DEMAND"],
			inferenceAPIsSupported: { converse: { streaming: true, sync: true }, openAiResponses: false },
			explicitPromptCaching: { isSupported: false },
		},
	],
};

const inferenceProfiles = {
	inferenceProfileSummaries: [
		{
			inferenceProfileId: "global.anthropic.claude-haiku-5-5",
			type: "SYSTEM_DEFINED",
			status: "ACTIVE",
			models: [{ modelArn: "arn:aws:bedrock:::foundation-model/anthropic.claude-haiku-5-5" }],
		},
		{
			inferenceProfileId: "global.openai.gpt-6.1-sol",
			type: "SYSTEM_DEFINED",
			status: "ACTIVE",
			models: [{ modelArn: "arn:aws:bedrock:::foundation-model/openai.gpt-6.1-sol" }],
		},
	],
};

describe("BedrockNamespaceDriver (self-configuring expansion)", () => {
	it("carries readiness and its chat() throws a guard", async () => {
		const driver = new BedrockNamespaceDriver({
			namespaceId: "bedrock-use1",
			region: "us-east-1",
			fetch: fixtureFetch({ foundationModels: {}, inferenceProfiles: {} }),
		});
		expect(driver.readiness).toBeDefined();
		await expect(async () => {
			for await (const _ of driver.chat({ messages: [] } as never)) {
				// no-op
			}
		}).toThrow();
	});

	it("registers one backend per lineup model with namespace-prefixed ids", async () => {
		const driver = new BedrockNamespaceDriver({
			namespaceId: "bedrock-use1",
			region: "us-east-1",
			fetch: fixtureFetch({ foundationModels, inferenceProfiles }),
		});
		const registered = await expand(driver);
		const ids = registered.map((r) => r.descriptor.id).sort();
		expect(ids).toEqual([
			"bedrock-use1-anthropic.claude-haiku-5-5",
			"bedrock-use1-openai.gpt-6.1-sol",
			"bedrock-use1-zai.glm-5",
		]);
		// Each descriptor carries its RAW provider model id for grouping/overrides.
		const haiku = registered.find(
			(r) => r.descriptor.providerModelId === "anthropic.claude-haiku-5-5",
		);
		expect(haiku).toBeDefined();
	});

	it("surfaces explicitPromptCaching into each descriptor's prompt_caching capability (R-MC7)", async () => {
		const driver = new BedrockNamespaceDriver({
			namespaceId: "bedrock-use1",
			region: "us-east-1",
			fetch: fixtureFetch({ foundationModels, inferenceProfiles }),
		});
		const registered = await expand(driver);
		const glm = registered.find((r) => r.descriptor.providerModelId === "zai.glm-5");
		const haiku = registered.find(
			(r) => r.descriptor.providerModelId === "anthropic.claude-haiku-5-5",
		);
		expect(glm?.descriptor.capabilities.prompt_caching).toBe(false);
		expect(haiku?.descriptor.capabilities.prompt_caching).toBe(true);
	});

	it("retries when both control-plane fetches fail, then registers once reachable", async () => {
		let attempt = 0;
		const flakyFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
			attempt++;
			const req = new Request(input, init);
			const path = new URL(req.url).pathname;
			// First round: both endpoints 500. Later rounds: serve the fixtures.
			if (attempt <= 2) return new Response("err", { status: 500 });
			if (path.endsWith("/foundation-models")) {
				return new Response(JSON.stringify(foundationModels), { status: 200 });
			}
			return new Response(JSON.stringify(inferenceProfiles), { status: 200 });
		}) as typeof fetch;
		const driver = new BedrockNamespaceDriver({
			namespaceId: "bedrock-use1",
			region: "us-east-1",
			fetch: flakyFetch,
			retryBaseMs: 1,
			retryMaxMs: 2,
		});
		const registered = await expand(driver);
		expect(registered.length).toBe(3);
	});

	it("applies a model_overrides logical_model pin to the expanded descriptor", async () => {
		const driver = new BedrockNamespaceDriver({
			namespaceId: "bedrock-use1",
			region: "us-east-1",
			fetch: fixtureFetch({ foundationModels, inferenceProfiles }),
			modelOverrides: {
				"anthropic.claude-haiku-5-5": { logicalModel: "haiku" },
			},
		});
		const registered = await expand(driver);
		const haiku = registered.find(
			(r) => r.descriptor.providerModelId === "anthropic.claude-haiku-5-5",
		);
		expect(haiku?.descriptor.logicalModel).toBe("haiku");
	});
});
