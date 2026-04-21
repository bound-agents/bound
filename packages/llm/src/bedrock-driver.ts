import {
	BedrockRuntimeClient,
	ConverseStreamCommand,
	type ConverseStreamCommandOutput,
} from "@aws-sdk/client-bedrock-runtime";
import type { Message, SystemContentBlock, Tool } from "@aws-sdk/client-bedrock-runtime";
import { formatError } from "@bound/shared";
import { toBedrockRequest } from "./bedrock/convert";
import { validateBedrockRequest } from "./bedrock/validate";
import { withRetry } from "./retry";
import type { BackendCapabilities, ChatParams, LLMBackend, StreamChunk } from "./types";
import { LLMError } from "./types";

// --- legacy helper removed: runtime path goes through toBedrockRequest() + ---
// --- validateBedrockRequest(). Tests now import toBedrockMessages from    ---
// --- ./bedrock/convert directly. See 2026-04-21 driver-swap commit.       ---

export class BedrockDriver implements LLMBackend {
	private client: BedrockRuntimeClient;
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
		this.client = new BedrockRuntimeClient({
			region: config.region,
			...(config.profile && { profile: config.profile }),
		});
	}

	async *chat(params: ChatParams): AsyncIterable<StreamChunk> {
		// Airlock: shape the request, then hand it to the validator. Any
		// invariant violation throws BedrockValidationError here, before any
		// HTTP call. This replaces what used to be a mix of inline assembly
		// and hope.
		const raw = toBedrockRequest({ params, defaultModel: this.model });
		const validated = validateBedrockRequest(raw);

		// The validated shape is structurally compatible with ConverseStreamCommand's
		// input; the brand is a compile-time marker, not a runtime difference.
		// Spread into a plain object to satisfy the SDK's looser types.
		const command = new ConverseStreamCommand({
			modelId: validated.modelId,
			messages: validated.messages as unknown as Message[],
			...(validated.system && { system: validated.system as unknown as SystemContentBlock[] }),
			...(validated.toolConfig && {
				toolConfig: validated.toolConfig as unknown as { tools: Tool[] },
			}),
			inferenceConfig: {
				...(validated.inferenceConfig.thinking === false &&
					validated.inferenceConfig.temperature !== undefined && {
						temperature: validated.inferenceConfig.temperature,
					}),
				...(validated.inferenceConfig.maxTokens !== undefined && {
					maxTokens: validated.inferenceConfig.maxTokens,
				}),
			},
			...(validated.performanceConfig && {
				performanceConfig: validated.performanceConfig as unknown as Record<string, unknown>,
			}),
		} as ConstructorParameters<typeof ConverseStreamCommand>[0]);

		const response = await withRetry(async () => {
			let res: ConverseStreamCommandOutput;
			try {
				res = await this.client.send(command, {
					abortSignal: params.signal,
				});
			} catch (error) {
				// Extract HTTP status from AWS SDK $metadata when available
				const metadata = (error as Record<string, unknown>)?.$metadata as
					| { httpStatusCode?: number }
					| undefined;
				const statusCode = metadata?.httpStatusCode;
				throw new LLMError(
					`Bedrock request failed: ${formatError(error)}`,
					"bedrock",
					statusCode,
					error instanceof Error ? error : new Error(String(error)),
				);
			}

			if (!res.stream) {
				throw new LLMError("Bedrock response contained no stream", "bedrock");
			}

			return res;
		});

		// Track which content block index is a tool use so we can emit tool_use_end
		// when the corresponding contentBlockStop arrives.
		const toolUseIndexToId = new Map<number, string>();
		const thinkingBlockIndices = new Set<number>();
		let outputText = "";

		try {
			// biome-ignore lint/style/noNonNullAssertion: stream existence already checked above
			for await (const event of response.stream!) {
				if (event.messageStart) {
					// Yield heartbeat to reset the silence timeout timer.
					// messageStart arrives early in the stream, before the model
					// starts producing content (thinking/text). Without this,
					// extended thinking can cause 60s+ gaps before the first
					// content chunk, triggering false silence timeouts.
					yield { type: "heartbeat" };
				} else if (event.contentBlockStart) {
					const { contentBlockIndex, start } = event.contentBlockStart;
					if (start?.toolUse) {
						const { toolUseId, name } = start.toolUse;
						const id = toolUseId ?? "";
						toolUseIndexToId.set(contentBlockIndex ?? 0, id);
						yield { type: "tool_use_start", id, name: name ?? "" };
					} else if ((start as unknown as Record<string, unknown>)?.thinking !== undefined) {
						thinkingBlockIndices.add(contentBlockIndex ?? 0);
					}
				} else if (event.contentBlockDelta) {
					const { contentBlockIndex, delta } = event.contentBlockDelta;
					const deltaRecord = delta as unknown as Record<string, unknown> | undefined;
					// Handle thinking deltas (text and signature)
					if (
						thinkingBlockIndices.has(contentBlockIndex ?? 0) &&
						deltaRecord?.thinking !== undefined
					) {
						const thinkingDelta = deltaRecord.thinking as
							| { text?: string; signature?: string }
							| undefined;
						if (thinkingDelta?.signature) {
							yield { type: "thinking", content: "", signature: thinkingDelta.signature };
						} else if (thinkingDelta?.text) {
							yield { type: "thinking", content: thinkingDelta.text };
						}
					} else if (delta?.text !== undefined) {
						outputText += delta.text;
						yield { type: "text", content: delta.text };
					} else if (delta?.toolUse) {
						const id = toolUseIndexToId.get(contentBlockIndex ?? 0) ?? "";
						yield { type: "tool_use_args", id, partial_json: delta.toolUse.input ?? "" };
					}
				} else if (event.contentBlockStop) {
					const { contentBlockIndex } = event.contentBlockStop;
					const id = toolUseIndexToId.get(contentBlockIndex ?? 0);
					if (id !== undefined) {
						yield { type: "tool_use_end", id };
						toolUseIndexToId.delete(contentBlockIndex ?? 0);
					}
				} else if (event.metadata) {
					const usage = event.metadata.usage as Record<string, unknown> | undefined;
					let inputTokens = (usage?.inputTokens as number) ?? 0;
					let outputTokens = (usage?.outputTokens as number) ?? 0;
					const cw = usage?.cacheWriteInputTokens; // NOTE: "Tokens" not "Count" per AWS API
					const cr = usage?.cacheReadInputTokens; // NOTE: "Tokens" not "Count" per AWS API
					const cacheWriteTokens = typeof cw === "number" ? cw : null;
					const cacheReadTokens = typeof cr === "number" ? cr : null;

					// Zero-usage guard
					let estimated = false;
					if (inputTokens === 0 && outputTokens === 0 && outputText.length > 0) {
						inputTokens = Math.ceil(
							params.messages.reduce(
								(sum, m) =>
									sum +
									(typeof m.content === "string"
										? m.content.length
										: JSON.stringify(m.content).length),
								0,
							) / 4,
						);
						outputTokens = Math.ceil(outputText.length / 4);
						estimated = true;
					}
					yield {
						type: "done",
						usage: {
							input_tokens: inputTokens,
							output_tokens: outputTokens,
							cache_write_tokens: cacheWriteTokens,
							cache_read_tokens: cacheReadTokens,
							estimated,
						},
					};
				}
			}
		} catch (error) {
			throw new LLMError(
				`Bedrock stream error: ${formatError(error)}`,
				"bedrock",
				undefined,
				error instanceof Error ? error : new Error(String(error)),
			);
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
