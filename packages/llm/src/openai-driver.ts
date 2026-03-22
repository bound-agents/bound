import type { BackendCapabilities, ChatParams, LLMBackend, LLMMessage, StreamChunk } from "./types";
import { LLMError } from "./types";

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
}

function toOpenAIMessages(messages: LLMMessage[]): OpenAIMessage[] {
	const result: OpenAIMessage[] = [];

	for (const msg of messages) {
		// Handle array content blocks
		if (Array.isArray(msg.content)) {
			if (msg.role === "tool_call") {
				// Convert tool_call to assistant message with tool_calls
				const textContent = msg.content
					.filter((block) => block.type === "text")
					.map((block) => block.text || "")
					.join("\n");

				const toolUseBlocks = msg.content.filter((block) => block.type === "tool_use");
				const toolCalls = toolUseBlocks.map((block) => ({
					id: block.id || "call-" + Math.random().toString(36).substr(2, 9),
					type: "function" as const,
					function: {
						name: block.name || "",
						arguments: JSON.stringify(block.input || {}),
					},
				}));

				result.push({
					role: "assistant",
					content: textContent,
					tool_calls: toolCalls.length > 0 ? toolCalls : undefined,
				});
			} else if (msg.role === "tool_result") {
				// Convert tool_result to tool message
				const textContent = msg.content
					.filter((block) => block.type === "text")
					.map((block) => block.text || "")
					.join("\n");

				result.push({
					role: "tool",
					content: textContent,
					tool_call_id: msg.tool_use_id,
				});
			} else {
				// Regular message with text content
				const textContent = msg.content
					.filter((block) => block.type === "text")
					.map((block) => block.text || "")
					.join("\n");

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

async function* parseOpenAIStream(response: Response): AsyncIterable<StreamChunk> {
	const reader = response.body?.getReader();
	if (!reader) {
		throw new LLMError("Response body not available", "openai");
	}

	const decoder = new TextDecoder();
	let buffer = "";
	const toolStates = new Map<number, { id: string; name: string; args: string }>();

	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;

			buffer += decoder.decode(value, { stream: true });
			const lines = buffer.split("\n");
			buffer = lines.pop() || "";

			for (const line of lines) {
				if (!line.trim() || !line.startsWith("data: ")) {
					continue;
				}

				const eventData = line.slice(6); // Remove "data: " prefix
				if (eventData === "[DONE]") {
					// Emit done event when stream finishes
					yield {
						type: "done",
						usage: {
							input_tokens: 0,
							output_tokens: 0,
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

				if (event.choices && event.choices.length > 0) {
					const choice = event.choices[0];
					const delta = choice.delta;

					// Handle text content
					if (delta?.content) {
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

		// Handle any remaining buffer
		if (buffer.trim() && buffer.startsWith("data: ")) {
			const eventData = buffer.slice(6);
			if (eventData === "[DONE]") {
				yield {
					type: "done",
					usage: {
						input_tokens: 0,
						output_tokens: 0,
					},
				};
			}
		}
	} finally {
		reader.releaseLock();
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
			temperature: params.temperature,
			max_tokens: params.max_tokens,
		};

		if (params.tools && params.tools.length > 0) {
			request.tools = params.tools;
		}

		const endpoint = `${this.baseUrl}/chat/completions`;

		let response: Response;
		try {
			response = await fetch(endpoint, {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					Authorization: `Bearer ${this.apiKey}`,
				},
				body: JSON.stringify(request),
			});
		} catch (error) {
			throw new LLMError(
				`Failed to connect to OpenAI-compatible API at ${endpoint}: ${
					error instanceof Error ? error.message : String(error)
				}`,
				"openai",
				undefined,
				error instanceof Error ? error : new Error(String(error)),
			);
		}

		if (!response.ok) {
			const body = await response.text();
			throw new LLMError(
				`OpenAI API request failed with status ${response.status}: ${body}`,
				"openai",
				response.status,
			);
		}

		yield* parseOpenAIStream(response);
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
