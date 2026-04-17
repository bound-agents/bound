import { checkHttpError, wrapFetchError } from "./error-utils";
import { withRetry } from "./retry";
import {
	SSE_DATA_PREFIX,
	SSE_DONE_SENTINEL,
	extractTextFromBlocks,
	parseStreamLines,
} from "./stream-utils";
import type { BackendCapabilities, ChatParams, LLMBackend, LLMMessage, StreamChunk } from "./types";

type OpenAIContentPart =
	| { type: "text"; text: string }
	| { type: "image_url"; image_url: { url: string; detail?: "auto" | "low" | "high" } };

interface OpenAIMessage {
	role: "user" | "assistant" | "tool" | "system";
	content: string | OpenAIContentPart[] | null;
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

export function toOpenAIMessages(messages: LLMMessage[]): OpenAIMessage[] {
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
					// Many OpenAI-compatible providers (e.g. GLM/ZAI) reject content: "" on
					// tool-call-only assistant messages — must be null.
					content: textContent || null,
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
				// Regular message — preserve images as OpenAI vision content parts
				const hasImages = msg.content.some((b) => b.type === "image");
				if (hasImages) {
					const parts: OpenAIContentPart[] = [];
					for (const block of msg.content) {
						if (block.type === "text" && block.text) {
							parts.push({ type: "text", text: block.text });
						} else if (block.type === "image" && block.source) {
							const src = block.source;
							if (src.type === "base64") {
								parts.push({
									type: "image_url",
									image_url: {
										url: `data:${src.media_type};base64,${src.data}`,
									},
								});
							}
						}
					}
					result.push({
						role: msg.role as "user" | "assistant" | "system",
						content: parts.length > 0 ? parts : extractTextFromBlocks(msg.content),
					});
				} else {
					const textContent = extractTextFromBlocks(msg.content);
					result.push({
						role: msg.role as "user" | "assistant" | "system",
						content: textContent,
					});
				}
			}
		} else {
			// Handle string content
			if (msg.role === "tool_call") {
				// DB stores tool_call content as JSON string of ContentBlocks — try parsing
				let toolCalls:
					| Array<{ id: string; type: "function"; function: { name: string; arguments: string } }>
					| undefined;
				let textContent = msg.content;
				try {
					const parsed = JSON.parse(msg.content);
					if (Array.isArray(parsed)) {
						const toolUseBlocks = parsed.filter(
							(b: Record<string, unknown>) => b.type === "tool_use",
						);
						if (toolUseBlocks.length > 0) {
							toolCalls = toolUseBlocks.map(
								(b: { id?: string; name?: string; input?: unknown }) => ({
									id: b.id ?? "",
									type: "function" as const,
									function: {
										name: b.name ?? "",
										arguments: JSON.stringify(b.input ?? {}),
									},
								}),
							);
							textContent = "";
						}
					}
				} catch {
					// Not JSON — use as plain content
				}
				result.push({
					role: "assistant",
					content: textContent || null,
					tool_calls: toolCalls,
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

	// Convert ALL system messages to user messages. The real system prompt is
	// injected separately by chat() via params.system. Any system-role messages
	// in the conversation array are injected notes (task wakeup, quiescence,
	// truncation markers, etc.). Many OpenAI-compatible providers (e.g. GLM/ZAI)
	// only accept a single system message at position 0, so leaving these as
	// system role causes "illegal messages" errors when chat() prepends the
	// real system prompt.
	for (const msg of result) {
		if (msg.role === "system") {
			msg.role = "user";
			msg.content = `<system-note>${typeof msg.content === "string" ? msg.content : ""}</system-note>`;
		}
	}

	return result;
}

async function* parseOpenAIStream(
	response: Response,
	params: ChatParams,
): AsyncIterable<StreamChunk> {
	const toolStates = new Map<number, { id: string; name: string; args: string }>();
	let capturedUsage: OpenAIStreamEvent["usage"] = null;
	let outputText = "";
	const turnTs = Date.now();
	let toolCallIndex = 0;

	for await (const line of parseStreamLines(response, "openai")) {
		if (!line.startsWith(SSE_DATA_PREFIX)) {
			continue;
		}

		const eventData = line.slice(SSE_DATA_PREFIX.length);
		if (eventData === SSE_DONE_SENTINEL) {
			// Flush any remaining tool states that weren't finalized by finish_reason
			if (toolStates.size > 0) {
				for (const [, state] of toolStates) {
					yield {
						type: "tool_use_end",
						id: state.id,
					};
				}
				toolStates.clear();
			}

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

			// Handle reasoning content (OpenAI reasoning models: o1, o3, o4-mini)
			const reasoningContent = (delta as Record<string, unknown> | undefined)?.reasoning_content as
				| string
				| undefined;
			if (reasoningContent) {
				yield { type: "thinking", content: reasoningContent };
			}

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

					// Emit tool_use_start if this is the first chunk for this tool
					if (!toolStates.has(toolIndex)) {
						// Use provider-supplied ID if present and non-empty; otherwise synthesize
						const providedId = toolCall.id;
						const toolId = providedId ? providedId : `openai-${turnTs}-${toolCallIndex++}`;

						const state = { id: toolId, name: "", args: "" };
						if (toolCall.function?.name) {
							state.name = toolCall.function.name;
							yield {
								type: "tool_use_start",
								id: toolId,
								name: toolCall.function.name,
							};
						}
						toolStates.set(toolIndex, state);
					}

					const state = toolStates.get(toolIndex);
					if (!state) continue;

					// Accumulate arguments
					if (toolCall.function?.arguments) {
						state.args += toolCall.function.arguments;
						yield {
							type: "tool_use_args",
							id: state.id,
							partial_json: toolCall.function.arguments,
						};
					}
				}
			}

			// Finalize tool calls when finish_reason indicates completion.
			// This must be OUTSIDE the delta?.tool_calls block because many providers
			// send finish_reason on a separate chunk with no delta content.
			if (
				(choice.finish_reason === "tool_calls" || choice.finish_reason === "stop") &&
				toolStates.size > 0
			) {
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

		// Prepend system prompt as a system message (OpenAI format uses messages array, not a top-level field)
		if (params.system) {
			openaiMessages.unshift({ role: "system", content: params.system });
		}

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
			extended_thinking: true,
			max_context: this.contextWindow,
		};
	}
}
