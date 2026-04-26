/**
 * Amazon Bedrock driver — thin shim onto `@ai-sdk/amazon-bedrock`.
 *
 * Replaced the hand-rolled Converse-API wrapper (bedrock-driver.ts + bedrock/
 * folder, ~2000 lines) on 2026-04-25. The AI SDK handles:
 *   - Converse API envelope + event-stream decoding
 *   - SigV4 signing / AWS_BEARER_TOKEN_BEDROCK fallback
 *   - Retry and error shape normalization
 *   - Opus 4.7 reasoning-behavior quirks (patched in @ai-sdk/amazon-bedrock@3.0.97)
 *
 * We keep ownership of:
 *   - Message shape → ModelMessage conversion (ai-sdk-bridge.ts)
 *   - Cache breakpoint placement policy (cache-stable-prefix is still ours;
 *     the driver just forwards the markers via providerOptions.bedrock.cachePoint)
 *   - Stream chunk shape translation back to our StreamChunk type
 *   - Reasoning config construction from ChatParams.thinking + ChatParams.effort
 */

import { createAmazonBedrock } from "@ai-sdk/amazon-bedrock";
import type { AmazonBedrockProvider } from "@ai-sdk/amazon-bedrock";
import { fromIni } from "@aws-sdk/credential-providers";
import { streamText } from "ai";
import { mapChunks, mapError, toModelMessages, toToolSet } from "./ai-sdk-bridge";
import type { BackendCapabilities, ChatParams, LLMBackend, StreamChunk } from "./types";

interface BedrockReasoningConfig {
	type?: "enabled" | "disabled" | "adaptive";
	budgetTokens?: number;
	maxReasoningEffort?: "low" | "medium" | "high" | "xhigh" | "max";
	display?: "omitted" | "summarized";
}

export class BedrockDriver implements LLMBackend {
	private provider: AmazonBedrockProvider;
	private model: string;
	private contextWindow: number;

	constructor(config: {
		region: string;
		model: string;
		contextWindow: number;
		profile?: string;
	}) {
		this.model = config.model;
		this.contextWindow = config.contextWindow;
		// Auth precedence (matches @ai-sdk/amazon-bedrock@4 behavior):
		//   1. apiKey / AWS_BEARER_TOKEN_BEDROCK if set (handled by the SDK)
		//   2. explicit profile via fromIni (honors SSO, sts:AssumeRole, MFA)
		//   3. fall-through to the default AWS credential chain
		// The SDK only consults credentialProvider when no bearer token is
		// present, so wiring fromIni here is safe even when a user has a
		// bearer token configured.
		const credentialProvider = config.profile
			? async () => {
					const creds = await fromIni({ profile: config.profile })();
					return {
						accessKeyId: creds.accessKeyId,
						secretAccessKey: creds.secretAccessKey,
						sessionToken: creds.sessionToken,
					};
				}
			: undefined;
		this.provider = createAmazonBedrock({
			region: config.region,
			...(credentialProvider && { credentialProvider }),
		});
	}

	async *chat(params: ChatParams): AsyncIterable<StreamChunk> {
		// Use `||` not `??` — callers sometimes pass `model: ""` as a "use default"
		// sentinel (see openai-compatible-driver.ts for the same note).
		const modelId = params.model || this.model;
		const messages = toModelMessages(params.messages, { cacheProvider: "bedrock" });
		const tools = toToolSet(params.tools);
		const reasoningConfig = buildReasoningConfig(params);

		// Emit heartbeat immediately. Extended thinking can produce a 60s+ gap
		// before the first content event, which would trip the relay silence
		// timeout. This matches the legacy driver's messageStart behavior.
		yield { type: "heartbeat" };

		const result = streamText({
			model: this.provider.languageModel(modelId),
			messages,
			...(params.system && { system: params.system }),
			...(tools && { tools }),
			...(params.max_tokens && { maxOutputTokens: params.max_tokens }),
			// Reasoning requests disallow temperature on Anthropic; only set it
			// when we're not in thinking mode. Mirrors the old validator gate.
			...(params.temperature !== undefined &&
				!reasoningConfig && { temperature: params.temperature }),
			abortSignal: params.signal,
			providerOptions: {
				bedrock: {
					...(reasoningConfig && { reasoningConfig }),
				} as Record<string, unknown> as never,
			},
		});

		try {
			yield* mapChunks(result.fullStream, {
				usageProvider: "bedrock",
				estimateInputFromMessages: params.messages,
			});
		} catch (err) {
			throw mapError(err, "bedrock");
		}
	}

	capabilities(): BackendCapabilities {
		return {
			streaming: true,
			tool_use: true,
			system_prompt: true,
			prompt_caching: true,
			vision: true,
			extended_thinking: true,
			max_context: this.contextWindow,
		};
	}
}

function buildReasoningConfig(params: ChatParams): BedrockReasoningConfig | undefined {
	if (!params.thinking && !params.effort) return undefined;
	const config: BedrockReasoningConfig = {};
	if (params.thinking?.type === "enabled") {
		config.type = "enabled";
		config.budgetTokens = params.thinking.budget_tokens;
	} else if (params.thinking?.type === "adaptive") {
		config.type = "adaptive";
		if (params.thinking.display) config.display = params.thinking.display;
	}
	if (params.effort) config.maxReasoningEffort = params.effort;
	return Object.keys(config).length > 0 ? config : undefined;
}
