import type { BackendCapabilities, ChatParams, LLMBackend, LLMMessage, StreamChunk } from "./types";
import { LLMError } from "./types";

interface OllamaMessage {
	role: "system" | "user" | "assistant" | "tool";
	content: string;
	tool_calls?: Array<{
		function: {
			name: string;
			arguments: string;
		};
	}>;
	tool_name?: string;
	tool_use_id?: string;
}

interface OllamaRequest {
	model: string;
	messages: OllamaMessage[];
	stream: boolean;
	system?: string;
	temperature?: number;
	num_predict?: number;
}

interface OllamaStreamResponse {
	model: string;
	created_at: string;
	message: {
		role: "assistant" | "tool";
		content: string;
		tool_calls?: Array<{
			function: {
				name: string;
				arguments: string;
			};
		}>;
		tool_name?: string;
	};
	done: boolean;
	prompt_eval_count?: number;
	eval_count?: number;
	total_duration?: number;
	load_duration?: number;
	prompt_eval_duration?: number;
	eval_duration?: number;
}

function toOllamaMessages(messages: LLMMessage[]): OllamaMessage[] {
	return messages.map((msg) => {
		// Handle array content blocks
		if (Array.isArray(msg.content)) {
			const textContent = msg.content
				.filter((block) => block.type === "text")
				.map((block) => block.text || "")
				.join("\n");

			if (msg.role === "tool_call") {
				const toolBlocks = msg.content.filter((block) => block.type === "tool_use");
				if (toolBlocks.length > 0) {
					const toolCalls = toolBlocks.map((block) => ({
						function: {
							name: block.name || "",
							arguments: JSON.stringify(block.input || {}),
						},
					}));
					return {
						role: "assistant",
						content: textContent,
						tool_calls: toolCalls,
					};
				}
			}

			return {
				role:
					msg.role === "tool_result"
						? "tool"
						: msg.role === "tool_call"
							? "assistant"
							: (msg.role as "system" | "user" | "assistant"),
				content: textContent,
				tool_name: msg.role === "tool_result" ? msg.tool_use_id : undefined,
			};
		}

		// Handle string content
		if (msg.role === "tool_call") {
			return {
				role: "assistant",
				content: msg.content,
			};
		}

		if (msg.role === "tool_result") {
			return {
				role: "tool",
				content: msg.content,
				tool_name: msg.tool_use_id,
			};
		}

		return {
			role: msg.role as "system" | "user" | "assistant",
			content: msg.content,
		};
	});
}

async function* parseOllamaStream(response: Response): AsyncIterable<StreamChunk> {
	const reader = response.body?.getReader();
	if (!reader) {
		throw new LLMError("Response body not available", "ollama");
	}

	const decoder = new TextDecoder();
	let buffer = "";

	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;

			buffer += decoder.decode(value, { stream: true });
			const lines = buffer.split("\n");
			buffer = lines.pop() || "";

			for (const line of lines) {
				if (!line.trim()) continue;

				let chunk: OllamaStreamResponse;
				try {
					chunk = JSON.parse(line);
				} catch {
					yield {
						type: "error",
						error: `Failed to parse NDJSON: ${line}`,
					};
					continue;
				}

				// Emit text content if present
				if (chunk.message.content?.trim?.()) {
					yield {
						type: "text",
						content: chunk.message.content,
					};
				}

				// Emit tool calls
				if (chunk.message.tool_calls && chunk.message.tool_calls.length > 0) {
					for (const toolCall of chunk.message.tool_calls) {
						yield {
							type: "tool_use_start",
							id: toolCall.function.name,
							name: toolCall.function.name,
						};

						yield {
							type: "tool_use_args",
							id: toolCall.function.name,
							partial_json: toolCall.function.arguments,
						};

						yield {
							type: "tool_use_end",
							id: toolCall.function.name,
						};
					}
				}

				// Emit done when stream finishes
				if (chunk.done) {
					yield {
						type: "done",
						usage: {
							input_tokens: chunk.prompt_eval_count || 0,
							output_tokens: chunk.eval_count || 0,
						},
					};
				}
			}
		}

		// Handle any remaining buffer
		if (buffer.trim()) {
			let chunk: OllamaStreamResponse;
			try {
				chunk = JSON.parse(buffer);
				if (chunk.message.content?.trim?.()) {
					yield {
						type: "text",
						content: chunk.message.content,
					};
				}
				if (chunk.message.tool_calls && chunk.message.tool_calls.length > 0) {
					for (const toolCall of chunk.message.tool_calls) {
						yield {
							type: "tool_use_start",
							id: toolCall.function.name,
							name: toolCall.function.name,
						};

						yield {
							type: "tool_use_args",
							id: toolCall.function.name,
							partial_json: toolCall.function.arguments,
						};

						yield {
							type: "tool_use_end",
							id: toolCall.function.name,
						};
					}
				}
				if (chunk.done) {
					yield {
						type: "done",
						usage: {
							input_tokens: chunk.prompt_eval_count || 0,
							output_tokens: chunk.eval_count || 0,
						},
					};
				}
			} catch {
				yield {
					type: "error",
					error: `Failed to parse final NDJSON chunk: ${buffer}`,
				};
			}
		}
	} finally {
		reader.releaseLock();
	}
}

export class OllamaDriver implements LLMBackend {
	private baseUrl: string;
	private model: string;
	private contextWindow: number;

	constructor(config: {
		baseUrl: string;
		model: string;
		contextWindow: number;
	}) {
		this.baseUrl = config.baseUrl;
		this.model = config.model;
		this.contextWindow = config.contextWindow;
	}

	async *chat(params: ChatParams): AsyncIterable<StreamChunk> {
		const ollamaMessages = toOllamaMessages(params.messages);

		const request: OllamaRequest = {
			model: params.model || this.model,
			messages: ollamaMessages,
			stream: true,
			system: params.system,
			temperature: params.temperature,
			num_predict: params.max_tokens,
		};

		let response: Response;
		try {
			response = await fetch(`${this.baseUrl}/api/chat`, {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
				},
				body: JSON.stringify(request),
			});
		} catch (error) {
			throw new LLMError(
				`Failed to connect to Ollama at ${this.baseUrl}: ${
					error instanceof Error ? error.message : String(error)
				}`,
				"ollama",
				undefined,
				error instanceof Error ? error : new Error(String(error)),
			);
		}

		if (!response.ok) {
			const body = await response.text();
			throw new LLMError(
				`Ollama request failed with status ${response.status}: ${body}`,
				"ollama",
				response.status,
			);
		}

		yield* parseOllamaStream(response);
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
