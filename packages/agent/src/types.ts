import type { ToolDefinition } from "@bound/llm";

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
