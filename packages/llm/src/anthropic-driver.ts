import type { BackendCapabilities, ChatParams, LLMBackend, LLMMessage, StreamChunk } from "./types";
import { LLMError } from "./types";

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

interface AnthropicStreamEvent {
	type: string;
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
				const textContent = msg.content
					.filter((block) => block.type === "text")
					.map((block) => block.text || "")
					.join("\n");

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
				const textContent = msg.content
					.filter((block) => block.type === "text")
					.map((block) => block.text || "")
					.join("\n");

				result.push({
					role: msg.role as "user" | "assistant",
					content: [{ type: "text", text: textContent }],
				});
			}
		} else {
			// Handle string content
			if (msg.role === "tool_call") {
				result.push({
					role: "assistant",
					content: [{ type: "text", text: msg.content }],
				});
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
	const reader = response.body?.getReader();
	if (!reader) {
		throw new LLMError("Response body not available", "anthropic");
	}

	const decoder = new TextDecoder();
	let buffer = "";
	let currentToolId = "";
	let currentToolArgs = "";

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
					// biome-ignore lint/suspicious/noExplicitAny: <explanation>
					const delta = event.delta as any;
					const toolIndex = event.index || 0;

					if (!currentToolId) {
						// Tool use starts (we need to emit start event)
						// We'll handle this when we get the tool_use_start
					}

					if (delta.partial_json) {
						currentToolArgs += delta.partial_json;
					}
				}

				// Handle tool_use block start
				if (event.type === "content_block_start" && event.content_block?.type === "tool_use") {
					// biome-ignore lint/suspicious/noExplicitAny: <explanation>
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

				// Handle message_delta with usage
				if (event.type === "message_delta" && event.usage) {
					// Don't emit here, wait for message_stop
				}

				// Handle message_stop with final usage
				if (event.type === "message_stop") {
					// The usage info should come from message_delta
					// For now, we'll emit a done event with placeholder tokens
					// In a real implementation, we'd accumulate tokens from message_delta
					yield {
						type: "done",
						usage: {
							input_tokens: 0,
							output_tokens: 0,
						},
					};
				}
			}
		}

		// Handle any remaining buffer
		if (buffer.trim() && buffer.startsWith("data: ")) {
			const eventData = buffer.slice(6);
			if (eventData !== "[DONE]") {
				try {
					const event = JSON.parse(eventData);
					if (event.type === "message_stop") {
						yield {
							type: "done",
							usage: {
								input_tokens: 0,
								output_tokens: 0,
							},
						};
					}
				} catch {
					// Ignore parse errors in final buffer
				}
			}
		}
	} finally {
		reader.releaseLock();
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

		let response: Response;
		try {
			response = await fetch("https://api.anthropic.com/v1/messages", {
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
			throw new LLMError(
				`Failed to connect to Anthropic API: ${
					error instanceof Error ? error.message : String(error)
				}`,
				"anthropic",
				undefined,
				error instanceof Error ? error : new Error(String(error)),
			);
		}

		if (!response.ok) {
			const body = await response.text();
			throw new LLMError(
				`Anthropic request failed with status ${response.status}: ${body}`,
				"anthropic",
				response.status,
			);
		}

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
