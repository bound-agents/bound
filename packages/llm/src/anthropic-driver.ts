import { checkHttpError, wrapFetchError } from "./error-utils";
import { correctMediaType } from "./image-utils";
import { withRetry } from "./retry";
import {
	SSE_DATA_PREFIX,
	SSE_DONE_SENTINEL,
	extractTextFromBlocks,
	parseStreamLines,
	sanitizeToolName,
} from "./stream-utils";
import type { BackendCapabilities, ChatParams, LLMBackend, LLMMessage, StreamChunk } from "./types";

interface AnthropicContentBlock {
	type: "text" | "tool_use" | "tool_result" | "image" | "thinking";
	text?: string;
	thinking?: string;
	signature?: string;
	id?: string;
	name?: string;
	input?: Record<string, unknown>;
	tool_use_id?: string;
	content?: Array<
		| { type: "text"; text: string }
		| { type: "image"; source: { type: "base64"; media_type: string; data: string } }
	>;
	source?: {
		type: "base64";
		media_type: string;
		data: string;
	};
}

interface AnthropicMessage {
	role: "user" | "assistant";
	content: AnthropicContentBlock[];
	cache_control?: { type: "ephemeral"; ttl?: "5m" | "1h" };
}

interface AnthropicRequest {
	model: string;
	max_tokens: number;
	system?:
		| string
		| Array<{
				type: "text";
				text: string;
				cache_control?: { type: "ephemeral"; ttl?: "5m" | "1h" };
		  }>;
	messages: AnthropicMessage[];
	tools?: Array<{
		name: string;
		description?: string;
		input_schema: Record<string, unknown>;
	}>;
	temperature?: number;
}

type AnthropicEventType =
	| "message_start"
	| "content_block_start"
	| "content_block_delta"
	| "content_block_stop"
	| "message_delta"
	| "message_stop"
	| "ping"
	| "error";

interface AnthropicStreamDelta {
	type?: string;
	text?: string;
	partial_json?: string;
}

interface AnthropicToolUseBlock {
	type?: string;
	id?: string;
	name?: string;
}

interface AnthropicStreamEvent {
	type: AnthropicEventType;
	index?: number;
	content_block?: AnthropicToolUseBlock;
	delta?: AnthropicStreamDelta;
	usage?: {
		input_tokens?: number;
		output_tokens?: number;
	};
	message?: {
		usage?: {
			input_tokens: number;
			output_tokens: number;
			cache_creation_input_tokens?: number;
			cache_read_input_tokens?: number;
		};
	};
}

export function toAnthropicMessages(messages: LLMMessage[]): AnthropicMessage[] {
	const result: AnthropicMessage[] = [];
	const pendingDeveloperContent: string[] = [];

	for (const msg of messages) {
		// Developer role mapping — buffer content to prepend to next user message
		if (msg.role === "developer") {
			const text =
				typeof msg.content === "string" ? msg.content : extractTextFromBlocks(msg.content);
			pendingDeveloperContent.push(`<system-context>${text}</system-context>`);
			continue;
		}

		// Cache role mapping — append cache_control to previous message
		if (msg.role === "cache") {
			const prev = result.at(-1);
			if (prev) {
				prev.cache_control = { type: "ephemeral" };
			}
			continue;
		}

		// Handle array content blocks
		if (Array.isArray(msg.content)) {
			if (msg.role === "tool_call") {
				// Convert tool_call to assistant message with tool_use blocks
				const content: AnthropicMessage["content"] = [];
				for (const block of msg.content) {
					if (block.type === "thinking") {
						const thinkingBlock: AnthropicContentBlock = {
							type: "thinking",
							thinking: block.thinking,
						};
						if (block.signature) thinkingBlock.signature = block.signature;
						content.push(thinkingBlock);
					} else if (block.type === "tool_use") {
						content.push({
							type: "tool_use",
							id: block.id,
							name: sanitizeToolName(block.name),
							input: block.input,
						});
					} else if (block.type === "text" && block.text) {
						content.push({
							type: "text",
							text: block.text,
						});
					}
				}
				result.push({
					role: "assistant",
					content: content.length > 0 ? content : [{ type: "text", text: "" }],
				});
			} else if (msg.role === "tool_result") {
				// Convert tool_result to user message with tool_result block.
				// Merge consecutive tool_result messages into a single user message —
				// Anthropic requires ALL tool_result blocks for a multi-tool response to be
				// in one user message.
				type ToolResultItem =
					| { type: "text"; text: string }
					| { type: "image"; source: { type: "base64"; media_type: string; data: string } };
				const toolResultContent: ToolResultItem[] = [];
				const textContent = extractTextFromBlocks(msg.content);
				if (textContent) {
					toolResultContent.push({ type: "text" as const, text: textContent });
				}
				// Preserve image blocks from tool results (e.g. MCP tools returning screenshots)
				if (Array.isArray(msg.content)) {
					for (const block of msg.content) {
						if (block.type === "image" && block.source?.type === "base64") {
							toolResultContent.push({
								type: "image" as const,
								source: {
									type: "base64" as const,
									media_type: correctMediaType(block.source.data, block.source.media_type),
									data: block.source.data,
								},
							});
						}
					}
				}
				if (toolResultContent.length === 0) {
					toolResultContent.push({ type: "text" as const, text: "" });
				}
				const toolResultBlock = {
					type: "tool_result" as const,
					tool_use_id: msg.tool_use_id,
					content: toolResultContent,
				};
				const lastMsg = result.at(-1);
				if (lastMsg?.role === "user" && lastMsg.content.some((b) => b.type === "tool_result")) {
					lastMsg.content.push(toolResultBlock);
				} else {
					result.push({
						role: "user",
						content: [toolResultBlock],
					});
				}
			} else {
				// Regular message — preserve text, image, and document blocks
				const content: AnthropicContentBlock[] = [];

				// Prepend developer context if this is a user message
				if (msg.role === "user" && pendingDeveloperContent.length > 0) {
					const contextText = pendingDeveloperContent.join("\n");
					content.push({ type: "text", text: contextText });
					pendingDeveloperContent.length = 0;
				}

				for (const block of msg.content) {
					if (block.type === "text" && block.text) {
						content.push({ type: "text", text: block.text });
					} else if (block.type === "image" && block.source) {
						const src = block.source;
						if (src.type === "base64") {
							content.push({
								type: "image",
								source: {
									type: "base64",
									media_type: correctMediaType(src.data, src.media_type),
									data: src.data,
								},
							});
						}
					}
				}
				if (content.length === 0) {
					content.push({ type: "text", text: "" });
				}
				result.push({
					role: msg.role as "user" | "assistant",
					content,
				});
			}
		} else {
			// Handle string content
			if (msg.role === "tool_call") {
				// DB stores tool_call content as JSON string — try parsing it
				try {
					const parsed = JSON.parse(msg.content);
					if (Array.isArray(parsed)) {
						const content: AnthropicMessage["content"] = [];
						for (const block of parsed) {
							if (block.type === "thinking") {
								const thinkingBlock: AnthropicContentBlock = {
									type: "thinking",
									thinking: block.thinking,
								};
								if (block.signature) thinkingBlock.signature = block.signature;
								content.push(thinkingBlock);
							} else if (block.type === "tool_use") {
								content.push({
									type: "tool_use",
									id: block.id,
									name: sanitizeToolName(block.name),
									input: block.input,
								});
							}
						}
						result.push({ role: "assistant", content });
					} else {
						result.push({ role: "assistant", content: [{ type: "text", text: msg.content }] });
					}
				} catch {
					result.push({ role: "assistant", content: [{ type: "text", text: msg.content }] });
				}
			} else if (msg.role === "tool_result") {
				// Merge consecutive tool_result messages into a single user message.
				const toolResultBlock = {
					type: "tool_result" as const,
					tool_use_id: msg.tool_use_id,
					content: [{ type: "text" as const, text: msg.content }],
				};
				const lastMsg = result.at(-1);
				if (lastMsg?.role === "user" && lastMsg.content.some((b) => b.type === "tool_result")) {
					lastMsg.content.push(toolResultBlock);
				} else {
					result.push({
						role: "user",
						content: [toolResultBlock],
					});
				}
			} else {
				// User or assistant message — prepend developer context if user message
				const content: AnthropicContentBlock[] = [];

				if (msg.role === "user" && pendingDeveloperContent.length > 0) {
					const contextText = pendingDeveloperContent.join("\n");
					content.push({ type: "text", text: contextText });
					pendingDeveloperContent.length = 0;
				}

				content.push({ type: "text", text: msg.content });
				result.push({
					role: msg.role as "user" | "assistant",
					content,
				});
			}
		}
	}

	// After loop: if there's still pending developer content, create a user message for it
	if (pendingDeveloperContent.length > 0) {
		const contextText = pendingDeveloperContent.join("\n");
		result.push({
			role: "user",
			content: [{ type: "text", text: contextText }],
		});
	}

	return result;
}

async function* parseAnthropicStream(
	response: Response,
	params: ChatParams,
): AsyncIterable<StreamChunk> {
	let currentToolId = "";
	let currentToolArgs = "";
	let inputTokens = 0;
	let outputTokens = 0;
	let cacheWriteTokens: number | null = null;
	let cacheReadTokens: number | null = null;
	let outputText = "";

	for await (const line of parseStreamLines(response, "anthropic")) {
		if (!line.startsWith(SSE_DATA_PREFIX)) {
			continue;
		}

		const eventData = line.slice(SSE_DATA_PREFIX.length);
		if (eventData === SSE_DONE_SENTINEL) {
			continue;
		}

		let event: AnthropicStreamEvent;
		try {
			event = JSON.parse(eventData);
		} catch {
			yield {
				type: "error",
				error: `Failed to parse SSE event: ${eventData}`,
			};
			continue;
		}

		// Handle message_start with input tokens and cache fields
		if (event.type === "message_start" && event.message?.usage) {
			const usage = event.message.usage;
			inputTokens = usage.input_tokens || 0;
			const cw = usage.cache_creation_input_tokens;
			const cr = usage.cache_read_input_tokens;
			if (typeof cw === "number") cacheWriteTokens = cw;
			if (typeof cr === "number") cacheReadTokens = cr;
		}

		// Reset tool state on new tool_use block
		if (event.type === "content_block_start" && event.content_block?.type === "tool_use") {
			currentToolId = "";
			currentToolArgs = "";
		}

		// Handle thinking deltas
		if (event.type === "content_block_delta" && event.delta?.type === "thinking_delta") {
			const thinking = (event.delta as Record<string, unknown>).thinking as string | undefined;
			if (thinking) {
				yield { type: "thinking", content: thinking };
			}
		}

		// Handle signature deltas (arrives just before content_block_stop for thinking blocks)
		if (event.type === "content_block_delta" && event.delta?.type === "signature_delta") {
			const signature = (event.delta as Record<string, unknown>).signature as string | undefined;
			if (signature) {
				yield { type: "thinking", content: "", signature };
			}
		}

		// Handle text deltas
		if (event.type === "content_block_delta" && event.delta?.type === "text_delta") {
			const text = event.delta.text || "";
			outputText += text;
			yield {
				type: "text",
				content: text,
			};
		}

		// Handle tool_use input_json_delta
		if (event.type === "content_block_delta" && event.delta?.type === "input_json_delta") {
			const delta = event.delta as AnthropicStreamDelta;

			if (delta.partial_json) {
				currentToolArgs += delta.partial_json;
			}
		}

		// Handle tool_use block start
		if (event.type === "content_block_start" && event.content_block?.type === "tool_use") {
			const block = event.content_block as AnthropicToolUseBlock;
			if (block.id) {
				currentToolId = block.id;
				currentToolArgs = "";
				yield {
					type: "tool_use_start",
					id: block.id,
					name: block.name || "",
				};
			}
		}

		// Handle tool_use block stop
		if (event.type === "content_block_stop" && currentToolId) {
			if (currentToolArgs) {
				yield {
					type: "tool_use_args",
					id: currentToolId,
					partial_json: currentToolArgs,
				};
			}
			yield {
				type: "tool_use_end",
				id: currentToolId,
			};
			currentToolId = "";
			currentToolArgs = "";
		}

		// Handle message_delta with output tokens
		if (event.type === "message_delta" && event.usage?.output_tokens) {
			outputTokens = event.usage.output_tokens;
		}

		// Handle message_stop with final usage
		if (event.type === "message_stop") {
			// Zero-usage guard: if tokens are zero but there is output, estimate from char counts
			let estimated = false;
			if (inputTokens === 0 && outputTokens === 0 && outputText.length > 0) {
				inputTokens = Math.ceil(
					params.messages.reduce(
						(sum, m) =>
							sum +
							(typeof m.content === "string" ? m.content.length : JSON.stringify(m.content).length),
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
}

export class AnthropicDriver implements LLMBackend {
	private apiKey: string;
	private model: string;
	private contextWindow: number;

	constructor(config: {
		apiKey: string;
		model: string;
		contextWindow: number;
	}) {
		this.apiKey = config.apiKey;
		this.model = config.model;
		this.contextWindow = config.contextWindow;
	}

	async *chat(params: ChatParams): AsyncIterable<StreamChunk> {
		const anthropicMessages = toAnthropicMessages(params.messages);

		// When cache messages are present, send system prompt as cacheable content block.
		const hasCacheMessages = params.messages.some((m) => m.role === "cache");
		const systemPayload:
			| string
			| Array<{ type: "text"; text: string; cache_control?: { type: "ephemeral" } }>
			| undefined =
			params.system && hasCacheMessages
				? [
						{
							type: "text" as const,
							text: params.system,
							cache_control: { type: "ephemeral" as const },
						},
					]
				: params.system;

		const request: AnthropicRequest & {
			thinking?:
				| { type: "enabled"; budget_tokens: number }
				| { type: "adaptive"; display?: "omitted" | "summarized" };
			output_config?: { effort: "low" | "medium" | "high" | "xhigh" | "max" };
		} = {
			model: params.model || this.model,
			max_tokens: params.max_tokens || 4096,
			system: systemPayload,
			messages: anthropicMessages,
			// Temperature is incompatible with any thinking mode on Claude's
			// native API — legacy thinking rejected it, and Opus 4.7 removed
			// sampling params entirely. Drop temperature whenever thinking
			// is set.
			temperature: params.thinking ? undefined : params.temperature,
		};

		// Forward thinking config verbatim — both legacy (enabled) and
		// adaptive shapes pass straight through to /v1/messages.
		if (params.thinking) {
			request.thinking = params.thinking;
		}

		// `effort` is a top-level output_config knob on the Claude API —
		// the depth lever that replaces `budget_tokens` on Opus 4.7 and is
		// the recommended pairing with adaptive thinking on Opus 4.6.
		if (params.effort) {
			request.output_config = { effort: params.effort };
		}

		if (params.tools && params.tools.length > 0) {
			request.tools = params.tools.map((tool) => ({
				name: tool.function.name,
				description: tool.function.description,
				input_schema: tool.function.parameters,
			}));

			// Add cache_control to last tool when cache messages are present
			if (hasCacheMessages && request.tools.length > 0) {
				const lastTool = request.tools[request.tools.length - 1];
				(lastTool as Record<string, unknown>).cache_control = { type: "ephemeral" };
			}
		}

		const endpoint = "https://api.anthropic.com/v1/messages";

		const headers: Record<string, string> = {
			"x-api-key": this.apiKey,
			"anthropic-version": "2023-06-01",
			"content-type": "application/json",
		};
		if (hasCacheMessages) {
			headers["anthropic-beta"] = "prompt-caching-2024-07-31";
		}

		const response = await withRetry(async () => {
			let res: Response;
			try {
				res = await fetch(endpoint, {
					method: "POST",
					headers,
					body: JSON.stringify({
						...request,
						stream: true,
					}),
					signal: params.signal,
				});
			} catch (error) {
				throw wrapFetchError(error, "anthropic", endpoint);
			}

			await checkHttpError(res, "anthropic");

			return res;
		});

		yield* parseAnthropicStream(response, params);
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
