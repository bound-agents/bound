/**
 * Pipeline contract: ModelRouter.getThinkingConfig(id) must feed
 * BedrockDriver.chat({ thinking }) such that the AWS SDK command carries
 * `additionalModelRequestFields.thinking`.
 *
 * This binds the router → driver → SDK seam — the one that, combined
 * with a schema/CLI strip upstream, silently disabled extended thinking
 * for ~every agent turn on 2026-04-25. The driver-level test
 * (thinking.test.ts:"includes additionalModelRequestFields.thinking...")
 * already locks the driver -> SDK half; this test locks the router ->
 * driver half so a future refactor can't reintroduce the "getThinkingConfig
 * returns undefined" regression without being caught.
 */

import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { BedrockRuntimeClient } from "@aws-sdk/client-bedrock-runtime";
import { createModelRouter } from "../model-router";
import type { ModelBackendsConfig } from "../types";

function createMockBedrockStream(events: Record<string, unknown>[]) {
	return {
		stream: (async function* () {
			for (const event of events) yield event;
		})(),
	};
}

describe("ModelRouter -> BedrockDriver thinking propagation", () => {
	let sendSpy: ReturnType<typeof spyOn<BedrockRuntimeClient, "send">>;

	beforeEach(() => {
		sendSpy = spyOn(BedrockRuntimeClient.prototype, "send");
		sendSpy.mockImplementation(() =>
			Promise.resolve(
				createMockBedrockStream([{ metadata: { usage: { inputTokens: 10, outputTokens: 5 } } }]),
			),
		);
	});

	afterEach(() => {
		sendSpy.mockRestore();
	});

	it("thinking config on a bedrock backend reaches additionalModelRequestFields on the SDK call", async () => {
		const cfg: ModelBackendsConfig = {
			backends: [
				{
					id: "opus",
					provider: "bedrock",
					model: "anthropic.claude-3-5-sonnet-20241022-v2:0",
					region: "us-east-1",
					contextWindow: 200000,
					// The router reads this field directly; if the field name,
					// shape, or reader logic drifts, this test catches it.
					thinking: { type: "enabled", budget_tokens: 12000 },
				},
			],
			default: "opus",
		};

		const router = createModelRouter(cfg);
		const backend = router.getBackend("opus");
		const thinking = router.getThinkingConfig("opus");

		expect(thinking).toEqual({ type: "enabled", budget_tokens: 12000 });

		const iter = backend.chat({
			messages: [{ role: "user", content: "think" }],
			thinking,
		});
		for await (const _ of iter) void _;

		expect(sendSpy.mock.calls).toHaveLength(1);
		const commandInput = (sendSpy.mock.calls[0][0] as { input: Record<string, unknown> }).input;
		expect(commandInput.additionalModelRequestFields).toEqual({
			thinking: {
				type: "enabled",
				budget_tokens: 12000,
			},
		});
	});

	it("no thinking config on the backend -> no additionalModelRequestFields on SDK call", async () => {
		const cfg: ModelBackendsConfig = {
			backends: [
				{
					id: "opus",
					provider: "bedrock",
					model: "anthropic.claude-3-5-sonnet-20241022-v2:0",
					region: "us-east-1",
					contextWindow: 200000,
				},
			],
			default: "opus",
		};

		const router = createModelRouter(cfg);
		const backend = router.getBackend("opus");
		const thinking = router.getThinkingConfig("opus");

		expect(thinking).toBeUndefined();

		const iter = backend.chat({
			messages: [{ role: "user", content: "hi" }],
			thinking,
		});
		for await (const _ of iter) void _;

		const commandInput = (sendSpy.mock.calls[0][0] as { input: Record<string, unknown> }).input;
		expect(commandInput.additionalModelRequestFields).toBeUndefined();
	});
});
