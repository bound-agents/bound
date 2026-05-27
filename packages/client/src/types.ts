import type { ContentBlock } from "@bound/llm";
import type { AgentFile, MemoryTier, Message, Task, Thread, WsStreamChunk } from "@bound/shared";

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

export interface CacheMarker {
	kind: "system" | "message";
	/**
	 * Cumulative-token offset into the breakdown bar at the breakpoint boundary.
	 * UI converts to a bar percentage via `positionTokens / contextWindow`.
	 */
	positionTokens: number;
	/** "fixed" = cold-path placement; "rolling" = warm-path re-placement. */
	variant: "fixed" | "rolling";
	ttl: "5m" | "1h";
	/**
	 * `true` when the backend's prompt_caching capability is on AND a marker
	 * was emitted on the wire; `false` when caching was gated out.
	 */
	capabilityEnabled: boolean;
}

export interface ContextDebugInfo {
	contextWindow: number;
	totalEstimated: number;
	/**
	 * LLM-reported actual input tokens for this turn (raw_input + cache_read +
	 * cache_write per AI-SDK semantics). Set after the LLM responds via
	 * `applyActualUsageToContextDebug`; undefined until the response arrives.
	 *
	 * Preferred over `totalEstimated` for headline display because the local
	 * cl100k_base estimator drifts (typically 10–15% under, sometimes 2x+ on
	 * thinking-heavy threads) from the provider tokenizer that actually bills.
	 */
	actualTotalTokens?: number;
	model: string;
	sections: ContextDebugSection[];
	budgetPressure: boolean;
	truncated: number;
	crossThreadSources?: CrossThreadSource[];
	/**
	 * Cache breakpoint descriptors recorded by the agent loop after marker
	 * placement. Absent on turns persisted before this field existed and on
	 * turns where the backend disabled caching entirely.
	 */
	cacheMarkers?: CacheMarker[];
}

export interface ContextDebugTurn {
	turn_id: string;
	model_id: string;
	tokens_in: number;
	tokens_out: number;
	/**
	 * Cache-read tokens reported by the LLM driver for this turn. Sum of cache
	 * hits across all breakpoints (the AI SDK aggregates). Null on rows from
	 * before cache reporting was wired up; 0 on turns with no cache hits.
	 */
	tokens_cache_read: number | null;
	/**
	 * Cache-write tokens reported by the LLM driver for this turn. Indicates a
	 * breakpoint seeded a fresh cache entry. Null on rows from before cache
	 * reporting was wired up; 0 on turns with no cache writes.
	 */
	tokens_cache_write: number | null;
	context_debug: ContextDebugInfo;
	created_at: string;
}

// ---- MCP ----

export interface CreateMcpThreadResult {
	thread_id: string;
}

// ---- Webhooks ----

export interface WebhookListEntry {
	id: string;
	name: string;
	signature_format: string;
	description: string | null;
	task_id: string;
	thread_id: string;
	created_at: string;
	modified_at: string;
	/**
	 * Custom system prompt addition for the webhook's event handler.
	 * Stored on the linked event task (`tasks.system_prompt_addition`) and
	 * surfaced here by the server so the UI can pre-populate edit forms.
	 * Null when no custom prompt has been configured.
	 */
	prompt: string | null;
	/**
	 * Model hint applied to the webhook's event task (and its delivery thread).
	 * Stored on `tasks.model_hint`; null means "use the cluster default model".
	 */
	model_hint: string | null;
	/**
	 * When true, the webhook's event task runs with conversation history
	 * suppressed — each delivery starts from a clean context window. Saves
	 * tokens for stateless webhook handlers and partially mitigates the
	 * retrieve_task spin pattern (#51) by removing the prior-cycle echo.
	 * Stored as 0/1 on `tasks.no_history` and coerced to a boolean here.
	 */
	no_history: boolean;
}

export interface WebhookCreateResponse extends WebhookListEntry {
	secret: string; // Only present on create
}

export interface WebhookRotateResponse {
	secret: string;
}

export interface CreateWebhookOptions {
	name: string;
	format?: string;
	description?: string;
	prompt?: string;
	/**
	 * Optional model hint for the webhook's event task. Omit / null / empty
	 * string all leave the task on the cluster default model.
	 */
	model_hint?: string | null;
	/**
	 * When true, the webhook's event task is created with no_history=1.
	 * Defaults to false (history enabled). See WebhookListEntry.no_history.
	 */
	no_history?: boolean;
}

export interface UpdateWebhookOptions {
	description?: string;
	prompt?: string;
	format?: string;
	/**
	 * Three-state semantics, mirroring the server PATCH route:
	 *   omitted        → leave existing model_hint alone
	 *   null or ""     → clear back to the cluster default
	 *   non-empty str  → set the model_hint
	 */
	model_hint?: string | null;
	/**
	 * Two-state semantics on PATCH:
	 *   omitted   → leave the no_history flag alone
	 *   true/false → set the flag explicitly
	 * Non-boolean values are rejected by the server with HTTP 400.
	 */
	no_history?: boolean;
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
	trace_context?: string; // W3C trace context JSON (optional)
}

export interface ToolCallResult {
	call_id: string;
	thread_id: string;
	content: string | ContentBlock[];
	is_error?: boolean;
	trace_data?: string; // serialized span array JSON (optional)
}

export interface ToolCancelEvent {
	callId: string;
	threadId: string;
	reason?: string;
}

/**
 * Connection state of a BoundClient's WebSocket.
 *
 * - `connecting`: a connection attempt is in flight (initial connect, or a
 *   reconnect after a drop). The socket exists but `onopen` has not fired.
 * - `connected`: the socket is open and ready to send/receive.
 * - `disconnected`: no socket, or the socket closed and we are in the
 *   reconnect backoff window before the next attempt is scheduled.
 */
export type ConnectionState = "connecting" | "connected" | "disconnected";

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
	"stream:chunk": (data: { thread_id: string; chunk: WsStreamChunk }) => void;
	"tool:call": (call: ToolCallRequest) => void;
	"tool:cancel": (event: ToolCancelEvent) => void;
	error: (err: Event | Error | { code: string; message: string }) => void;
	open: () => void;
	close: () => void;
	/** Fires whenever the client's connection state transitions. */
	"connection:state": (state: ConnectionState) => void;
}
