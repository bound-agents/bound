import {
	BedrockRuntimeClient,
	ConverseStreamCommand,
	type ConverseStreamCommandOutput,
} from "@aws-sdk/client-bedrock-runtime";
import type { Message, SystemContentBlock, Tool } from "@aws-sdk/client-bedrock-runtime";
import { formatError } from "@bound/shared";
import type { DocumentType } from "@smithy/types";
import { withRetry } from "./retry";
import { extractTextFromBlocks } from "./stream-utils";
import type { BackendCapabilities, ChatParams, LLMBackend, LLMMessage, StreamChunk } from "./types";
import { LLMError } from "./types";

function toBedrockMessages(messages: LLMMessage[]): Message[] {
	const result: Message[] = [];

	for (const msg of messages) {
		if (msg.role === "system") {
			// system messages are handled separately via the system prompt param
			continue;
		}

		// Skip non-standard roles that Bedrock cannot handle (e.g. alert, purge)
		// These should be filtered upstream in context assembly, but guard here defensively
		if (
			msg.role !== "user" &&
			msg.role !== "assistant" &&
			msg.role !== "tool_call" &&
			msg.role !== "tool_result"
		) {
			continue;
		}

		if (msg.role === "tool_call") {
			// assistant message carrying tool_use blocks
			const content: Message["content"] = [];
			if (Array.isArray(msg.content)) {
				for (const block of msg.content) {
					if (block.type === "tool_use") {
						content.push({
							toolUse: {
								toolUseId: block.id,
								name: block.name,
								input: block.input as DocumentType,
							},
						});
					} else if (block.type === "text") {
						content.push({ text: block.text });
					}
				}
			} else {
				// DB stores tool_call content as JSON string — try parsing it
				try {
					const parsed = JSON.parse(msg.content);
					if (Array.isArray(parsed)) {
						for (const block of parsed) {
							if (block.type === "tool_use") {
								content.push({
									toolUse: {
										toolUseId: block.id ?? "",
										name: block.name ?? "",
										input: (block.input ?? {}) as DocumentType,
									},
								});
							}
						}
					}
				} catch {
					content.push({ text: msg.content });
				}
			}
			result.push({
				role: "assistant",
				content: content.length > 0 ? content : [{ text: "" }],
			});
			continue;
		}

		if (msg.role === "tool_result") {
			const toolUseId = msg.tool_use_id || `synthetic-${Date.now()}-${result.length}`;
			const textContent = Array.isArray(msg.content)
				? extractTextFromBlocks(msg.content)
				: msg.content;
			const toolResultBlock = {
				toolResult: {
					toolUseId,
					content: [{ text: textContent }],
				},
			};
			// Merge consecutive tool_result messages into a single user message.
			// Bedrock requires ALL toolResult blocks for a multi-tool response to be
			// in one user message.
			const lastMsg = result.at(-1);
			if (
				lastMsg?.role === "user" &&
				Array.isArray(lastMsg.content) &&
				lastMsg.content.some((b) => "toolResult" in b)
			) {
				lastMsg.content.push(toolResultBlock);
			} else {
				result.push({
					role: "user",
					content: [toolResultBlock],
				});
			}
			continue;
		}

		// user / assistant with plain text or content blocks
		const role = msg.role as "user" | "assistant";
		if (Array.isArray(msg.content)) {
			const text = extractTextFromBlocks(msg.content);
			result.push({ role, content: [{ text }] });
		} else {
			result.push({ role, content: [{ text: msg.content }] });
		}
	}

	return result;
}

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
		const modelId = params.model || this.model;
		const messages = toBedrockMessages(params.messages);

		// Inject cachePoint markers at breakpoint indices so Bedrock caches
		// all content up to and including that message.
		// NOTE: cache_ttl is NOT passed through to Bedrock cachePoint yet.
		// Adding ttl to the cachePoint silently broke message-level caching for
		// large contexts (>200k tokens). The infrastructure remains in ChatParams
		// for future use once Bedrock TTL support is verified end-to-end.
		if (params.cache_breakpoints) {
			for (const idx of params.cache_breakpoints) {
				if (messages[idx] && Array.isArray(messages[idx].content)) {
					// biome-ignore lint/suspicious/noExplicitAny: Bedrock SDK types don't include cachePoint yet
					(messages[idx].content as any[]).push({
						cachePoint: { type: "default" },
					});
				}
			}
		}

		// When cache breakpoints are present, also cache the system prompt.
		const systemBlocks: SystemContentBlock[] | undefined = params.system
			? params.cache_breakpoints?.length
				? [
						{ text: params.system },
						// biome-ignore lint/suspicious/noExplicitAny: Bedrock SDK types don't include cachePoint yet
						{ cachePoint: { type: "default" } } as any,
					]
				: [{ text: params.system }]
			: undefined;

		const toolConfig =
			params.tools && params.tools.length > 0
				? {
						tools: params.tools.map(
							(t): Tool => ({
								toolSpec: {
									name: t.function.name,
									description: t.function.description,
									inputSchema: {
										json: t.function.parameters as DocumentType,
									},
								},
							}),
						),
					}
				: undefined;

		const inferenceConfig =
			params.temperature !== undefined || params.max_tokens
				? {
						...(params.temperature !== undefined && { temperature: params.temperature }),
						...(params.max_tokens && { maxTokens: params.max_tokens }),
					}
				: undefined;

		const command = new ConverseStreamCommand({
			modelId,
			messages,
			...(systemBlocks && { system: systemBlocks }),
			...(toolConfig && { toolConfig }),
			...(inferenceConfig && { inferenceConfig }),
		});

		const response = await withRetry(async () => {
			let res: ConverseStreamCommandOutput;
			try {
				res = await this.client.send(command, {
					abortSignal: params.signal,
				});
			} catch (error) {
				throw new LLMError(
					`Bedrock request failed: ${formatError(error)}`,
					"bedrock",
					undefined,
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
		let outputText = "";

		try {
			// biome-ignore lint/style/noNonNullAssertion: stream existence already checked above
			for await (const event of response.stream!) {
				if (event.contentBlockStart) {
					const { contentBlockIndex, start } = event.contentBlockStart;
					if (start?.toolUse) {
						const { toolUseId, name } = start.toolUse;
						const id = toolUseId ?? "";
						toolUseIndexToId.set(contentBlockIndex ?? 0, id);
						yield { type: "tool_use_start", id, name: name ?? "" };
					}
				} else if (event.contentBlockDelta) {
					const { contentBlockIndex, delta } = event.contentBlockDelta;
					if (delta?.text !== undefined) {
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
			max_context: this.contextWindow,
		};
	}
}
