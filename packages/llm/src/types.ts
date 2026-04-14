export interface LLMBackend {
	chat(params: ChatParams): AsyncIterable<StreamChunk>;
	capabilities(): BackendCapabilities;
}

export interface ChatParams {
	/**
	 * Backend-specific model identifier. If omitted, the driver uses the model
	 * from its constructor config.
	 *
	 * WARNING: This must match the provider's model ID format (e.g., Bedrock ARN).
	 * Do NOT pass logical aliases like "opus" — the ModelRouter handles alias resolution.
	 */
	model?: string;
	messages: LLMMessage[];
	tools?: ToolDefinition[];
	max_tokens?: number;
	temperature?: number;
	system?: string;
	/**
	 * Varying system context placed AFTER the cached system prefix.
	 * When cache_breakpoints are provided, this content is sent as a separate
	 * uncached system block so it doesn't bust the prompt cache.
	 * Without cache_breakpoints, it's appended to the system string.
	 */
	system_suffix?: string;
	cache_breakpoints?: number[];
	/**
	 * Cache TTL hint. Currently UNIMPLEMENTED — do not set.
	 * Adding TTL to cache_control breaks caching on both Anthropic and Bedrock.
	 * @deprecated Unimplemented. Will be removed or implemented in a future version.
	 */
	cache_ttl?: "5m" | "1h";
	signal?: AbortSignal;
}

export type LLMMessage = {
	role: "user" | "assistant" | "system" | "tool_call" | "tool_result";
	content: string | ContentBlock[];
	tool_use_id?: string;
	model_id?: string;
	host_origin?: string;
};

export type ImageSource =
	| {
			type: "base64";
			media_type: "image/jpeg" | "image/png" | "image/gif" | "image/webp";
			data: string;
	  }
	| { type: "file_ref"; file_id: string };

export type ContentBlock =
	| { type: "text"; text: string }
	| { type: "tool_use"; id: string; name: string; input: Record<string, unknown> }
	| { type: "image"; source: ImageSource; description?: string }
	| { type: "document"; source: ImageSource; text_representation: string; title?: string };

export interface CapabilityRequirements {
	vision?: boolean;
	tool_use?: boolean;
	system_prompt?: boolean;
	prompt_caching?: boolean;
}

export type StreamChunk =
	| { type: "text"; content: string }
	| { type: "tool_use_start"; id: string; name: string }
	| { type: "tool_use_args"; id: string; partial_json: string }
	| { type: "tool_use_end"; id: string }
	| {
			type: "done";
			usage: {
				input_tokens: number;
				output_tokens: number;
				cache_write_tokens: number | null;
				cache_read_tokens: number | null;
				estimated: boolean;
			};
	  }
	| { type: "error"; error: string };

export interface BackendCapabilities {
	streaming: boolean;
	tool_use: boolean;
	system_prompt: boolean;
	prompt_caching: boolean;
	vision: boolean;
	max_context: number;
}

export interface ToolDefinition {
	type: "function";
	function: {
		name: string;
		description: string;
		parameters: Record<string, unknown>;
	};
}

export interface BackendConfig {
	id: string;
	provider: string;
	model: string;
	baseUrl?: string;
	contextWindow?: number;
	[key: string]: unknown;
}

export interface ModelBackendsConfig {
	backends: BackendConfig[];
	default: string;
}

export class LLMError extends Error {
	constructor(
		message: string,
		public provider: string,
		public statusCode?: number,
		public originalError?: Error,
		public retryAfterMs?: number,
	) {
		super(message);
		this.name = "LLMError";
	}
}

// Inference relay payload types
export interface InferenceRequestPayload {
	model: string;
	messages: LLMMessage[];
	tools?: ToolDefinition[];
	system?: string;
	system_suffix?: string;
	max_tokens?: number;
	temperature?: number;
	cache_breakpoints?: number[];
	timeout_ms: number;
	messages_file_ref?: string; // Set when messages are written to synced file (large prompt path)
}

export interface StreamChunkPayload {
	chunks: StreamChunk[];
	seq: number;
}

// stream_end has the same shape as stream_chunk — the relay kind field distinguishes them
export type StreamEndPayload = StreamChunkPayload;
