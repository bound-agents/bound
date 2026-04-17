import type { ToolDefinition } from "@bound/llm";

/**
 * Signal from a client tool that indicates the tool execution should be deferred
 * to the client (e.g., over WebSocket). The agent loop persists the tool_call
 * message and exits, waiting for a tool_result to be provided by the client.
 */
export interface ClientToolCallRequest {
	clientToolCall: true; // discriminant
	toolName: string;
	callId: string;
	arguments: Record<string, unknown>;
}

/**
 * Type guard to check if a tool execution result is a client tool call request.
 */
export function isClientToolCallRequest(result: unknown): result is ClientToolCallRequest {
	return (
		result != null &&
		typeof result === "object" &&
		"clientToolCall" in result &&
		(result as { clientToolCall: unknown }).clientToolCall === true
	);
}

export type AgentLoopState =
	| "IDLE"
	| "HYDRATE_FS"
	| "ASSEMBLE_CONTEXT"
	| "LLM_CALL"
	| "PARSE_RESPONSE"
	| "TOOL_EXECUTE"
	| "TOOL_PERSIST"
	| "RESPONSE_PERSIST"
	| "FS_PERSIST"
	| "QUEUE_CHECK"
	| "ERROR_PERSIST"
	| "AWAIT_POLL"
	| "RELAY_WAIT"
	| "RELAY_STREAM";

export interface AgentLoopConfig {
	threadId: string;
	taskId?: string;
	userId: string;
	modelId?: string;
	/** Tier of the requested model (1-5). When set alongside modelId, enables
	 *  cost-equivalent fallback to a same-tier alternative on resolution failure. */
	modelTier?: number;
	abortSignal?: AbortSignal;
	/** Called after each tool execution to signal the loop is still active. */
	onActivity?: () => void;
	tools?: Array<{
		type: "function";
		function: {
			name: string;
			description: string;
			parameters: Record<string, unknown>;
		};
	}>;
	/** Platform identifier when the loop runs in a platform context (e.g. "discord"). */
	platform?: string;
	/**
	 * Platform-contributed tool closures, keyed by tool name.
	 * The agent loop checks this map before falling through to sandbox dispatch.
	 */
	platformTools?: Map<
		string,
		{
			toolDefinition: ToolDefinition;
			execute: (input: Record<string, unknown>) => Promise<string>;
		}
	>;
	/**
	 * Client-side tool definitions, keyed by tool name.
	 * The agent loop includes these in the LLM tool list but defers execution
	 * to the client. Tool calls matching these names return a ClientToolCallRequest
	 * sentinel instead of executing locally.
	 */
	clientTools?: Map<
		string,
		{
			type: "function";
			function: {
				name: string;
				description: string;
				parameters: Record<string, unknown>;
			};
		}
	>;
	/** When true, skip loading conversation history from the messages table.
	 *  The loop receives context only through volatile enrichment (memory, task digest,
	 *  standing instructions). Used for autonomous tasks like heartbeat where history
	 *  is stale self-referential output. */
	noHistory?: boolean;
	/**
	 * Cooperative cancellation callback. Checked at yield points (before tool
	 * execution, after tool result persistence). When it returns true, the loop
	 * stops cleanly without executing further tool calls or writing completion
	 * markers. Used by the dispatch system to coalesce rapid-fire messages.
	 */
	shouldYield?: () => boolean;
}

export interface AgentLoopResult {
	messagesCreated: number;
	toolCallsMade: number;
	filesChanged: number;
	error?: string;
	/** True when the loop exited early due to shouldYield (cooperative cancellation). */
	yielded?: boolean;
}
