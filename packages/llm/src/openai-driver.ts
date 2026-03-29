import { checkHttpError, wrapFetchError } from "./error-utils";
import { withRetry } from "./retry";
import {
	SSE_DATA_PREFIX,
	SSE_DONE_SENTINEL,
	extractTextFromBlocks,
	parseStreamLines,
} from "./stream-utils";
import type { BackendCapabilities, ChatParams, LLMBackend, LLMMessage, StreamChunk } from "./types";

interface OpenAIMessage {
	role: "user" | "assistant" | "tool" | "system";
	content: string;
	tool_calls?: Array<{
		id: string;
		type: "function";
		function: {
			name: string;
			arguments: string;
		};
	}>;
	tool_call_id?: string;
}

interface OpenAIRequest {
	model: string;
	messages: OpenAIMessage[];
	stream: boolean;
	stream_options?: { include_usage: boolean };
	temperature?: number;
	max_tokens?: number;
	tools?: Array<{
		type: "function";
		function: {
			name: string;
			description?: string;
			parameters: Record<string, unknown>;
		};
	}>;
}

interface OpenAIStreamEvent {
	choices?: Array<{
		delta?: {
			content?: string;
			tool_calls?: Array<{
				index: number;
				id: string;
				type: "function";
				function?: {
					name: string;
					arguments?: string;
				};
			}>;
		};
		finish_reason?: string;
	}>;
	usage?: {
		prompt_tokens?: number;
		completion_tokens?: number;
		prompt_tokens_details?: {
			cached_tokens?: number;
		};
	} | null;
}

function toOpenAIMessages(messages: LLMMessage[]): OpenAIMessage[] {
	const result: OpenAIMessage[] = [];

	for (const msg of messages) {
		// Handle array content blocks
		if (Array.isArray(msg.content)) {
			if (msg.role === "tool_call") {
				// Convert tool_call to assistant message with tool_calls
				const textContent = extractTextFromBlocks(msg.content);

				const toolUseBlocks = msg.content.filter(
					(block): block is Extract<typeof block, { type: "tool_use" }> =>
						block.type === "tool_use",
				);
				const toolCalls = toolUseBlocks.map((block) => ({
					id: block.id,
					type: "function" as const,
					function: {
						name: block.name,
						arguments: JSON.stringify(block.input),
					},
				}));

				result.push({
					role: "assistant",
					content: textContent,
					tool_calls: toolCalls.length > 0 ? toolCalls : undefined,
				});
			} else if (msg.role === "tool_result") {
				// Convert tool_result to tool message
				const textContent = extractTextFromBlocks(msg.content);

				result.push({
					role: "tool",
					content: textContent,
					tool_call_id: msg.tool_use_id,
				});
			} else {
				// Regular message with text content
				const textContent = extractTextFromBlocks(msg.content);

				result.push({
					role: msg.role as "user" | "assistant" | "system",
					content: textContent,
				});
			}
		} else {
			// Handle string content
			if (msg.role === "tool_call") {
				result.push({
					role: "assistant",
					content: msg.content,
				});
			} else if (msg.role === "tool_result") {
				result.push({
					role: "tool",
					content: msg.content,
					tool_call_id: msg.tool_use_id,
				});
			} else {
				result.push({
					role: msg.role as "user" | "assistant" | "system",
					content: msg.content,
				});
			}
		}
	}

	return result;
}

async function* parseOpenAIStream(response: Response, params: ChatParams): AsyncIterable<StreamChunk> {
	const toolStates = new Map<number, { id: string; name: string; args: string }>();
	let capturedUsage: OpenAIStreamEvent["usage"] = null;
	let outputText = "";

	for await (const line of parseStreamLines(response, "openai")) {
		if (!line.startsWith(SSE_DATA_PREFIX)) {
			continue;
		}

		const eventData = line.slice(SSE_DATA_PREFIX.length);
		if (eventData === SSE_DONE_SENTINEL) {
			// Emit done event when stream finishes
			const promptTokens = capturedUsage?.prompt_tokens ?? 0;
			const completionTokens = capturedUsage?.completion_tokens ?? 0;
			const cachedTokens = capturedUsage?.prompt_tokens_details?.cached_tokens ?? null;

			// Zero-usage guard
			let inputTokens = promptTokens;
			let outputTokens = completionTokens;
			let estimated = false;
			if (inputTokens === 0 && outputTokens === 0 && outputText.length > 0) {
				inputTokens = Math.ceil(
					params.messages.reduce((sum, m) => sum + (typeof m.content === "string" ? m.content.length : JSON.stringify(m.content).length), 0) / 4,
				);
				outputTokens = Math.ceil(outputText.length / 4);
				estimated = true;
			}

			yield {
				type: "done",
				usage: {
					input_tokens: inputTokens,
					output_tokens: outputTokens,
					cache_write_tokens: null,
					cache_read_tokens: typeof cachedTokens === "number" ? cachedTokens : null,
					estimated,
				},
			};
			continue;
		}

		let event: OpenAIStreamEvent;
		try {
			event = JSON.parse(eventData);
		} catch {
			yield {
				type: "error",
				error: `Failed to parse SSE event: ${eventData}`,
			};
			continue;
		}

		// Capture usage from final usage chunk (comes before [DONE] when stream_options.include_usage is true)
		if (event.usage !== undefined) {
			capturedUsage = event.usage;
		}

		if (event.choices && event.choices.length > 0) {
			const choice = event.choices[0];
			const delta = choice.delta;

			// Handle text content
			if (delta?.content) {
				outputText += delta.content;
				yield {
					type: "text",
					content: delta.content,
				};
			}

			// Handle tool calls
			if (delta?.tool_calls) {
				for (const toolCall of delta.tool_calls) {
					const toolIndex = toolCall.index;
					const state = toolStates.get(toolIndex) || {
						id: toolCall.id,
						name: "",
						args: "",
					};

					// Emit tool_use_start if this is the first chunk for this tool
					if (!toolStates.has(toolIndex)) {
						if (toolCall.function?.name) {
							state.name = toolCall.function.name;
							yield {
								type: "tool_use_start",
								id: toolCall.id,
								name: toolCall.function.name,
							};
						}
					}

					// Accumulate arguments
					if (toolCall.function?.arguments) {
						state.args += toolCall.function.arguments;
						yield {
							type: "tool_use_args",
							id: toolCall.id,
							partial_json: toolCall.function.arguments,
						};
					}

					toolStates.set(toolIndex, state);

					// Emit tool_use_end if stream is finishing this tool
					if (choice.finish_reason === "tool_calls" || choice.finish_reason === "stop") {
						// Check if all tool calls are done
						const allDone = Array.from(toolStates.values()).every((s) => s.args !== "");
						if (allDone && toolIndex === toolStates.size - 1) {
							for (const [, state] of toolStates) {
								yield {
									type: "tool_use_end",
									id: state.id,
								};
							}
							toolStates.clear();
						}
					}
				}
			}
		}
	}
}

export class OpenAICompatibleDriver implements LLMBackend {
	private baseUrl: string;
	private apiKey: string;
	private model: string;
	private contextWindow: number;

	constructor(config: {
		baseUrl: string;
		apiKey: string;
		model: string;
		contextWindow: number;
	}) {
		this.baseUrl = config.baseUrl;
		this.apiKey = config.apiKey;
		this.model = config.model;
		this.contextWindow = config.contextWindow;
	}

	async *chat(params: ChatParams): AsyncIterable<StreamChunk> {
		const openaiMessages = toOpenAIMessages(params.messages);

		const request: OpenAIRequest = {
			model: params.model || this.model,
			messages: openaiMessages,
			stream: true,
			stream_options: { include_usage: true },
			temperature: params.temperature,
			max_tokens: params.max_tokens,
		};

		if (params.tools && params.tools.length > 0) {
			request.tools = params.tools;
		}

		const endpoint = `${this.baseUrl}/chat/completions`;

		const response = await withRetry(async () => {
			let res: Response;
			try {
				res = await fetch(endpoint, {
					method: "POST",
					headers: {
						"Content-Type": "application/json",
						Authorization: `Bearer ${this.apiKey}`,
					},
					body: JSON.stringify(request),
					signal: params.signal,
				});
			} catch (error) {
				throw wrapFetchError(error, "openai", endpoint);
			}

			await checkHttpError(res, "openai");

			return res;
		});

		yield* parseOpenAIStream(response, params);
	}

	capabilities(): BackendCapabilities {
		return {
			streaming: true,
			tool_use: true,
			system_prompt: true,
			prompt_caching: false,
			vision: false,
			max_context: this.contextWindow,
		};
	}
}
