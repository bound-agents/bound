import type {
	BackendCapabilities,
	ChatParams,
	LLMBackend,
	LLMMessage,
	StreamChunk,
} from "./types";
import { LLMError } from "./types";

interface BedrockMessage {
	role: "user" | "assistant";
	content: Array<{
		type: "text" | "tool_use" | "tool_result";
		text?: string;
		id?: string;
		name?: string;
		input?: Record<string, unknown>;
		toolUseId?: string;
		content?: Array<{ type: "text"; text: string }>;
	}>;
}

interface BedrockRequest {
	modelId: string;
	messages: BedrockMessage[];
	system?: string;
	tools?: Array<{
		name: string;
		description?: string;
		inputSchema: {
			json: Record<string, unknown>;
		};
	}>;
	inferenceConfig?: {
		temperature?: number;
		maxTokens?: number;
	};
}

function toBedrockMessages(messages: LLMMessage[]): BedrockMessage[] {
	const result: BedrockMessage[] = [];

	for (const msg of messages) {
		// Handle array content blocks
		if (Array.isArray(msg.content)) {
			if (msg.role === "tool_call") {
				// Convert tool_call to assistant message with tool_use blocks
				const content: BedrockMessage["content"] = [];
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
							toolUseId: msg.tool_use_id,
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
							toolUseId: msg.tool_use_id,
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

async function* parseBedrockStream(response: Response): AsyncIterable<StreamChunk> {
	const reader = response.body?.getReader();
	if (!reader) {
		throw new LLMError("Response body not available", "bedrock");
	}

	const decoder = new TextDecoder();
	let buffer = "";

	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;

			buffer += decoder.decode(value, { stream: true });

			// Process complete events
			let eventStart = buffer.indexOf("{");
			while (eventStart !== -1) {
				let braceCount = 0;
				let eventEnd = -1;

				for (let i = eventStart; i < buffer.length; i++) {
					if (buffer[i] === "{") braceCount++;
					if (buffer[i] === "}") {
						braceCount--;
						if (braceCount === 0) {
							eventEnd = i + 1;
							break;
						}
					}
				}

				if (eventEnd === -1) break;

				const eventStr = buffer.substring(eventStart, eventEnd);
				buffer = buffer.substring(eventEnd);

				try {
					// biome-ignore lint/suspicious/noExplicitAny: <explanation>
					const event = JSON.parse(eventStr) as any;

					if (event.type === "content_block_delta" && event.delta?.type === "text_delta") {
						yield {
							type: "text",
							content: event.delta.text || "",
						};
					}

					if (event.type === "content_block_start" && event.content_block?.type === "tool_use") {
						yield {
							type: "tool_use_start",
							id: event.content_block.id || "",
							name: event.content_block.name || "",
						};
					}

					if (
						event.type === "content_block_delta" &&
						event.delta?.type === "input_json_delta"
					) {
						yield {
							type: "tool_use_args",
							id: event.index || "",
							partial_json: event.delta.partial_json || "",
						};
					}

					if (event.type === "content_block_stop") {
						// Tool use stopped
					}

					if (event.type === "message_stop") {
						yield {
							type: "done",
							usage: {
								input_tokens: event.message?.usage?.input_tokens || 0,
								output_tokens: event.message?.usage?.output_tokens || 0,
							},
						};
					}
				} catch {
					// Ignore parse errors
				}

				eventStart = buffer.indexOf("{");
			}
		}
	} finally {
		reader.releaseLock();
	}
}

export class BedrockDriver implements LLMBackend {
	private region: string;
	private model: string;
	private contextWindow: number;

	constructor(config: {
		region: string;
		model: string;
		contextWindow: number;
	}) {
		this.region = config.region;
		this.model = config.model;
		this.contextWindow = config.contextWindow;
	}

	async *chat(params: ChatParams): AsyncIterable<StreamChunk> {
		const bedrockMessages = toBedrockMessages(params.messages);

		const request: BedrockRequest = {
			modelId: params.model || this.model,
			messages: bedrockMessages,
			system: params.system,
		};

		if (params.max_tokens || params.temperature !== undefined) {
			request.inferenceConfig = {
				temperature: params.temperature,
				maxTokens: params.max_tokens,
			};
		}

		if (params.tools && params.tools.length > 0) {
			request.tools = params.tools.map((tool) => ({
				name: tool.function.name,
				description: tool.function.description,
				inputSchema: {
					json: tool.function.parameters,
				},
			}));
		}

		// In a real implementation, this would use AWS SDK v3
		// For now, we'll make a standard HTTP request to the Bedrock API endpoint
		const endpoint = `https://bedrock-runtime.${this.region}.amazonaws.com/model/${params.model || this.model}/converse-stream`;

		let response: Response;
		try {
			response = await fetch(endpoint, {
				method: "POST",
				headers: {
					"Content-Type": "application/x-amzn-sagemaker-custom-attributes",
				},
				body: JSON.stringify(request),
			});
		} catch (error) {
			throw new LLMError(
				`Failed to connect to Bedrock: ${
					error instanceof Error ? error.message : String(error)
				}`,
				"bedrock",
				undefined,
				error instanceof Error ? error : new Error(String(error)),
			);
		}

		if (!response.ok) {
			const body = await response.text();
			throw new LLMError(
				`Bedrock request failed with status ${response.status}: ${body}`,
				"bedrock",
				response.status,
			);
		}

		yield* parseBedrockStream(response);
	}

	capabilities(): BackendCapabilities {
		return {
			streaming: true,
			tool_use: true,
			system_prompt: true,
			prompt_caching: false,
			vision: true,
			max_context: this.contextWindow,
		};
	}
}
