import {
	BedrockRuntimeClient,
	ConverseStreamCommand,
	type ConverseStreamCommandOutput,
} from "@aws-sdk/client-bedrock-runtime";
import type {
	ContentBlock as BedrockContentBlock,
	Message,
	SystemContentBlock,
	Tool,
} from "@aws-sdk/client-bedrock-runtime";
import { formatError } from "@bound/shared";
import type { DocumentType } from "@smithy/types";
import { withRetry } from "./retry";
import { extractTextFromBlocks, sanitizeToolName } from "./stream-utils";
import type { BackendCapabilities, ChatParams, LLMBackend, LLMMessage, StreamChunk } from "./types";
import { LLMError } from "./types";

// Bedrock rejects blank text in content blocks. Use this placeholder for empty content.
const EMPTY_TEXT_PLACEHOLDER = "(empty)";

// CachePointBlock represents an undocumented Bedrock caching feature.
// This extends the official SDK types for prompt caching support.
interface CachePointBlock {
	cachePoint: { type: "default" };
}

export function toBedrockMessages(messages: LLMMessage[]): Message[] {
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
								name: sanitizeToolName(block.name),
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
										name: sanitizeToolName(block.name ?? ""),
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
				content: content.length > 0 ? content : [{ text: EMPTY_TEXT_PLACEHOLDER }],
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
			const content: BedrockContentBlock[] = [];
			for (const block of msg.content) {
				if (block.type === "text" && block.text) {
					content.push({ text: block.text });
				} else if (block.type === "image" && block.source) {
					const src = block.source;
					if (src.type === "base64") {
						const format = src.media_type.replace("image/", "") as "png" | "jpeg" | "gif" | "webp";
						content.push({
							image: {
								format,
								source: {
									bytes: Uint8Array.from(atob(src.data), (c) => c.charCodeAt(0)),
								},
							},
						});
					}
				}
			}
			if (content.length === 0) {
				content.push({ text: extractTextFromBlocks(msg.content) || EMPTY_TEXT_PLACEHOLDER });
			}
			result.push({ role, content });
		} else {
			result.push({ role, content: [{ text: msg.content || EMPTY_TEXT_PLACEHOLDER }] });
		}
	}

	// Bedrock requires the conversation to start with a user message.
	// When the first message is not "user" (e.g. scheduled task threads
	// that only have system wakeup + tool_call/tool_result), prepend a
	// placeholder so the API doesn't reject the request.
	if (result.length > 0 && result[0].role !== "user") {
		result.unshift({
			role: "user",
			content: [{ text: "<system-notification />" }],
		});
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

		// Inject cachePoint markers so Bedrock caches all content up to the
		// marked message. The caller passes breakpoint indices relative to
		// params.messages, but toBedrockMessages() may produce a shorter array
		// (consecutive tool_result messages get merged into a single user
		// message). We re-compute the breakpoint from the actual Bedrock
		// messages array to avoid out-of-bounds indices that silently skip
		// the cachePoint placement.
		if (params.cache_breakpoints && params.cache_breakpoints.length > 0 && messages.length >= 2) {
			const idx = messages.length - 2;
			if (Array.isArray(messages[idx].content)) {
				(messages[idx].content as Array<unknown>).push({
					cachePoint: { type: "default" },
				} as CachePointBlock);
			}
		}

		// When cache breakpoints are present, also cache the system prompt.
		// If system_suffix is present, place cachePoint between stable prefix and
		// varying suffix so only the prefix is cached.
		const effectiveSystem = params.system_suffix
			? params.cache_breakpoints?.length
				? params.system // Keep separate for three-block layout below
				: `${params.system}\n\n${params.system_suffix}` // Append when no caching
			: params.system;

		const systemBlocks: SystemContentBlock[] | undefined = effectiveSystem
			? params.cache_breakpoints?.length
				? params.system_suffix
					? [
							{ text: effectiveSystem },
							{ cachePoint: { type: "default" } } as CachePointBlock,
							{ text: params.system_suffix },
						]
					: [{ text: effectiveSystem }, { cachePoint: { type: "default" } } as CachePointBlock]
				: [{ text: effectiveSystem }]
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

		// When thinking is enabled, omit temperature (Anthropic/Bedrock requirement)
		const effectiveTemperature = params.thinking ? undefined : params.temperature;

		const inferenceConfig =
			effectiveTemperature !== undefined || params.max_tokens
				? {
						...(effectiveTemperature !== undefined && { temperature: effectiveTemperature }),
						...(params.max_tokens && { maxTokens: params.max_tokens }),
					}
				: undefined;

		// PerformanceConfiguration for extended thinking — the thinking field is not yet in
		// the AWS SDK types but is accepted by the Bedrock Converse API (same pattern as CachePointBlock).
		const performanceConfig = params.thinking
			? ({
					thinking: {
						type: "enabled",
						budgetTokens: params.thinking.budget_tokens,
					},
				} as Record<string, unknown>)
			: undefined;

		const command = new ConverseStreamCommand({
			modelId,
			messages,
			...(systemBlocks && { system: systemBlocks }),
			...(toolConfig && { toolConfig }),
			...(inferenceConfig && { inferenceConfig }),
			...(performanceConfig && { performanceConfig }),
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
				if (event.contentBlockStart) {
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
					// Handle thinking deltas
					if (
						thinkingBlockIndices.has(contentBlockIndex ?? 0) &&
						deltaRecord?.thinking !== undefined
					) {
						const thinkingDelta = deltaRecord.thinking as { text?: string } | undefined;
						if (thinkingDelta?.text) {
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
