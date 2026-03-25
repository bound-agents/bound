export type MessageRole =
	| "user"
	| "assistant"
	| "system"
	| "alert"
	| "tool_call"
	| "tool_result"
	| "purge";

export type TaskType = "cron" | "deferred" | "event";

export type TaskStatus = "pending" | "claimed" | "running" | "completed" | "failed" | "cancelled";

export type InjectMode = "results" | "status" | "file";

export type AdvisoryType = "cost" | "frequency" | "memory" | "model" | "general";

export type AdvisoryStatus = "proposed" | "approved" | "dismissed" | "deferred" | "applied";

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
	| "advisories";

export type ReducerType = "lww" | "append-only";

export interface User {
	id: string;
	display_name: string;
	discord_id: string | null;
	first_seen_at: string;
	modified_at: string;
	deleted: number;
}

export interface Thread {
	id: string;
	user_id: string;
	interface: "web" | "discord";
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
}

export interface SemanticMemory {
	id: string;
	key: string;
	value: string;
	source: string | null;
	created_at: string;
	modified_at: string;
	last_accessed_at: string | null;
	deleted: number;
}

export interface Task {
	id: string;
	type: TaskType;
	status: TaskStatus;
	trigger_spec: string;
	payload: string | null;
	thread_id: string | null;
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
	seq: number;
	table_name: SyncedTableName;
	row_id: string;
	site_id: string;
	timestamp: string;
	row_data: string;
}

export interface SyncState {
	peer_site_id: string;
	last_received: number;
	last_sent: number;
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
};

// --- Relay transport types (local-only, not synced) ---

export const RELAY_REQUEST_KINDS = [
	"tool_call",
	"resource_read",
	"prompt_invoke",
	"cache_warm",
	"cancel",
] as const;

export const RELAY_RESPONSE_KINDS = ["result", "error"] as const;

export const RELAY_KINDS = [...RELAY_REQUEST_KINDS, ...RELAY_RESPONSE_KINDS] as const;

export type RelayRequestKind = (typeof RELAY_REQUEST_KINDS)[number];
export type RelayResponseKind = (typeof RELAY_RESPONSE_KINDS)[number];
export type RelayKind = (typeof RELAY_KINDS)[number];

export interface RelayOutboxEntry {
	id: string;
	source_site_id: string | null;
	target_site_id: string;
	kind: string;
	ref_id: string | null;
	idempotency_key: string | null;
	payload: string;
	created_at: string;
	expires_at: string;
	delivered: number;
}

export interface RelayInboxEntry {
	id: string;
	source_site_id: string;
	kind: string;
	ref_id: string | null;
	idempotency_key: string | null;
	payload: string;
	expires_at: string;
	received_at: string;
	processed: number;
}

export interface RelayMessage {
	id: string;
	target_site_id: string;
	source_site_id: string;
	kind: string;
	ref_id: string | null;
	idempotency_key: string | null;
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
