import { checkHttpError, wrapFetchError } from "./error-utils";
import { withRetry } from "./retry";
import { extractTextFromBlocks, parseStreamLines } from "./stream-utils";
import type { BackendCapabilities, ChatParams, LLMBackend, LLMMessage, StreamChunk } from "./types";

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
	tools?: Array<{
		type: string;
		function: {
			name: string;
			description?: string;
			parameters?: Record<string, unknown>;
		};
	}>;
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
			const textContent = extractTextFromBlocks(msg.content);

			if (msg.role === "tool_call") {
				const toolBlocks = msg.content.filter(
					(block): block is Extract<typeof block, { type: "tool_use" }> =>
						block.type === "tool_use",
				);
				if (toolBlocks.length > 0) {
					const toolCalls = toolBlocks.map((block) => ({
						function: {
							name: block.name,
							arguments: JSON.stringify(block.input),
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

function* emitChunkEvents(chunk: OllamaStreamResponse): IterableIterator<StreamChunk> {
	// Emit text content if present (check for undefined/empty, but keep whitespace)
	if (chunk.message.content !== undefined && chunk.message.content !== "") {
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

async function* parseOllamaStream(response: Response): AsyncIterable<StreamChunk> {
	for await (const line of parseStreamLines(response, "ollama")) {
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

		yield* emitChunkEvents(chunk);
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
			tools: params.tools,
		};

		const endpoint = `${this.baseUrl}/api/chat`;

		const response = await withRetry(async () => {
			let res: Response;
			try {
				res = await fetch(endpoint, {
					method: "POST",
					headers: {
						"Content-Type": "application/json",
					},
					body: JSON.stringify(request),
				});
			} catch (error) {
				throw wrapFetchError(error, "ollama", endpoint);
			}

			await checkHttpError(res, "ollama");

			return res;
		});

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
