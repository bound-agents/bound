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
	 * Extended thinking configuration. When set, the model produces
	 * reasoning content blocks before the final response.
	 *
	 * Two discriminants:
	 *  - `{type: "enabled", budget_tokens: N}` — legacy shape. Claude
	 *    thinks for up to N tokens. 400s on Opus 4.7.
	 *  - `{type: "adaptive", display?}` — model-controlled depth; works
	 *    on Opus 4.6+ and required on Opus 4.7. Pair with `effort` below
	 *    to control how much thinking the model does. `display` defaults
	 *    to "omitted" on Opus 4.7 — set "summarized" to get visible
	 *    reasoning text in stream chunks.
	 *
	 * Only supported by Anthropic (direct) and Bedrock (Converse API)
	 * backends. Other backends silently ignore this field.
	 */
	thinking?:
		| { type: "enabled"; budget_tokens: number }
		| { type: "adaptive"; display?: "omitted" | "summarized" };
	/**
	 * `output_config.effort` — controls thinking depth and overall token
	 * spend. Replaces `budget_tokens` as the depth lever on Opus 4.7 and
	 * is recommended alongside adaptive thinking on Opus 4.6. Levels:
	 *  - `low` / `medium` — scoped work, lower cost
	 *  - `high` — recommended minimum for intelligence-sensitive tasks
	 *  - `xhigh` — new on 4.7; sweet spot for coding/agentic workloads
	 *  - `max` — Opus-tier only; ceiling, can over-think on small tasks
	 *
	 * Supported by Anthropic (direct) and Bedrock (Converse API) backends.
	 */
	effort?: "low" | "medium" | "high" | "xhigh" | "max";
	signal?: AbortSignal;
}

export type LLMMessage = {
	role: "user" | "assistant" | "system" | "tool_call" | "tool_result" | "developer" | "cache";
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
	| { type: "thinking"; thinking: string; signature?: string }
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
	| { type: "thinking"; content: string; signature?: string }
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
	| { type: "error"; error: string }
	| { type: "heartbeat" };

export interface BackendCapabilities {
	streaming: boolean;
	tool_use: boolean;
	system_prompt: boolean;
	prompt_caching: boolean;
	vision: boolean;
	extended_thinking: boolean;
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

// Inference relay payload types.
// Mirrors the wire schema in @bound/shared `inferenceRequestPayloadSchema`
// — both the legacy `{type:"enabled", budget_tokens}` thinking shape and
// the Opus 4.7 adaptive shape are forwarded to remote hosts. `effort`
// forwards the top-level output_config.effort knob.
export interface InferenceRequestPayload {
	model: string;
	messages: LLMMessage[];
	tools?: ToolDefinition[];
	system?: string;
	max_tokens?: number;
	temperature?: number;
	thinking?:
		| { type: "enabled"; budget_tokens: number }
		| { type: "adaptive"; display?: "omitted" | "summarized" };
	effort?: "low" | "medium" | "high" | "xhigh" | "max";
	timeout_ms: number;
	messages_file_ref?: string; // Set when messages are written to synced file (large prompt path)
}

export interface StreamChunkPayload {
	chunks: StreamChunk[];
	seq: number;
}

// stream_end has the same shape as stream_chunk — the relay kind field distinguishes them
export type StreamEndPayload = StreamChunkPayload;
