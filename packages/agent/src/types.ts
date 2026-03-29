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
}

export interface AgentLoopResult {
	messagesCreated: number;
	toolCallsMade: number;
	filesChanged: number;
	error?: string;
}
