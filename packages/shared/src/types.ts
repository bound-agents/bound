export type MessageRole =
	| "user"
	| "assistant"
	| "system"
	| "developer"
	| "alert"
	| "tool_call"
	| "tool_result"
	| "purge";

export type TaskType = "cron" | "deferred" | "event" | "heartbeat" | "consolidation";

export type TaskStatus = "pending" | "claimed" | "running" | "completed" | "failed" | "cancelled";

export type InjectMode = "results" | "status" | "file";

export type AdvisoryType = "cost" | "frequency" | "memory" | "model" | "general";

export type AdvisoryStatus = "proposed" | "approved" | "dismissed" | "deferred" | "applied";

export type MemoryTier = "pinned" | "summary" | "default" | "detail";

export type SyncedTableName =
	| "users"
	| "threads"
	| "messages"
	| "semantic_memory"
	| "tasks"
	| "files"
	| "hosts"
	| "cluster_config"
	| "advisories"
	| "skills"
	| "agents"
	| "memory_edges"
	| "connector_handles"
	| "webhooks"
	| "rss_feeds"
	| "client_sessions"
	| "turns";

export type ReducerType = "lww" | "append-only";

/**
 * Base shape for every synced-table row. All synced tables soft-delete:
 * `deleted = 0` is live, `deleted = 1` is tombstoned (invariant #2 — physical
 * DELETE is forbidden on synced tables). Stored as INTEGER; bun:sqlite reads it
 * back as `number`, so the type is `number` rather than a `0 | 1` literal union
 * to avoid casts at every read boundary.
 */
export interface SoftDeletable {
	deleted: number;
}

export interface User extends SoftDeletable {
	id: string;
	display_name: string;
	platform_ids: string | null;
	first_seen_at: string;
	modified_at: string;
}

export interface Thread extends SoftDeletable {
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
	model_hint: string | null;
	/** #201: NULL = main agent; non-null = auxiliary-agent identity */
	agent_id?: string | null;
	/** #201: dispatching parent thread for aux conversations */
	parent_thread_id?: string | null;
}

export interface Message extends SoftDeletable {
	id: string;
	thread_id: string;
	role: MessageRole;
	content: string;
	model_id: string | null;
	tool_name: string | null;
	created_at: string;
	modified_at: string | null;
	host_origin: string;
	exit_code: number | null;
	metadata: string | null;
}

export interface SemanticMemory extends SoftDeletable {
	id: string;
	key: string;
	value: string;
	source: string | null;
	created_at: string;
	modified_at: string;
	last_accessed_at: string | null;
	tier: MemoryTier;
	/** #201: NULL = main agent; auxiliary-agent namespace partition. */
	agent_id?: string | null;
}

export interface Task extends SoftDeletable {
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
}

export interface Webhook extends SoftDeletable {
	id: string;
	name: string;
	secret: string;
	signature_format: SignatureFormat;
	description: string | null;
	task_id: string;
	thread_id: string;
	created_at: string;
	modified_at: string;
}

/**
 * A polled RSS/Atom feed bound to a thread + event task, mirroring the
 * webhook three-row pattern (feed row + delivery thread + `event` task with
 * `trigger_spec: rss:<name>`). Unlike webhooks (push), feeds are PULLED by
 * the leader-gated poller in @bound/platforms, which writes one passive
 * `rss_intake` relay_inbox row per new item and emits `connector:event` so
 * the scheduler folds items into the task wakeup via buildEventWakeupContent.
 */
export interface RssFeed extends SoftDeletable {
	id: string;
	name: string;
	/** Feed URL (http/https). */
	url: string;
	description: string | null;
	/** Poll cadence in seconds (poller enforces a 60s floor). */
	poll_interval_seconds: number;
	/**
	 * JSON array of item GUIDs already delivered, newest last, capped at
	 * RSS_SEEN_GUIDS_CAP. This is the durable dedup cursor: relay_inbox
	 * idempotency keys are pruned with the inbox, so seen-state must live on
	 * the synced row to survive leader failover without re-delivering the
	 * whole feed.
	 */
	seen_guids: string | null;
	task_id: string;
	thread_id: string;
	created_at: string;
	modified_at: string;
}

/** Cap on the seen_guids dedup window persisted per feed. */
export const RSS_SEEN_GUIDS_CAP = 500;

export type SignatureFormat = "github" | "stripe" | "slack" | "raw" | "none";

export interface AgentFile extends SoftDeletable {
	id: string;
	path: string;
	content: string | null;
	is_binary: number;
	size_bytes: number;
	created_at: string;
	modified_at: string;
	created_by: string | null;
	host_origin: string | null;
}

export interface Host extends SoftDeletable {
	site_id: string;
	host_name: string;
	version: string | null;
	sync_url: string | null;
	mcp_servers: string | null;
	mcp_tools: string | null;
	mcp_tool_annotations: string | null;
	mcp_capabilities: string | null;
	models: string | null;
	online_at: string | null;
	modified_at: string;
	platforms: string | null;
	commit_hash: string | null;
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
	/** Per-response output-token ceiling advertised by the serving backend. */
	max_output_tokens?: number;
	/** Bound-side reasoning transport selected by this host's backend config. */
	thinking_mode?: "tool";
	capabilities?: {
		streaming?: boolean;
		tool_use?: boolean;
		system_prompt?: boolean;
		prompt_caching?: boolean;
		vision?: boolean;
		max_context?: number;
	};
}

export interface ClusterConfigEntry extends SoftDeletable {
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
	/**
	 * Highest HLC this peer has ACKNOWLEDGED receiving from us, advanced ONLY in
	 * handleChangelogAck (never on the optimistic send-side write). This is the
	 * sole anchor authority for delegation range segments: a range may cover a
	 * row only if that row's change_log HLC <= last_confirmed for the consumer.
	 * Distinct from last_sent (optimistic, advanced on send) — see R-UD7/R-UD11
	 * in docs/design/specs/2026-06-29-unified-delegation.md.
	 */
	last_confirmed: string;
	last_sync_at: string | null;
	sync_errors: number;
}

export interface HostMeta {
	key: string;
	value: string;
}

export interface Advisory extends SoftDeletable {
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
	/** Actor that last changed the advisory's state: "agent" or an operator user id. #192 */
	resolved_by: string | null;
	/** Rationale / outcome recorded at the state transition. #192 */
	resolution_note: string | null;
	modified_at: string;
}

export interface Skill extends SoftDeletable {
	id: string;
	name: string;
	description: string;
	skill_root: string;
	content_hash: string | null;
	allowed_tools: string | null;
	compatibility: string | null;
	metadata_json: string | null;
	activated_at: string | null;
	created_by_thread: string | null;
	activation_count: number;
	last_activated_at: string | null;
	modified_at: string;
}

/**
 * A durable, persona-scoped auxiliary-agent identity (#201). Each invocation is
 * ephemeral, but the identity — its persona, tool allowlist, default model, and
 * memory namespace — persists across invocations and syncs cluster-wide (shaped
 * like `Skill`). `retired_at` is domain state (hidden from list/invoke, its
 * namespace still readable to the main agent) and is distinct from `deleted`,
 * the pure sync tombstone. `tools` is a JSON array of allowed tool names, or
 * null for unrestricted (structural denials still apply). `name` is not unique:
 * synced tables can't enforce cluster-wide uniqueness, so dispatch resolves a
 * name to its non-retired/non-deleted definition with a modified_at tiebreak.
 */
export interface Agent extends SoftDeletable {
	id: string;
	name: string;
	persona: string;
	tools: string | null;
	model_hint: string | null;
	retired_at: string | null;
	created_by_thread: string | null;
	created_at: string;
	modified_at: string;
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

export interface MemoryEdge extends SoftDeletable {
	id: string;
	source_key: string;
	target_key: string;
	relation: string;
	weight: number;
	created_at: string;
	modified_at: string;
	/** Optional free-text context for the edge (added via ALTER TABLE migration). */
	context: string | null;
	/** #201: NULL = main agent; edges never cross namespaces. */
	agent_id?: string | null;
}

export interface ConnectorHandleRow extends SoftDeletable {
	id: string;
	server_name: string;
	event_name: string;
	event_args: string; // JSON string of event subscription arguments
	delivery_mode: string; // "push" | "poll"
	cursor: string | null;
	task_id: string | null;
	created_at: string; // ISO 8601
	modified_at: string; // ISO 8601
}

/**
 * client_sessions (synced, LWW): records which host holds the live WS
 * connection (boundless / external BoundClient) subscribed to a thread.
 * Notify/introspect wakeups consult this to route to the host that can
 * supply the thread's client tools (issue #91, invariant #21). One row per
 * (connection_id, thread_id) subscription; `id` is `${connection_id}::${thread_id}`.
 */
export interface ClientSession extends SoftDeletable {
	id: string;
	connection_id: string;
	thread_id: string;
	site_id: string;
	created_at: string; // ISO 8601
	modified_at: string; // ISO 8601
}

export interface Turn extends SoftDeletable {
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
	cluster_config: ClusterConfigEntry;
	advisories: Advisory;
	skills: Skill;
	agents: Agent;
	memory_edges: MemoryEdge;
	connector_handles: ConnectorHandleRow;
	webhooks: Webhook;
	rss_feeds: RssFeed;
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
 * single synced LWW row so an edit on any host propagates everywhere; it is
 * set after initialization via `boundctl set-persona` or `POST /api/persona`.
 */
export const PERSONA_CLUSTER_CONFIG_KEY = "persona";

/**
 * Maximum persona size (in bytes) accepted by the set-persona write surfaces
 * (`boundctl set-persona`, `POST /api/persona`). A backstop against pasting an
 * unbounded blob into a row that ships in full on every changelog frame — a
 * persona is realistically a few KB.
 */
export const MAX_PERSONA_BYTES = 64 * 1024; // 64 KB

/**
 * `cluster_config` key gating unauthenticated webhook creation and delivery
 * (#195). Webhooks may be created with `signature_format: "none"`, which
 * skips HMAC validation entirely — anyone who can reach the sync server's
 * `/webhook/:name` endpoint can trigger the bound task. That is a broad
 * surface for arbitrary external data to reach the agent, so it is gated
 * behind an explicit, operator-controlled kill switch that defaults to
 * disabled (row absent or value !== "true").
 *
 * Checked at two points, both defense-in-depth against the switch being
 * flipped after a `"none"` webhook already exists:
 *  - Webhook create/update (`POST /api/webhooks`, `PATCH /api/webhooks/:id`,
 *    `boundctl webhook create/update`) refuse to set `signature_format:
 *    "none"` while the switch is off.
 *  - Webhook delivery (`handleWebhookRequest`) re-checks the switch live for
 *    every request to a `"none"`-format webhook, so disabling it also stops
 *    delivery to webhooks created while it was on — no restart required.
 */
export const WEBHOOKS_ALLOW_UNAUTHENTICATED_KEY = "webhooks_allow_unauthenticated";

export const TABLE_REDUCER_MAP: Record<SyncedTableName, ReducerType> = {
	users: "lww",
	threads: "lww",
	messages: "append-only",
	semantic_memory: "lww",
	tasks: "lww",
	files: "lww",
	hosts: "lww",
	cluster_config: "lww",
	advisories: "lww",
	skills: "lww",
	agents: "lww",
	memory_edges: "lww",
	connector_handles: "lww",
	webhooks: "lww",
	rss_feeds: "lww",
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

	// Client-tool request — relays a client (boundless/WS) tool call to the host
	// holding the thread's live WS session, so the loop can run on ANY host and
	// still serve client tools (R-UD5/R-UD8). The session host enqueues the call
	// into its local WS dispatch, awaits the client's execution, and returns a
	// `client_result`. async (not sync): the client may take arbitrarily long to
	// execute, so the result returns out-of-band via relay_inbox polling.
	client_tool: { dispatch: "async" },

	// Async request kinds — fire-and-forget, processed via relay_inbox
	cancel: { dispatch: "async" },
	inference: { dispatch: "async" },
	// Transport-sized pieces of one serialized inference request. The receiver
	// reassembles all parts before invoking the normal inference handler.
	inference_part: { dispatch: "async" },
	intake: { dispatch: "async" },

	// Notification wakeup routed to the thread's live WS-session host (#91
	// regression under unified delegation). dispatch_queue is local-only, so a
	// notify/introspect enqueued where it was SENT wakes a loop on that host
	// even when the thread's live boundless session (and its active loop) is
	// on another host — two hosts, two loops, one thread. The sender routes
	// the wakeup here instead; the receiving host enqueues into its LOCAL
	// dispatch_queue unconditionally (no re-routing — a churning session row
	// must not ping-pong the wakeup) and wakes the loop beside the session.
	notify_wakeup: { dispatch: "async" },

	// Passive kinds — durable mailbox rows owned by a non-relay-processor
	// consumer. The relay-processor must NOT markProcessed these.
	//
	// `webhook_intake` carries the raw HTTP envelope written by the
	// `/webhook/:name` handler. Its payload shape is
	// {method, path, headers, content_type, body} — distinct from the
	// platform-MCP `intake` shape (intakePayloadSchema).
	webhook_intake: { dispatch: "passive" },

	// `connector_intake` carries a platform push-connector event batch
	// written by `deliverBatch` (packages/platforms). Like `webhook_intake`
	// it is a passive mailbox row owned by the scheduler's event-task wakeup
	// path (buildEventWakeupContent), NOT the relay-processor: it exists so a
	// leader-local connector wakeup carries the triggering event in its
	// tool_result rather than falling back to the bare static task payload.
	// Its payload is the connector's own batch content (opaque to bound),
	// distinct from the platform-MCP `intake` shape (intakePayloadSchema).
	connector_intake: { dispatch: "passive" },

	// `rss_intake` carries one polled RSS/Atom feed item written by the
	// leader-gated RSS poller (@bound/platforms rss-poller.ts). Same passive
	// ownership contract as `webhook_intake`: the scheduler's event-task
	// wakeup path (buildEventWakeupContent) folds + drains it; the
	// relay-processor must leave it untouched. Payload shape is the poller's
	// item envelope {feed, title, link, published, summary} — distinct from
	// both the webhook HTTP envelope and the platform-MCP `intake` schema.
	rss_intake: { dispatch: "passive" },

	// Response kinds — stored in relay_inbox for polling loops
	result: { dispatch: "response" },
	error: { dispatch: "response" },
	// Client-tool result — the session host's response to a `client_tool`
	// request, carrying the executed client tool's output back to the loop that
	// relayed the call. Mirrors `result`/`error` but distinct so the relay-wait
	// stream can correlate it to the originating `client_tool` request.
	client_result: { dispatch: "response" },
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
	timeout_ms: number;
}

export interface PlatformRequestPayload {
	server_name: string;
	method: string;
	params: Record<string, unknown>;
	timeout_ms: number;
}

/**
 * `client_tool` relay request: relays a client (boundless/WS) tool call to the
 * host holding the thread's live WS session. `thread_id` resolves the session
 * host from the synced `client_sessions` table; `call_id` is the tool-call id
 * (the idempotency key for the returned result, R-UD9).
 */
export interface ClientToolPayload {
	thread_id: string;
	call_id: string;
	tool_name: string;
	args: Record<string, unknown>;
	timeout_ms: number;
}

/**
 * `client_result` relay response: the session host's reply to a `client_tool`
 * request, carrying the executed client tool's output (or an error) back to the
 * loop that relayed the call.
 */
export interface ClientResultPayload {
	call_id: string;
	content: string;
	is_error: boolean;
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

/**
 * The SINGLE wire representation of a delegated context (R-UD3). The inference
 * relay payload carries a list of these in place of raw `messages`. There are
 * exactly two shapes:
 *
 *   - `inline` — one fully-assembled message carried verbatim on the wire. The
 *     new tail (the triggering user message, the volatile developer tail, any
 *     unsynced or non-verbatim rows like truncation markers / purge stubs) ships
 *     this way.
 *   - `range` — a pointer to a contiguous, confirmed-synced PREFIX of the
 *     thread's message rows that the consumer rebuilds byte-for-byte by re-running
 *     the same Stage-1 projection finder + annotation the producer used. History
 *     is an append-only prefix, so there is always AT MOST ONE range (R-UD3), and
 *     it never covers a row whose change_log HLC exceeds the consumer's confirmed
 *     watermark (R-UD6) — so the pointed rows are guaranteed present on the
 *     consumer (a missing row is a hard error that cannot happen by construction,
 *     R-UD10).
 *
 * This replaces both the old `messages` inline array and the `messages_file_ref`
 * files-table offload — a single range-pointer is kilobytes regardless of token
 * count, so the >2MB offload race is deleted, not relocated. See
 * docs/design/specs/2026-06-29-unified-delegation.md §3/§4.
 */
export type ContextSegment =
	| {
			kind: "inline";
			/** A fully-assembled LLMMessage, JSON-shaped (driver-agnostic). */
			message: unknown;
	  }
	| {
			kind: "range";
			thread_id: string;
			/**
			 * Inclusive upper bound of the range: the `created_at` of the last
			 * message row the range covers. The consumer loads live message rows
			 * with `created_at <= anchor_created_at` (ASC), takes the leading
			 * `count`, and annotates them. Paired with `count` so a mid-thread
			 * truncation window resolves to exactly the producer's prefix.
			 */
			anchor_created_at: string;
			/**
			 * Number of leading rows (oldest-first) the range covers. The producer's
			 * truncation telescope may drop the very oldest rows; `count` pins the
			 * window so the consumer reproduces the same prefix length.
			 */
			count: number;
	  };

// Loop delegation payloads
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

/**
 * Title-only projection of one R-VC27 relevant-memory entry as it was injected
 * into a turn's volatile tail. Mirrors what `formatRelevantMemoryTitleLine`
 * renders (key + tier/forgotten + recency) without carrying the heavy `value`
 * body, so the persisted `context_debug` row stays compact. Surfaced in the web
 * debugger (#179) so memory tuning can spot relevant — or poor — injections.
 */
export interface RelevantMemoryDebugEntry {
	key: string;
	/** Actual storage tier — where the body lives (what the injected line shows). */
	tier: MemoryTier;
	/** Retrieval-stage tag, e.g. "[graph]" / "[recency]" — how the entry surfaced. */
	tag: string;
	modifiedAt: string;
	/** 1 when soft-deleted; the injected line renders it as `[forgotten]`. Omitted for live entries. */
	deleted?: number;
}

export interface ContextDebugInfo {
	contextWindow: number;
	/**
	 * Safety margin (in tokens) subtracted from contextWindow before the truncation
	 * gate fires. Absorbs variance between the cl100k_base estimator and the backend's
	 * real tokenizer. Optional so older context_debug rows predating this field still parse.
	 */
	safetyMargin?: number;
	/**
	 * contextWindow - safetyMargin. The gate that actually triggers truncation compares
	 * the token estimate against this value, NOT against contextWindow. Optional so older
	 * context_debug rows predating this field still parse.
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
	 * predating this field still parse.
	 */
	actualTotalTokens?: number;
	model: string;
	sections: ContextSection[];
	budgetPressure: boolean;
	truncated: number;
	/**
	 * The LLM-reported finish reason for this turn's response: `"stop"`,
	 * `"length"`, `"tool-calls"`, `"content-filter"`, etc. Recorded so
	 * output-token truncation is queryable from `turns.context_debug`
	 * (`json_extract(context_debug,'$.finishReason')`) instead of requiring
	 * a log grep. A `"length"` value means the model hit its output-token
	 * ceiling and the response was cut off — the signature of the
	 * "streaming interrupted" symptom.
	 *
	 * Optional so older `context_debug` rows predating this field still
	 * parse, and absent on assembly-only snapshots not yet correlated with
	 * a response.
	 */
	finishReason?: string;
	/**
	 * The effective `max_tokens` budget sent to the provider for this turn
	 * (`config.maxOutputTokens`). `undefined` /
	 * absent means no budget was configured and the request OMITTED
	 * `max_tokens`, so the provider applied its own default — which for
	 * Bedrock Converse is 4096, low enough to truncate large
	 * thinking+text turns. Recording it lets a `finishReason: "length"`
	 * row be read together with the budget that produced it.
	 *
	 * Optional so older `context_debug` rows predating this field still parse.
	 */
	maxOutputTokens?: number;
	crossThreadSources?: CrossThreadSource[];
	/**
	 * R-VC27 relevant-memory selection injected into this turn's volatile tail,
	 * title-only (#179). Lets the web debugger show which memories were matched
	 * to a turn — and flag poor ones (e.g. resurfaced `[forgotten]` entries) —
	 * for memory tuning. Omitted on older rows and on paths that match nothing.
	 */
	relevantMemory?: RelevantMemoryDebugEntry[];
	/**
	 * Which assembly path produced this turn's wire payload.
	 *
	 * - `"warm"` — `CachedTurnState` was reused; only the volatile-tail
	 *   developer message and (when caching is supported) a rolling cache
	 *   marker were rebuilt.
	 * - `"cold"` — full `assembleContext()` ran. The next warm turn will
	 *   read this turn's stored state.
	 *
	 * Optional so older `context_debug` rows predating this field still parse.
	 */
	cachePath?: "warm" | "cold";
	/**
	 * Why `cachePath` resolved the way it did. Mirrors the
	 * `[agent-loop] Cache path selected` log line so post-hoc analysis of
	 * cache-thrash threads doesn't require log scraping.
	 *
	 * Cold-side reasons:
	 * - `"no-stored-state"` — first turn on this thread, or warm cache evicted.
	 *   Also covers thread idle past the turn-state store TTL: eviction makes
	 *   getCachedTurnState return undefined, so the long-idle case lands here.
	 * - `"cache-expired"` — RETIRED. Previously set when `predictCacheState()`
	 *   returned `"cold"` while cached state still existed. That heuristic gate
	 *   was removed (it produced frequent false colds on active threads while
	 *   the store TTL already handled idle eviction); no longer emitted. Kept in
	 *   the union so historical `context_debug` rows still parse.
	 * - `"tool-change"` — `computeToolFingerprint` mismatch with cached state.
	 * - `"orphaned-tool-call"` — warm path detected an unanswered `tool_use`
	 *   and bailed so Stage 3 sanitization could synthesize the missing
	 *   `tool_result`. Distinct from `"budget-exceeded"` because the remedy
	 *   is structural, not size-driven.
	 * - `"purge-message"` — the delta contained a purge instruction, requiring
	 *   cold Stage 2 substitution to remove cached targets and insert its summary.
	 * - `"budget-exceeded"` — warm-path estimate exceeded
	 *   `truncationTargetTokens` even after in-place compaction fired (or
	 *   none was applicable).
	 * - `"no-history"` — `noHistory` task threads always cold-assemble.
	 *
	 * Warm-side reasons:
	 * - `"warm-eligible"` — warm path ran to completion within budget.
	 *
	 * Optional so older `context_debug` rows predating this field still parse.
	 */
	cachePathReason?:
		| "no-stored-state"
		| "cache-expired"
		| "tool-change"
		| "orphaned-tool-call"
		| "purge-message"
		| "budget-exceeded"
		| "no-history"
		| "warm-eligible";
	/**
	 * Per-thread adaptive truncation target (tokens) resolved at the start of
	 * this assembly: `contextWindow - maxOutputTokens` (the exact room the
	 * upcoming model call needs to reserve for its own response), divided by
	 * the EMA of actual/estimated inflation over the recent `turns` lookback
	 * window (clamped so inflation < 1.0 doesn't loosen the gate). Falls back
	 * to the unadjusted base target on threads with insufficient samples.
	 *
	 * Recording it lets us correlate budget-gate decisions with the target
	 * that drove them on the same turn — without it, debugging "why didn't
	 * truncation fire?" requires re-running the EMA computation against
	 * the same row history.
	 *
	 * Replaces the old ratio-based `effectiveTruncationRatio` field (see
	 * `computeBaseTruncationTarget` in context-assembly.ts).
	 * Optional so older `context_debug` rows still parse.
	 */
	truncationTargetTokens?: number;
	/**
	 * The raw inflation EMA (mean of `actual / estimated` over recent valid
	 * turns) that fed into `truncationTargetTokens`. `null` when the
	 * thread has fewer than the minimum sample count and the resolver fell
	 * back to the unadjusted base target. Storing it separately from
	 * `truncationTargetTokens` lets us tell "estimator is accurate" from
	 * "we don't know yet".
	 *
	 * Optional so older `context_debug` rows predating this field still parse.
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
	 * advisories` between them, that's a leak.
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
	ttl: string;
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

/**
 * Name of the sandbox shell tool — the one that runs commands inside the
 * database-backed VFS and dispatches MCP server commands. Single source of
 * truth so the agent-factory registration and the orientation prose that names
 * it (see `buildOrientationBlock` in `packages/agent`) never drift apart. NOT
 * `boundless_bash`, which a boundless session surfaces separately and which
 * targets the host's real working directory rather than the sandbox.
 */
export const SANDBOX_BASH_TOOL_NAME = "bms_bash";

/**
 * Call-id prefix for client tools dispatched from inside a Yard run
 * (`dispatchAwaitableClientTool` in `@bound/agent`). Shared so UI surfaces
 * can recognize Yard-origin dispatches: boundless suppresses the standalone
 * streaming ToolCallCard for these (the Yard execution card already renders
 * the effect as a graph node), and the agent's context pipeline filters the
 * bookkeeping result rows these calls persist.
 */
export const YARD_CLIENT_CALL_ID_PREFIX = "yard-client-";

export type YardExecutionNode =
	| { kind: "run"; depth: number }
	| { kind: "tool"; name: string }
	| { kind: "inference"; model: string };

export type YardExecutionEvent = {
	thread_id: string;
	trace_id: string;
	run_id: string;
	node_id: string;
	parent_id: string | null;
	seq: number;
	phase: "started" | "completed" | "failed";
	node: YardExecutionNode;
	started_at?: string;
	finished_at?: string;
	input_preview?: string;
	/**
	 * Bounded preview of the generator source, carried on the tree-root
	 * started event only. Lets the boundless committed card render the
	 * program (highlighted) without reaching back to the persisted tool_call
	 * row — which the card replaces.
	 */
	program_preview?: string;
	result_preview?: string;
	summary?: string;
	tool_call_id?: string;
};
