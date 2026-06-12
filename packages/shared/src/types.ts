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
	| "connector_handles"
	| "webhooks"
	| "client_sessions"
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
	modified_at: string;
	deleted: number;
	model_hint: string | null;
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
	deleted: number;
	exit_code: number | null;
	metadata: string | null;
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
	system_prompt_addition: string | null;
	heartbeat_at: string | null;
	result: string | null;
	error: string | null;
	created_at: string;
	created_by: string | null;
	modified_at: string;
	deleted: number;
}

export interface Webhook {
	id: string;
	name: string;
	secret: string;
	signature_format: SignatureFormat;
	description: string | null;
	task_id: string;
	thread_id: string;
	created_at: string;
	deleted: number;
	modified_at: string;
}

export type SignatureFormat = "github" | "stripe" | "slack" | "raw";

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
	mcp_tool_annotations: string | null;
	mcp_capabilities: string | null;
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
 *
 * The `capabilities` shape mirrors Partial<BackendCapabilities> from @bound/llm, defined
 * inline to avoid a circular dependency. If BackendCapabilities gains new fields, this
 * type MUST be updated to match.
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
	/** Thread the advisory originated from (null for advisories with no source thread). #93 */
	thread_id: string | null;
	modified_at: string;
	deleted: number;
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
	deleted: number;
}

export interface SkillFileEntry {
	path: string;
	content: string;
}

export interface ImportSkillOptions {
	threadId?: string;
}

export type ImportSkillResult =
	| { ok: true; skillId: string; name: string }
	| { ok: false; error: string };

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

export interface ConnectorHandleRow {
	id: string;
	server_name: string;
	event_name: string;
	event_args: string; // JSON string of event subscription arguments
	delivery_mode: string; // "push" | "poll"
	cursor: string | null;
	task_id: string | null;
	created_at: string; // ISO 8601
	deleted: number; // 0 | 1
	modified_at: string; // ISO 8601
}

/**
 * client_sessions (synced, LWW): records which host holds the live WS
 * connection (boundless / external BoundClient) subscribed to a thread.
 * Notify/introspect wakeups consult this to route to the host that can
 * supply the thread's client tools (issue #91, invariant #21). One row per
 * (connection_id, thread_id) subscription; `id` is `${connection_id}::${thread_id}`.
 */
export interface ClientSession {
	id: string;
	connection_id: string;
	thread_id: string;
	site_id: string;
	created_at: string; // ISO 8601
	deleted: number; // 0 | 1
	modified_at: string; // ISO 8601
}

export interface Turn {
	id: string;
	thread_id: string | null;
	task_id: string | null;
	dag_root_id: string | null;
	model_id: string;
	tokens_in: number;
	tokens_out: number;
	tokens_cache_write: number | null;
	tokens_cache_read: number | null;
	cost_usd: number | null;
	created_at: string;
	status: string | null;
	relay_target: string | null;
	relay_latency_ms: number | null;
	context_debug: string | null;
	host_origin: string | null;
	modified_at: string | null;
}

export interface SyncedTableRowMap {
	users: User;
	threads: Thread;
	messages: Message;
	semantic_memory: SemanticMemory;
	tasks: Task;
	files: AgentFile;
	hosts: Host;
	overlay_index: OverlayIndexEntry;
	cluster_config: ClusterConfigEntry;
	advisories: Advisory;
	skills: Skill;
	memory_edges: MemoryEdge;
	connector_handles: ConnectorHandleRow;
	webhooks: Webhook;
	client_sessions: ClientSession;
	turns: Turn;
}

/** Maximum file size (in bytes) for storage in the synced files table. */
export const MAX_FILE_STORAGE_BYTES = 50 * 1024 * 1024; // 50 MB

/**
 * `cluster_config` key under which the synced operator persona lives. The
 * persona was historically a per-host `config/persona.md` file read off disk
 * at context-assembly time, which silently diverged across the cluster (a
 * relayed turn assembled on a peer used that peer's file). It now lives as a
 * single synced LWW row so an edit on any host propagates everywhere; the file
 * survives only as a one-time seed (see the sandbox boot step).
 */
export const PERSONA_CLUSTER_CONFIG_KEY = "persona";

/**
 * Maximum persona size (in bytes) accepted by the set-persona write surfaces
 * (`boundctl set-persona`, `POST /api/persona`). A backstop against pasting an
 * unbounded blob into a row that ships in full on every changelog frame — a
 * persona is realistically a few KB.
 */
export const MAX_PERSONA_BYTES = 64 * 1024; // 64 KB

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
	connector_handles: "lww",
	webhooks: "lww",
	client_sessions: "lww",
	// turns are append-only facts about what the model did on a given host.
	// Recorded once when the turn completes; never mutated after insert except
	// for local-only columns (context_debug, relay_target, relay_latency_ms)
	// that are excluded from replicated row_data.
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
/**
 * Relay-processor dispatch mode for a given relay kind.
 *
 * - "sync": handled synchronously by the relay-processor; result returned in
 *   the same WS exchange.
 * - "async": handled asynchronously by the relay-processor; the row is pulled
 *   from `relay_inbox` and `markProcessed`-ed once a handler completes.
 * - "response": NOT handled by the relay-processor; produced as a callback to
 *   a prior request, consumed elsewhere by RELAY_WAIT polling. The
 *   relay-processor `markProcessed`-es these rows on sight as a cleanup step
 *   (the consumer has already read them by the time the poll loop sees them).
 * - "passive": NOT handled by the relay-processor AND NOT cleaned up by it.
 *   The row is a durable mailbox entry owned by a non-relay-processor
 *   consumer (currently: the scheduler's event-task wakeup path, which reads
 *   webhook envelopes via `buildEventWakeupContent`). The relay-processor
 *   must leave passive rows untouched — `markProcessed`-ing them would steal
 *   the row from the rightful consumer, producing the "agent woke up with
 *   `Execute scheduled task.` and no envelope" symptom observed pre-fix.
 *   Drainage is the consumer's responsibility (scheduler.ts:925 calls
 *   `markProcessed` after the wakeup messages are durably persisted).
 */
export type RelayDispatch = "sync" | "async" | "response" | "passive";

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

	// Platform MCP request — proxies arbitrary MCP protocol requests to a platform server on the target host
	platform_request: { dispatch: "sync" },

	// Async request kinds — fire-and-forget, processed via relay_inbox
	cancel: { dispatch: "async" },
	inference: { dispatch: "async" },
	process: { dispatch: "async" },
	intake: { dispatch: "async" },

	// Passive kinds — durable mailbox rows owned by a non-relay-processor
	// consumer. The relay-processor must NOT markProcessed these.
	//
	// `webhook_intake` carries the raw HTTP envelope written by the
	// `/webhook/:name` handler. Its payload shape is
	// {method, path, headers, content_type, body} — distinct from the
	// platform-MCP `intake` shape (intakePayloadSchema).
	webhook_intake: { dispatch: "passive" },

	// Response kinds — stored in relay_inbox for polling loops
	result: { dispatch: "response" },
	error: { dispatch: "response" },
	stream_chunk: { dispatch: "response" },
	stream_end: { dispatch: "response" },
	status_forward: { dispatch: "response" },
	trace_data: { dispatch: "response" },
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

export const RELAY_PASSIVE_KINDS = (
	Object.entries(RELAY_KIND_REGISTRY) as [RelayKind, RelayKindMeta][]
)
	.filter(([, meta]) => meta.dispatch === "passive")
	.map(([kind]) => kind);

export const RELAY_KINDS = Object.keys(RELAY_KIND_REGISTRY) as RelayKind[];

// RelayRequestKind mirrors RELAY_REQUEST_KINDS — every non-response kind. This
// includes passive kinds because they still flow through the same value-level
// surfaces (e.g. self-targeted-outbox loopback into inbox in
// relay-processor.ts). Consumers that want only the kinds that actually need a
// processEntry handler should use Exclude<RelayRequestKind, "cancel" |
// RelayPassiveKind> — see HandledRequestKind in relay-processor.ts.
export type RelayRequestKind = {
	[K in RelayKind]: (typeof RELAY_KIND_REGISTRY)[K]["dispatch"] extends "response" ? never : K;
}[RelayKind];
export type RelayResponseKind = {
	[K in RelayKind]: (typeof RELAY_KIND_REGISTRY)[K]["dispatch"] extends "response" ? K : never;
}[RelayKind];
export type RelayPassiveKind = {
	[K in RelayKind]: (typeof RELAY_KIND_REGISTRY)[K]["dispatch"] extends "passive" ? K : never;
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
	trace_context: string | null;
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
	trace_context: string | null;
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

export interface PlatformRequestPayload {
	server_name: string;
	method: string;
	params: Record<string, unknown>;
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
	/**
	 * True when the hub or originator can attest that the target tool DEFINITELY
	 * did not execute (e.g. hub fast-fail because target spoke was offline). The
	 * agent loop uses this to retry safely regardless of tool idempotency.
	 *
	 * Leave undefined/false for full timeouts and target-side errors — the
	 * target may have started executing before the failure surfaced.
	 */
	definitely_not_executed?: boolean;
}

// Loop delegation payloads
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
	message_id: string;
	content: string;
	attachments?: AttachmentPayload[];
}

// --- Context Debug Types ---

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
	/**
	 * Actual LLM-reported total input tokens for this turn (input_tokens +
	 * cache_read_tokens + cache_write_tokens). Set post-LLM-call by
	 * applyActualUsageToContextDebug; undefined for assembly-only debug
	 * snapshots that haven't been correlated with an LLM response yet.
	 *
	 * Preserving this separately from totalEstimated lets us compute the
	 * tiktoken-vs-actual inflation ratio per turn, which the adaptive
	 * truncation ratio depends on. Optional so older context_debug rows
	 * (pre-2026-05-22) still parse.
	 */
	actualTotalTokens?: number;
	model: string;
	sections: ContextSection[];
	budgetPressure: boolean;
	truncated: number;
	crossThreadSources?: CrossThreadSource[];
	/**
	 * Which assembly path produced this turn's wire payload.
	 *
	 * - `"warm"` — `CachedTurnState` was reused; only the volatile-tail
	 *   developer message and (when caching is supported) a rolling cache
	 *   marker were rebuilt.
	 * - `"cold"` — full `assembleContext()` ran. The next warm turn will
	 *   read this turn's stored state.
	 *
	 * Optional so older `context_debug` rows (pre-2026-05-25) still parse.
	 */
	cachePath?: "warm" | "cold";
	/**
	 * Why `cachePath` resolved the way it did. Mirrors the
	 * `[agent-loop] Cache path selected` log line so post-hoc analysis of
	 * cache-thrash threads doesn't require log scraping.
	 *
	 * Cold-side reasons:
	 * - `"no-stored-state"` — first turn on this thread, or warm cache evicted.
	 * - `"cache-expired"` — `predictCacheState()` returned `"cold"` (TTL elapsed).
	 * - `"tool-change"` — `computeToolFingerprint` mismatch with cached state.
	 * - `"orphaned-tool-call"` — warm path detected an unanswered `tool_use`
	 *   and bailed so Stage 3 sanitization could synthesize the missing
	 *   `tool_result`. Distinct from `"budget-exceeded"` because the remedy
	 *   is structural, not size-driven.
	 * - `"budget-exceeded"` — warm-path estimate exceeded
	 *   `effectiveTruncationRatio * contextWindow` even after in-place
	 *   compaction fired (or none was applicable).
	 * - `"no-history"` — `noHistory` task threads always cold-assemble.
	 *
	 * Warm-side reasons:
	 * - `"warm-eligible"` — warm path ran to completion within budget.
	 *
	 * Optional so older `context_debug` rows (pre-2026-05-25) still parse.
	 */
	cachePathReason?:
		| "no-stored-state"
		| "cache-expired"
		| "tool-change"
		| "orphaned-tool-call"
		| "budget-exceeded"
		| "no-history"
		| "warm-eligible";
	/**
	 * Per-thread adaptive truncation ratio resolved at the start of this
	 * assembly. `TRUNCATION_TARGET_RATIO` (0.85) divided by the EMA of
	 * actual/estimated inflation over the recent `turns` lookback window
	 * (clamped so inflation < 1.0 doesn't loosen the gate). Falls back to
	 * the base ratio on threads with insufficient samples.
	 *
	 * Recording it lets us correlate budget-gate decisions with the ratio
	 * that drove them on the same turn — without it, debugging "why didn't
	 * truncation fire?" requires re-running the EMA computation against
	 * the same row history.
	 *
	 * Optional so older `context_debug` rows (pre-2026-05-25) still parse.
	 */
	effectiveTruncationRatio?: number;
	/**
	 * The raw inflation EMA (mean of `actual / estimated` over recent valid
	 * turns) that fed into `effectiveTruncationRatio`. `null` when the
	 * thread has fewer than the minimum sample count and the resolver fell
	 * back to the base ratio. Storing it separately from
	 * `effectiveTruncationRatio` lets us tell "estimator is accurate" from
	 * "we don't know yet" — both currently surface as the base ratio.
	 *
	 * Optional so older `context_debug` rows (pre-2026-05-25) still parse.
	 */
	measuredInflation?: number | null;
	/**
	 * Tokens saved by `compactStoredMessagesInPlace` on this warm turn.
	 * `0` when compaction was not invoked (warm path stayed under budget
	 * before compaction was considered). `undefined` on cold turns and on
	 * older rows.
	 *
	 * Visible warm-path compaction is the signal that the high-water gate
	 * fired without forcing a cold rebuild — the prefix stayed byte-stable
	 * and the cache survived. Without this field, that successful path is
	 * indistinguishable from "warm path stayed comfortably under budget".
	 */
	warmCompactionTokensSaved?: number;
	/**
	 * Progressive fidelity tier breakdown. Present on cold-path turns
	 * where tiered truncation fired (totalTokens > effectiveBudget and
	 * the middle tier had messages to fold). Absent on warm turns, on
	 * turns that didn't truncate, and on older rows.
	 */
	progressiveFidelity?: {
		ancientDropped: number;
		middleFolded: number;
		recentKept: number;
		tierBudgets: { ancient: number; middle: number; recent: number };
		tierTokens: { ancient: number; middle: number; recent: number };
	};
	/**
	 * SHA-256 (first 16 hex chars) of the final `systemPrompt` byte
	 * string for this cold rebuild — i.e. the bytes that ride the
	 * system-level cache breakpoint on the wire.
	 *
	 * The drift detector at
	 * `packages/agent/src/validation/run-stable-prefix-drift-validation.ts`
	 * compares consecutive cold rebuilds on the same thread within
	 * the cache TTL window: if `stablePrefixHash` differs but no
	 * change_log row touched `semantic_memory | skills | files |
	 * advisories | overlay_index` between them, that's a leak.
	 *
	 * `undefined` on warm turns (the warm path reuses the cached
	 * `systemPrompt` and recording the hash again would just
	 * duplicate the cold-turn value). `undefined` on rows persisted
	 * before this field was added.
	 */
	stablePrefixHash?: string;
	/**
	 * SHA-256 (first 16 hex chars) of a deterministic
	 * canonicalization of the `StableVolatileInputs` object that fed
	 * `composeStableVolatileSubsection` for this cold rebuild.
	 *
	 * Diagnosis lever: when `stablePrefixHash` differs between two
	 * cold rebuilds but `stablePrefixInputFingerprint` matches, the
	 * divergence cannot have come from a declared input change. By
	 * elimination, the renderer is reading some undeclared signal
	 * (e.g., wall-clock, `process.env`, etc.). That points the
	 * smoking gun straight at `stable-prefix/compose.ts` or its
	 * delegated renderers without needing log scraping.
	 *
	 * `undefined` on warm turns and on older rows.
	 */
	stablePrefixInputFingerprint?: string;
	/**
	 * Cache breakpoint descriptors for this turn. Up to two entries:
	 *
	 * - `kind: "system"` — boundary at the end of the stable system-prompt prefix
	 *   (system + skill-context + volatile-prefix per R-VC24). The system-level
	 *   `cache_control` / `cachePoint` rides this boundary on every turn.
	 * - `kind: "message"` — boundary placed by `maybePlaceCacheMarker` at
	 *   `messages[length - 2]`, just before the volatile-tail developer message.
	 *   `variant: "fixed"` for cold-path placements; `variant: "rolling"` for
	 *   warm-path re-placements.
	 *
	 * `positionTokens` is a cumulative-token offset into the breakdown bar so the
	 * UI can render a tick at the correct percentage of `contextWindow` without
	 * having to re-derive it from `sections`.
	 *
	 * Absent (undefined) on rows persisted before this field was added; absent on
	 * turns where the resolved backend has `prompt_caching: false` and the loop
	 * skipped placement entirely. When the backend supports caching but a marker
	 * was structurally suppressed (e.g., `messages.length < 2`), the loop still
	 * records the descriptor with `capabilityEnabled: true` so the UI can show
	 * the intended position with a disabled state if needed.
	 */
	cacheMarkers?: CacheMarker[];
}

export interface CacheMarker {
	kind: "system" | "message";
	/**
	 * Cumulative-token offset (0..contextWindow) at the breakpoint boundary,
	 * measured against the same totals shown in the breakdown bar. The UI
	 * converts to a percentage as `positionTokens / contextWindow`.
	 *
	 * - System markers: sum of `system + skill-context + volatile-prefix` section tokens.
	 * - Message markers: above plus `history.tokens` (the boundary sits just before
	 *   the volatile-tail developer message).
	 */
	positionTokens: number;
	/**
	 * `"fixed"` for cold-path placements (the marker is part of a freshly assembled
	 * prefix and seeds a write); `"rolling"` for warm-path placements (the marker
	 * is rewritten each turn just before the volatile tail). System markers are
	 * always `"fixed"` — the system prefix doesn't roll.
	 */
	variant: "fixed" | "rolling";
	/**
	 * Resolved cache TTL for the turn. Sourced from the agent loop's resolved
	 * cache_ttl (per critical invariant #17). Stored on the marker so the UI
	 * can label the tier without re-resolving backend config.
	 */
	ttl: "5m" | "1h";
	/**
	 * `true` when the resolved backend's `prompt_caching` capability is on AND
	 * a marker was actually emitted on the wire. `false` when caching was
	 * gated out (e.g., MiniMax on Bedrock). The UI renders disabled markers
	 * as informational ticks only.
	 */
	capabilityEnabled: boolean;
}

/** Minimal shape for commands displayed in the agent's orientation block. */
export interface CommandRegistryEntry {
	readonly name: string;
	readonly description: string;
}
