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
	| "AWAIT_POLL";

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
}

export interface AgentLoopResult {
	messagesCreated: number;
	toolCallsMade: number;
	filesChanged: number;
	error?: string;
}
