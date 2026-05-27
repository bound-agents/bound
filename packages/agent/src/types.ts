import type { ToolDefinition } from "@bound/llm";
import type { WsStreamChunk } from "@bound/shared";
import type { BuiltInToolResult } from "./built-in-tools";

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

export const VALID_TRANSITIONS: Record<AgentLoopState, readonly AgentLoopState[]> = {
	IDLE: ["HYDRATE_FS"],
	HYDRATE_FS: ["ASSEMBLE_CONTEXT"],
	ASSEMBLE_CONTEXT: ["LLM_CALL", "RELAY_STREAM", "ERROR_PERSIST", "FS_PERSIST"],
	LLM_CALL: ["PARSE_RESPONSE", "ERROR_PERSIST"],
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
	/** Called for each non-heartbeat stream chunk during LLM inference. */
	onStreamChunk?: (chunk: WsStreamChunk) => void;
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
	/**
	 * Connection ID for WebSocket client delivering client tool calls.
	 * Required when clientTools are present.
	 */
	connectionId?: string;
	/**
	 * Optional system prompt addition from the WebSocket connection.
	 * Passed through to ContextParams and appended to the system suffix.
	 */
	systemPromptAddition?: string;
	/**
	 * Platform MCP tools with execute closures that call MCP client.callTool.
	 * These are passed through to the tool registry with their execute functions intact.
	 */
	platformTools?: Array<{
		kind: "platform";
		toolDefinition: {
			type: "function";
			function: {
				name: string;
				description: string;
				parameters: Record<string, unknown>;
			};
		};
		execute?: (input: Record<string, unknown>) => Promise<string>;
	}>;
	/**
	 * Unified tool registry for dispatching all tool kinds (platform, client, builtin, sandbox).
	 * When provided, enables registry-based dispatch with backward compatibility via legacy waterfall.
	 */
	toolRegistry?: Map<string, RegisteredTool>;
	/**
	 * Cross-handler-invocation span tracker. When provided, the agent loop
	 * opens `tool.dispatch` spans here as out-of-process tool calls are
	 * enqueued, so the carrier injected into the WS `tool:call` frame
	 * identifies `tool.dispatch` (not `agent-loop.tool-execute`) as the
	 * parent. The dispatch span is closed by the WS handler on `tool:result`,
	 * not by the agent loop itself. Optional — when absent, dispatches still
	 * function but client tool spans dangle as before.
	 */
	handleMessageTracker?: import("./handle-message-tracker").HandleMessageTracker;
}

export interface AgentLoopResult {
	messagesCreated: number;
	toolCallsMade: number;
	filesChanged: number;
	error?: string;
	/** True when the loop exited early due to shouldYield (cooperative cancellation). */
	yielded?: boolean;
}

/**
 * A tool registered in the unified tool registry, tagged with its execution strategy.
 * The kind discriminant controls how the tool is executed:
 * - "platform": Executes via execute closure (calls MCP client.callTool), returns Promise<string>
 * - "client": Defers execution to WebSocket client, no execute function
 * - "builtin": Executes via built-in tool handlers (read/write/edit/etc), returns Promise<BuiltInToolResult>
 * - "sandbox": Executes via bash in sandbox, no execute function (dispatches through sandbox.exec)
 */
export interface RegisteredTool {
	kind: "platform" | "client" | "builtin" | "sandbox";
	toolDefinition: ToolDefinition;
	execute?: (input: Record<string, unknown>) => Promise<BuiltInToolResult | string>;

	/**
	 * Idempotency hint — N invocations with identical args leave the system in
	 * the same final state as 1 invocation. Used by the relay retry path to
	 * decide whether to re-dispatch on ambiguous transient errors. Mirrors the
	 * MCP spec's `tool.annotations.idempotentHint`.
	 *
	 * Treat as a non-binding hint. The agent loop never relies on this for
	 * security or correctness — only for retry policy.
	 */
	idempotent?: boolean;

	/**
	 * Read-only hint — the tool never mutates state. Strict subset of
	 * idempotent (every read-only tool is idempotent; the converse is false).
	 * Mirrors the MCP spec's `tool.annotations.readOnlyHint`.
	 */
	readOnly?: boolean;

	/**
	 * Per-action resolver for tools whose idempotency depends on the input
	 * (e.g. `memory search` is read-only but `memory store` mutates). When
	 * defined, takes precedence over the static `idempotent`/`readOnly`
	 * fields. Returning `{}` means "unknown" — the retry path treats this
	 * the same as no annotations.
	 */
	resolveAnnotations?: (args: Record<string, unknown>) => {
		idempotent?: boolean;
		readOnly?: boolean;
	};
}

/**
 * Context passed to native agent tool factories.
 * Extends the fields needed by all tool closures (db, siteId, eventBus, logger, threadId, taskId, modelRouter).
 * Uses inline import() types to avoid circular dependencies.
 */
export interface ToolContext {
	db: import("bun:sqlite").Database;
	siteId: string;
	eventBus: import("@bound/shared").TypedEventEmitter;
	logger: import("@bound/shared").Logger;
	threadId?: string;
	taskId?: string;
	modelRouter?: import("@bound/llm").ModelRouter;
	fs?: import("just-bash").IFileSystem;
}
