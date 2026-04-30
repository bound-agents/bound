import type { ContentBlock } from "@bound/llm";
import type { AgentFile, MemoryTier, Message, Task, Thread } from "@bound/shared";

// ---- Thread responses ----

/** Thread with computed fields from GET /api/threads listing. */
export interface ThreadListEntry extends Thread {
	messageCount: number;
	lastModel: string | null;
	/** Whether the thread currently has an active agent loop or running task.
	 *  Server-side derived so clients don't need to poll /status per-thread. */
	active: boolean;
}

/** GET /api/threads/:id/status */
export interface ThreadStatus {
	active: boolean;
	state: string | null;
	detail: unknown | null;
	tokens: number;
	model: string | null;
}

// ---- Threads ----

export interface CreateThreadOptions {
	/**
	 * Optional interface/surface tag for the new thread. Must match
	 * `/^[a-z0-9-]+$/i` and be <= 32 chars. Defaults to `"web"` on the
	 * server when omitted. Typical values: `"web"`, `"boundless"`.
	 */
	interface?: string;
}

// ---- Messages ----

export interface SendMessageOptions {
	modelId?: string;
	fileId?: string;
}

export interface RedactMessageResult {
	redacted: true;
	messageId: string;
}

export interface RedactThreadResult {
	redacted: true;
	threadId: string;
	messagesRedacted: number;
	memoriesAffected: number;
}

// ---- Files ----

/** File metadata without content, from GET /api/files listing. */
export type FileListEntry = Omit<AgentFile, "content">;

// ---- Tasks ----

/** Task with computed fields from GET /api/tasks listing. */
export interface TaskListEntry extends Task {
	displayName: string;
	schedule: string | null;
	hostName: string | null;
	lastDurationMs: number | null;
}

// ---- Advisories ----

export interface AdvisoryCount {
	count: number;
}

// ---- Status ----

export interface HostStatus {
	host_info: {
		uptime_seconds: number;
		active_loops: number;
	};
}

export interface NetworkStatus {
	hosts: Record<string, unknown>[];
	hub: { siteId: string; hostName: string } | null;
	syncState: Record<string, unknown>[];
	localSiteId: string;
}

export interface ClusterModelInfo {
	id: string;
	provider: string;
	host: string;
	via: "local" | "relay";
	status: "local" | "online" | "offline?";
}

export interface ModelsResponse {
	models: ClusterModelInfo[];
	default: string;
}

export interface CancelResult {
	cancelled: true;
	thread_id: string;
}

// ---- Memory ----

export interface MemoryGraphNode {
	key: string;
	value: string;
	tier: MemoryTier;
	source: string | null;
	sourceThreadTitle: string | null;
	lineIndex: number | null;
	modifiedAt: string;
}

export interface MemoryGraphEdge {
	sourceKey: string;
	targetKey: string;
	relation: string;
	modifiedAt: string;
}

export interface MemoryGraphResponse {
	nodes: MemoryGraphNode[];
	edges: MemoryGraphEdge[];
}

// ---- Context Debug ----

export interface ContextDebugSection {
	name: string;
	tokens: number;
	children?: ContextDebugSection[];
}

export interface CrossThreadSource {
	threadId: string;
	title: string;
	color: number;
	messageCount: number;
	lastMessageAt: string;
}

export interface ContextDebugInfo {
	contextWindow: number;
	totalEstimated: number;
	model: string;
	sections: ContextDebugSection[];
	budgetPressure: boolean;
	truncated: number;
	crossThreadSources?: CrossThreadSource[];
}

export interface ContextDebugTurn {
	turn_id: string;
	model_id: string;
	tokens_in: number;
	tokens_out: number;
	context_debug: ContextDebugInfo;
	created_at: string;
}

// ---- MCP ----

export interface CreateMcpThreadResult {
	thread_id: string;
}

// ---- Errors ----

export interface ApiErrorBody {
	error: string;
	details?: unknown;
}

// ---- WebSocket ----

export interface ToolDefinition {
	type: "function";
	function: {
		name: string;
		description: string;
		parameters: Record<string, unknown>;
	};
}

export interface ToolCallRequest {
	call_id: string;
	thread_id: string;
	tool_name: string;
	arguments: Record<string, unknown>;
}

export interface ToolCallResult {
	call_id: string;
	thread_id: string;
	content: string | ContentBlock[];
	is_error?: boolean;
}

export interface ToolCancelEvent {
	callId: string;
	threadId: string;
	reason?: string;
}

export interface BoundClientEvents {
	"message:created": (msg: Message) => void;
	"task:updated": (data: { taskId: string; status: string }) => void;
	"file:updated": (data: { path: string; operation: string }) => void;
	"context:debug": (data: ContextDebugTurn) => void;
	"thread:status": (data: {
		thread_id: string;
		active: boolean;
		state: string | null;
		tokens: number;
		model: string | null;
	}) => void;
	"tool:call": (call: ToolCallRequest) => void;
	"tool:cancel": (event: ToolCancelEvent) => void;
	error: (err: Event | Error | { code: string; message: string }) => void;
	open: () => void;
	close: () => void;
}
