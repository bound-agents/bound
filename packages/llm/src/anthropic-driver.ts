import { checkHttpError, wrapFetchError } from "./error-utils";
import { withRetry } from "./retry";
import {
	SSE_DATA_PREFIX,
	SSE_DONE_SENTINEL,
	extractTextFromBlocks,
	parseStreamLines,
} from "./stream-utils";
import type { BackendCapabilities, ChatParams, LLMBackend, LLMMessage, StreamChunk } from "./types";

interface AnthropicMessage {
	role: "user" | "assistant";
	content: Array<{
		type: "text" | "tool_use" | "tool_result";
		text?: string;
		id?: string;
		name?: string;
		input?: Record<string, unknown>;
		tool_use_id?: string;
		content?: Array<{ type: "text"; text: string }>;
	}>;
	cache_control?: { type: "ephemeral" };
}

interface AnthropicRequest {
	model: string;
	max_tokens: number;
	system?: string;
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

interface AnthropicStreamEvent {
	type: AnthropicEventType;
	index?: number;
	content_block?: { type: string };
	delta?: {
		type: string;
		text?: string;
		stop_reason?: string;
	};
	usage?: {
		input_tokens?: number;
		output_tokens?: number;
	};
	message?: {
		usage?: {
			input_tokens: number;
			output_tokens: number;
		};
	};
}

function toAnthropicMessages(messages: LLMMessage[]): AnthropicMessage[] {
	const result: AnthropicMessage[] = [];

	for (const msg of messages) {
		// Handle array content blocks
		if (Array.isArray(msg.content)) {
			if (msg.role === "tool_call") {
				// Convert tool_call to assistant message with tool_use blocks
				const content: AnthropicMessage["content"] = [];
				for (const block of msg.content) {
					if (block.type === "tool_use") {
						content.push({
							type: "tool_use",
							id: block.id,
							name: block.name,
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
				// Convert tool_result to user message with tool_result block
				const textContent = extractTextFromBlocks(msg.content);

				result.push({
					role: "user",
					content: [
						{
							type: "tool_result",
							tool_use_id: msg.tool_use_id,
							content: [{ type: "text", text: textContent }],
						},
					],
				});
			} else {
				// Regular message with text content
				const textContent = extractTextFromBlocks(msg.content);

				result.push({
					role: msg.role as "user" | "assistant",
					content: [{ type: "text", text: textContent }],
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
							if (block.type === "tool_use") {
								content.push({
									type: "tool_use",
									id: block.id,
									name: block.name,
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
				result.push({
					role: "user",
					content: [
						{
							type: "tool_result",
							tool_use_id: msg.tool_use_id,
							content: [{ type: "text", text: msg.content }],
						},
					],
				});
			} else {
				result.push({
					role: msg.role as "user" | "assistant",
					content: [{ type: "text", text: msg.content }],
				});
			}
		}
	}

	return result;
}

async function* parseAnthropicStream(response: Response): AsyncIterable<StreamChunk> {
	let currentToolId = "";
	let currentToolArgs = "";
	let inputTokens = 0;
	let outputTokens = 0;

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

		// Handle message_start with input tokens
		if (event.type === "message_start" && event.message?.usage?.input_tokens) {
			inputTokens = event.message.usage.input_tokens;
		}

		// Handle content_block_start for tool_use
		if (event.type === "content_block_start" && event.content_block?.type === "tool_use") {
			// Prepare for tool_use streaming
			currentToolId = "";
			currentToolArgs = "";
		}

		// Handle text deltas
		if (event.type === "content_block_delta" && event.delta?.type === "text_delta") {
			yield {
				type: "text",
				content: event.delta.text || "",
			};
		}

		// Handle tool_use input_json_delta
		if (event.type === "content_block_delta" && event.delta?.type === "input_json_delta") {
			// biome-ignore lint/suspicious/noExplicitAny: Anthropic API returns untyped delta with partial_json property
			const delta = event.delta as any;

			if (delta.partial_json) {
				currentToolArgs += delta.partial_json;
			}
		}

		// Handle tool_use block start
		if (event.type === "content_block_start" && event.content_block?.type === "tool_use") {
			// biome-ignore lint/suspicious/noExplicitAny: Anthropic API returns untyped content_block with id and name properties
			const block = event.content_block as any;
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
			yield {
				type: "done",
				usage: {
					input_tokens: inputTokens,
					output_tokens: outputTokens,
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

		// Add cache_control to messages at breakpoint indices
		if (params.cache_breakpoints) {
			for (const breakpointIndex of params.cache_breakpoints) {
				if (anthropicMessages[breakpointIndex]) {
					anthropicMessages[breakpointIndex].cache_control = { type: "ephemeral" };
				}
			}
		}

		const request: AnthropicRequest = {
			model: params.model || this.model,
			max_tokens: params.max_tokens || 4096,
			system: params.system,
			messages: anthropicMessages,
			temperature: params.temperature,
		};

		if (params.tools && params.tools.length > 0) {
			request.tools = params.tools.map((tool) => ({
				name: tool.function.name,
				description: tool.function.description,
				input_schema: tool.function.parameters,
			}));
		}

		const endpoint = "https://api.anthropic.com/v1/messages";

		const response = await withRetry(async () => {
			let res: Response;
			try {
				res = await fetch(endpoint, {
					method: "POST",
					headers: {
						"x-api-key": this.apiKey,
						"anthropic-version": "2023-06-01",
						"content-type": "application/json",
					},
					body: JSON.stringify({
						...request,
						stream: true,
					}),
				});
			} catch (error) {
				throw wrapFetchError(error, "anthropic", endpoint);
			}

			await checkHttpError(res, "anthropic");

			return res;
		});

		yield* parseAnthropicStream(response);
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
