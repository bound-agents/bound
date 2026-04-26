export type MessageRole =
	| "user"
	| "assistant"
	| "system"
	| "developer"
	| "alert"
	| "tool_call"
	| "tool_result"
	| "purge";

export type TaskType = "cron" | "deferred" | "event" | "heartbeat";

export type TaskStatus = "pending" | "claimed" | "running" | "completed" | "failed" | "cancelled";

export type InjectMode = "results" | "status" | "file";

export type AdvisoryType = "cost" | "frequency" | "memory" | "model" | "general";

export type AdvisoryStatus = "proposed" | "approved" | "dismissed" | "deferred" | "applied";

export type SkillStatus = "active" | "retired";

export type MemoryTier = "pinned" | "summary" | "default" | "detail";

export type SyncedTableName =
	| "users"
	| "threads"
	| "messages"
	| "semantic_memory"
	| "tasks"
	| "files"
	| "hosts"
	| "overlay_index"
	| "cluster_config"
	| "advisories"
	| "skills"
	| "memory_edges"
	| "turns";

export type ReducerType = "lww" | "append-only";

export interface User {
	id: string;
	display_name: string;
	platform_ids: string | null;
	first_seen_at: string;
	modified_at: string;
	deleted: number;
}

export interface Thread {
	id: string;
	user_id: string;
	interface: string;
	host_origin: string;
	color: number;
	title: string | null;
	summary: string | null;
	summary_through: string | null;
	summary_model_id: string | null;
	extracted_through: string | null;
	created_at: string;
	last_message_at: string;
	deleted: number;
}

export interface Message {
	id: string;
	thread_id: string;
	role: MessageRole;
	content: string;
	model_id: string | null;
	tool_name: string | null;
	created_at: string;
	modified_at: string | null;
	host_origin: string;
	/** Exit code from tool execution. Only set for tool_result messages. */
	exit_code?: number | null;
}

export interface SemanticMemory {
	id: string;
	key: string;
	value: string;
	source: string | null;
	created_at: string;
	modified_at: string;
	last_accessed_at: string | null;
	tier: MemoryTier;
	deleted: number;
}

export interface Task {
	id: string;
	type: TaskType;
	status: TaskStatus;
	trigger_spec: string;
	payload: string | null;
	thread_id: string | null;
	origin_thread_id: string | null;
	claimed_by: string | null;
	claimed_at: string | null;
	lease_id: string | null;
	next_run_at: string | null;
	last_run_at: string | null;
	run_count: number;
	max_runs: number | null;
	requires: string | null;
	model_hint: string | null;
	no_history: number;
	inject_mode: InjectMode;
	depends_on: string | null;
	require_success: number;
	alert_threshold: number;
	consecutive_failures: number;
	event_depth: number;
	no_quiescence: number;
	heartbeat_at: string | null;
	result: string | null;
	error: string | null;
	created_at: string;
	created_by: string | null;
	modified_at: string;
	deleted: number;
}

export interface AgentFile {
	id: string;
	path: string;
	content: string | null;
	is_binary: number;
	size_bytes: number;
	created_at: string;
	modified_at: string;
	deleted: number;
	created_by: string | null;
	host_origin: string | null;
}

export interface Host {
	site_id: string;
	host_name: string;
	version: string | null;
	sync_url: string | null;
	mcp_servers: string | null;
	mcp_tools: string | null;
	models: string | null;
	overlay_root: string | null;
	online_at: string | null;
	modified_at: string;
	platforms: string | null;
}

/**
 * Object format for hosts.models entries. Carries capability metadata alongside the
 * model ID. The legacy string format (plain model ID) is parsed by relay-router.ts
 * without capability metadata (treated as "unverified").
 */
/**
 * Mirror of Partial<BackendCapabilities> from @bound/llm — defined inline here to avoid
 * a circular dependency (shared cannot import from llm). If BackendCapabilities gains new
 * fields, this inline type MUST be updated to match. TypeScript's structural typing keeps
 * them compatible at usage sites even without a shared reference.
 */
export interface HostModelEntry {
	id: string;
	tier?: number;
	capabilities?: {
		streaming?: boolean;
		tool_use?: boolean;
		system_prompt?: boolean;
		prompt_caching?: boolean;
		vision?: boolean;
		max_context?: number;
	};
}

export interface OverlayIndexEntry {
	id: string;
	site_id: string;
	path: string;
	size_bytes: number;
	content_hash: string | null;
	indexed_at: string;
	deleted: number;
}

export interface ClusterConfigEntry {
	key: string;
	value: string;
	modified_at: string;
}

export interface ChangeLogEntry {
	hlc: string;
	table_name: SyncedTableName;
	row_id: string;
	site_id: string;
	timestamp: string;
	row_data: string;
}

export interface SyncState {
	peer_site_id: string;
	last_received: string;
	last_sent: string;
	last_sync_at: string | null;
	sync_errors: number;
}

export interface HostMeta {
	key: string;
	value: string;
}

export interface Advisory {
	id: string;
	type: AdvisoryType;
	status: AdvisoryStatus;
	title: string;
	detail: string;
	action: string | null;
	impact: string | null;
	evidence: string | null;
	proposed_at: string;
	defer_until: string | null;
	resolved_at: string | null;
	created_by: string | null;
	modified_at: string;
}

export interface Skill {
	id: string;
	name: string;
	description: string;
	status: SkillStatus;
	skill_root: string;
	content_hash: string | null;
	allowed_tools: string | null;
	compatibility: string | null;
	metadata_json: string | null;
	activated_at: string | null;
	created_by_thread: string | null;
	activation_count: number;
	last_activated_at: string | null;
	retired_by: string | null;
	retired_reason: string | null;
	modified_at: string;
}

export interface MemoryEdge {
	id: string;
	source_key: string;
	target_key: string;
	relation: string;
	weight: number;
	created_at: string;
	modified_at: string;
	deleted: number;
}

/** Maximum file size (in bytes) for storage in the synced files table. */
export const MAX_FILE_STORAGE_BYTES = 50 * 1024 * 1024; // 50 MB

export const TABLE_REDUCER_MAP: Record<SyncedTableName, ReducerType> = {
	users: "lww",
	threads: "lww",
	messages: "append-only",
	semantic_memory: "lww",
	tasks: "lww",
	files: "lww",
	hosts: "lww",
	overlay_index: "lww",
	cluster_config: "lww",
	advisories: "lww",
	skills: "lww",
	memory_edges: "lww",
	// turns are append-only facts about what the model did on a given host.
	// Recorded once when the turn completes; never mutated after insert except
	// for local-only columns (context_debug, relay_target, relay_latency_ms)
	// that are excluded from replicated row_data. See metrics-schema.ts and
	// bound_issue:turns-table:observability-gap for the full story.
	turns: "append-only",
};

// --- Relay transport types (local-only, not synced) ---

/**
 * Relay dispatch modes (CQRS-inspired):
 *
 * - "sync":     Query-like. Returns results in the same HTTP response during
 *               the sync relay phase. Only used for MCP-style request/response
 *               tool calls. Handled by executeImmediate() on the hub.
 *
 * - "async":    Command-like. Fire-and-forget. Inserted into relay_inbox and
 *               processed by the relay processor's periodic tick via
 *               processEntry(). Results (if any) travel back as separate
 *               response-kind entries.
 *
 * - "response": Callback from a prior request. Inserted into relay_inbox for
 *               the polling loop (RELAY_WAIT / RELAY_STREAM) to consume.
 *               Never executed — just stored and read.
 *
 * Adding a new kind? Pick the right dispatch mode here and the routing in
 * routes.ts + relay-processor.ts derives automatically. If you need a handler,
 * add it to RelayProcessor.processEntry() — the exhaustive switch will remind
 * you at compile time if you forget.
 */
export type RelayDispatch = "sync" | "async" | "response";

export interface RelayKindMeta {
	readonly dispatch: RelayDispatch;
}

/** Single source of truth for relay kind definitions and their dispatch mode. */
export const RELAY_KIND_REGISTRY = {
	// Sync request kinds — hub can return results in the same sync response
	tool_call: { dispatch: "sync" },
	resource_read: { dispatch: "sync" },
	prompt_invoke: { dispatch: "sync" },
	cache_warm: { dispatch: "sync" },

	// Async request kinds — fire-and-forget, processed via relay_inbox
	cancel: { dispatch: "async" },
	inference: { dispatch: "async" },
	process: { dispatch: "async" },
	intake: { dispatch: "async" },
	platform_deliver: { dispatch: "async" },
	event_broadcast: { dispatch: "async" },

	// Response kinds — stored in relay_inbox for polling loops
	result: { dispatch: "response" },
	error: { dispatch: "response" },
	stream_chunk: { dispatch: "response" },
	stream_end: { dispatch: "response" },
	status_forward: { dispatch: "response" },
} as const satisfies Record<string, RelayKindMeta>;

export type RelayKind = keyof typeof RELAY_KIND_REGISTRY;

// Derived arrays and types — kept for backward compat with existing code
export const RELAY_REQUEST_KINDS = (
	Object.entries(RELAY_KIND_REGISTRY) as [RelayKind, RelayKindMeta][]
)
	.filter(([, meta]) => meta.dispatch !== "response")
	.map(([kind]) => kind);

export const RELAY_RESPONSE_KINDS = (
	Object.entries(RELAY_KIND_REGISTRY) as [RelayKind, RelayKindMeta][]
)
	.filter(([, meta]) => meta.dispatch === "response")
	.map(([kind]) => kind);

export const RELAY_KINDS = Object.keys(RELAY_KIND_REGISTRY) as RelayKind[];

export type RelayRequestKind = {
	[K in RelayKind]: (typeof RELAY_KIND_REGISTRY)[K]["dispatch"] extends "response" ? never : K;
}[RelayKind];
export type RelayResponseKind = {
	[K in RelayKind]: (typeof RELAY_KIND_REGISTRY)[K]["dispatch"] extends "response" ? K : never;
}[RelayKind];

export interface RelayOutboxEntry {
	id: string;
	source_site_id: string;
	target_site_id: string;
	kind: RelayKind;
	ref_id: string | null;
	idempotency_key: string | null;
	stream_id: string | null;
	payload: string;
	created_at: string;
	expires_at: string;
	delivered: number;
}

export interface RelayInboxEntry {
	id: string;
	source_site_id: string;
	kind: RelayKind;
	ref_id: string | null;
	idempotency_key: string | null;
	stream_id: string | null;
	payload: string;
	expires_at: string;
	received_at: string;
	processed: number;
}

export interface RelayMessage {
	id: string;
	target_site_id: string;
	source_site_id: string;
	kind: RelayKind;
	ref_id: string | null;
	idempotency_key: string | null;
	stream_id: string | null;
	payload: string;
	created_at: string;
	expires_at: string;
}

// Request payloads (requester -> target)
export interface ToolCallPayload {
	tool: string;
	args: Record<string, unknown>;
	timeout_ms: number;
}

export interface ResourceReadPayload {
	resource_uri: string;
	timeout_ms: number;
}

export interface PromptInvokePayload {
	prompt_name: string;
	prompt_args: Record<string, unknown>;
	timeout_ms: number;
}

export interface CacheWarmPayload {
	paths: string[];
	timeout_ms: number;
}

// Response payloads (target -> requester)
export interface ResultPayload {
	stdout: string;
	stderr: string;
	exit_code: number;
	execution_ms: number;
}

export interface ErrorPayload {
	error: string;
	retriable: boolean;
}

// Loop delegation payloads (Phase 7)
export interface ProcessPayload {
	thread_id: string;
	message_id: string;
	user_id: string;
	platform: string | null; // null = web UI delegation
}

export interface StatusForwardPayload {
	thread_id: string;
	status: string; // "idle" | "thinking" | "tool_call" | etc.
	detail: string | null; // e.g. tool name
	tokens: number;
}

export interface AttachmentPayload {
	filename: string;
	content_type: string; // MIME type, e.g. "image/jpeg"
	size: number; // bytes
	url: string; // platform CDN URL for download
	description?: string; // optional caption from the platform
}

export interface IntakePayload {
	platform: string;
	platform_event_id: string;
	thread_id: string;
	user_id: string;
	message_id: string;
	content: string;
	attachments?: AttachmentPayload[];
}

export interface PlatformDeliverPayload {
	platform: string;
	thread_id: string;
	message_id: string;
	content: string;
	attachments?: Array<{ filename: string; data: Buffer }>;
}

export interface EventBroadcastPayload {
	event_name: string;
	event_payload: Record<string, unknown>;
	source_host: string;
	event_depth: number;
}

// --- Context Debug Types (Phase 2: Context Debugger) ---

export interface ContextSection {
	name: string;
	tokens: number;
	children?: ContextSection[];
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
	/**
	 * Safety margin (in tokens) subtracted from contextWindow before the truncation
	 * gate fires. Absorbs variance between the cl100k_base estimator and the backend's
	 * real tokenizer. Optional so older context_debug rows (pre-2026-04-26) still parse.
	 */
	safetyMargin?: number;
	/**
	 * contextWindow - safetyMargin. The gate that actually triggers truncation compares
	 * the token estimate against this value, NOT against contextWindow. Optional so older
	 * context_debug rows (pre-2026-04-26) still parse.
	 */
	effectiveBudget?: number;
	totalEstimated: number;
	model: string;
	sections: ContextSection[];
	budgetPressure: boolean;
	truncated: number;
	crossThreadSources?: CrossThreadSource[];
}
