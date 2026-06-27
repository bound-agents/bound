import type { ContentBlock, ToolDefinition } from "@bound/llm";
import type { McpAppBinding } from "@bound/sandbox";
import type { WsStreamChunk } from "@bound/shared";
import type { Context } from "@opentelemetry/api";

export type BuiltInToolResult = string | ContentBlock[];

/**
 * Signal from a client tool that indicates the tool execution should be
 * deferred outside the loop process, for example over WebSocket.
 */
export interface ClientToolCallRequest {
	clientToolCall: true;
	toolName: string;
	callId: string;
	arguments: Record<string, unknown>;
}

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

export const VALID_TRANSITIONS: Record<AgentLoopState, readonly AgentLoopState[]> = {
	IDLE: ["HYDRATE_FS"],
	HYDRATE_FS: ["ASSEMBLE_CONTEXT"],
	ASSEMBLE_CONTEXT: ["LLM_CALL", "RELAY_STREAM", "ERROR_PERSIST", "FS_PERSIST"],
	LLM_CALL: ["LLM_CALL", "PARSE_RESPONSE", "ERROR_PERSIST"],
	PARSE_RESPONSE: ["TOOL_EXECUTE", "RESPONSE_PERSIST", "FS_PERSIST"],
	TOOL_EXECUTE: ["TOOL_PERSIST", "RELAY_WAIT", "ERROR_PERSIST"],
	TOOL_PERSIST: ["LLM_CALL", "RESPONSE_PERSIST", "FS_PERSIST"],
	RESPONSE_PERSIST: ["FS_PERSIST"],
	FS_PERSIST: ["QUEUE_CHECK"],
	QUEUE_CHECK: ["IDLE", "ASSEMBLE_CONTEXT"],
	ERROR_PERSIST: [],
	AWAIT_POLL: [],
	RELAY_WAIT: [],
	RELAY_STREAM: [],
};

export interface DispatchSpanTracker {
	openDispatch(threadId: string, callId: string, toolName: string): Context;
}

export interface AgentLoopConfig {
	threadId: string;
	taskId?: string;
	taskType?: string;
	userId: string;
	modelId?: string;
	modelTier?: number;
	abortSignal?: AbortSignal;
	onActivity?: () => void;
	onStreamChunk?: (chunk: WsStreamChunk) => void;
	tools?: ToolDefinition[];
	platform?: string;
	clientTools?: Map<string, ToolDefinition>;
	noHistory?: boolean;
	noTools?: boolean;
	maxOutputTokens?: number;
	shouldYield?: () => boolean;
	connectionId?: string;
	systemPromptAddition?: string;
	platformInstructions?: string;
	platformTools?: Array<{
		kind: "platform";
		toolDefinition: ToolDefinition;
		execute?: (input: Record<string, unknown>) => Promise<string>;
		idempotent?: boolean;
		readOnly?: boolean;
		annotations?: {
			idempotentHint?: boolean;
			readOnlyHint?: boolean;
		};
		resolveAnnotations?: (args: Record<string, unknown>) => ToolAnnotations;
	}>;
	toolRegistry?: Map<string, RegisteredTool>;
	handleMessageTracker?: DispatchSpanTracker;
}

export interface AgentLoopResult {
	messagesCreated: number;
	toolCallsMade: number;
	filesChanged: number;
	error?: string;
	yielded?: boolean;
}

export interface ToolAnnotations {
	idempotent?: boolean;
	readOnly?: boolean;
}

/**
 * Tool registered in the loop's unified tool registry. The loop owns dispatch
 * strategy; packages above it decide which tools to register.
 */
export interface RegisteredTool {
	kind: "platform" | "client" | "builtin" | "sandbox";
	toolDefinition: ToolDefinition;
	execute?: (input: Record<string, unknown>) => Promise<BuiltInToolResult | string>;
	idempotent?: boolean;
	readOnly?: boolean;
	resolveAnnotations?: (args: Record<string, unknown>) => ToolAnnotations;
}

export interface ToolExecutionResult {
	content: string;
	exitCode: number;
	durationMs?: number;
	mcpApp?: McpAppBinding;
}
