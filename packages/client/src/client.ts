import type { ContentBlock } from "@bound/llm";
import type {
	Advisory,
	AdvisoryStatus,
	AgentFile,
	Message,
	Skill,
	Task,
	Thread,
} from "@bound/shared";
import { injectTraceContext } from "@bound/shared";
import { SpanStatusCode, context, trace } from "@opentelemetry/api";
import { z } from "zod";
import { type ClientTracingSession, createClientTracingSession } from "./tracing.js";
import type {
	AdvisoryCount,
	ApiErrorBody,
	BoundClientEvents,
	CancelResult,
	ConnectionState,
	ContextDebugTurn,
	CreateMcpThreadResult,
	CreateThreadOptions,
	CreateWebhookOptions,
	FileListEntry,
	HostStatus,
	MemoryGraphResponse,
	ModelsResponse,
	NetworkStatus,
	RedactMessageResult,
	RedactThreadResult,
	SendMessageOptions,
	TaskListEntry,
	ThreadListEntry,
	ThreadStatus,
	ToolCallRequest,
	ToolCallResult,
	ToolDefinition,
	UpdateWebhookOptions,
	WebhookCreateResponse,
	WebhookListEntry,
	WebhookRotateResponse,
	WebhookUrlsResponse,
} from "./types.js";

export class BoundNotRunningError extends Error {
	constructor(url: string, options?: { cause?: unknown }) {
		super(`Bound agent is not running at ${url}.`, options);
		this.name = "BoundNotRunningError";
	}
}

export class BoundApiError extends Error {
	readonly status: number;
	readonly details?: unknown;

	constructor(message: string, status: number, details?: unknown) {
		super(message);
		this.name = "BoundApiError";
		this.status = status;
		this.details = details;
	}
}

const threadStatusSchema = z.object({
	active: z.boolean(),
	state: z.string().nullable(),
	detail: z.unknown().nullable(),
	tokens: z.number(),
	model: z.string().nullable(),
});

type EventName = keyof BoundClientEvents;

const RECONNECT_BASE_MS = 1000;
const RECONNECT_MAX_MS = 30_000;

export class BoundClient {
	private readonly baseUrl: string;
	private ws: WebSocket | null = null;
	private readonly wsUrl: string;
	private readonly subscriptions = new Set<string>();
	private clientTools: ToolDefinition[] = [];
	private toolCallHandler: ((call: ToolCallRequest) => Promise<ToolCallResult>) | null = null;
	private readonly listeners = new Map<string, Set<(...args: unknown[]) => void>>();
	private shouldReconnect = false;
	private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
	private reconnectAttempt = 0;
	private configureOptions?: { systemPromptAddition?: string };
	private _connectionState: ConnectionState = "disconnected";
	/**
	 * Long-lived tracing session for the current WS connection. Lazy-initialized
	 * on the first `tool:call` that carries a trace_context, ended on disconnect /
	 * ws.onclose. Holds one `BasicTracerProvider` for the connection's lifetime
	 * so parallel client tool calls under one agent turn share a `boundless.session`
	 * parent (and don't dangle under `web.handle-message` on the server trace).
	 */
	private tracingSession: ClientTracingSession | null = null;

	/** Public read-only accessor for the bound API base URL (trailing slash stripped). */
	getBaseUrl(): string {
		return this.baseUrl;
	}

	/**
	 * @param baseUrl Base URL for the Bound API. Defaults to "" (empty string)
	 *   for browser usage with relative URLs. Server consumers should pass the
	 *   full URL, e.g. "http://localhost:3001".
	 */
	constructor(baseUrl = "") {
		// Strip trailing slash for consistent path joining
		this.baseUrl = baseUrl.replace(/\/+$/, "");

		// Derive WebSocket URL from baseUrl
		if (baseUrl) {
			this.wsUrl = `${baseUrl.replace(/^http/, "ws").replace(/\/+$/, "")}/ws`;
		} else if (typeof window !== "undefined") {
			const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
			this.wsUrl = `${protocol}//${window.location.host}/ws`;
		} else {
			this.wsUrl = "ws://localhost:3001/ws";
		}
	}

	// ---- Internal helpers ----

	private async fetchOk(path: string, options?: RequestInit): Promise<Response> {
		let res: Response;
		try {
			res = await fetch(`${this.baseUrl}${path}`, options);
		} catch (e) {
			throw new BoundNotRunningError(this.baseUrl, { cause: e });
		}
		if (!res.ok) {
			let body: ApiErrorBody | undefined;
			try {
				body = (await res.json()) as ApiErrorBody;
			} catch {
				// Response may not be JSON
			}
			throw new BoundApiError(body?.error ?? `HTTP ${res.status}`, res.status, body?.details);
		}
		return res;
	}

	private async fetchJson<T>(path: string, options?: RequestInit): Promise<T> {
		const res = await this.fetchOk(path, options);
		return res.json() as Promise<T>;
	}

	private async fetchVoid(path: string, options?: RequestInit): Promise<void> {
		let res: Response;
		try {
			res = await fetch(`${this.baseUrl}${path}`, options);
		} catch (e) {
			throw new BoundNotRunningError(this.baseUrl, { cause: e });
		}
		if (!res.ok) {
			let body: ApiErrorBody | undefined;
			try {
				body = (await res.json()) as ApiErrorBody;
			} catch {
				// Response may not be JSON
			}
			throw new BoundApiError(body?.error ?? `HTTP ${res.status}`, res.status, body?.details);
		}
	}

	private postJson(path: string, body?: unknown): Promise<Response> {
		return fetch(`${this.baseUrl}${path}`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: body !== undefined ? JSON.stringify(body) : undefined,
		});
	}

	// ---- WebSocket ----

	/**
	 * Open a WebSocket connection and resolve when the handshake completes.
	 * Rejects on timeout (10 s) or if the socket errors before the first
	 * `open` event.  Subsequent errors are handled by the internal reconnect
	 * loop and do not reject the returned promise.
	 */
	connect(): Promise<void> {
		if (this.ws) return Promise.resolve();
		this.shouldReconnect = true;
		this.createConnection();

		return new Promise<void>((resolve, reject) => {
			const timeout = setTimeout(() => {
				cleanup();
				reject(new Error("Connection timeout"));
			}, 10_000);

			const onOpen = () => {
				cleanup();
				resolve();
			};

			const onError = () => {
				// Only reject on errors that happen before the connection is
				// established.  After the socket opens, errors are non-fatal
				// (the reconnect loop handles them).
				if (this._connectionState !== "connected") {
					cleanup();
					reject(new Error("WebSocket connection failed"));
				}
			};

			const cleanup = () => {
				clearTimeout(timeout);
				this.off("open", onOpen);
				this.off("error", onError);
			};

			this.on("open", onOpen);
			this.on("error", onError);
		});
	}

	disconnect(): void {
		this.shouldReconnect = false;
		if (this.reconnectTimer) {
			clearTimeout(this.reconnectTimer);
			this.reconnectTimer = null;
		}
		// Each `client-tool.execute` ships its serialized span on tool:result via
		// SimpleSpanProcessor at span.end(); there is no trailing parent span to
		// flush. Just shut down the provider so we don't leak it.
		const session = this.tracingSession;
		this.tracingSession = null;
		if (session) {
			session.end();
		}
		if (this.ws) {
			this.ws.close();
			this.ws = null;
		}
	}

	subscribe(threadId: string): void {
		this.subscriptions.add(threadId);
		this.sendWsMessage({ type: "thread:subscribe", thread_id: threadId });
	}

	unsubscribe(threadId: string): void {
		this.subscriptions.delete(threadId);
		this.sendWsMessage({ type: "thread:unsubscribe", thread_id: threadId });
	}

	configureTools(tools: ToolDefinition[], options?: { systemPromptAddition?: string }): void {
		this.clientTools = tools;
		this.configureOptions = options;
		const msg: Record<string, unknown> = { type: "session:configure", tools };
		if (options?.systemPromptAddition !== undefined) {
			msg.systemPromptAddition = options.systemPromptAddition;
		}
		this.sendWsMessage(msg);
	}

	onToolCall(handler: (call: ToolCallRequest) => Promise<ToolCallResult>): void {
		this.toolCallHandler = handler;
	}

	on<E extends EventName>(event: E, handler: BoundClientEvents[E]): void {
		let set = this.listeners.get(event);
		if (!set) {
			set = new Set();
			this.listeners.set(event, set);
		}
		set.add(handler as (...args: unknown[]) => void);
	}

	off<E extends EventName>(event: E, handler: BoundClientEvents[E]): void {
		const set = this.listeners.get(event);
		if (set) {
			set.delete(handler as (...args: unknown[]) => void);
			if (set.size === 0) this.listeners.delete(event);
		}
	}

	/**
	 * Current connection state of the underlying WebSocket. Mirrors the
	 * `connection:state` event but lets callers read a snapshot synchronously
	 * (e.g. on React mount, before any transition events have a chance to fire
	 * for already-attached clients).
	 */
	get connectionState(): ConnectionState {
		return this._connectionState;
	}

	private setConnectionState(state: ConnectionState): void {
		if (this._connectionState === state) return;
		this._connectionState = state;
		this.emit("connection:state", state);
	}

	private createConnection(): void {
		// Handle case where WebSocket is not available (e.g., in tests)
		if (typeof WebSocket === "undefined") {
			return;
		}

		this.setConnectionState("connecting");
		const ws = new WebSocket(this.wsUrl);

		ws.onopen = () => {
			this.reconnectAttempt = 0;
			this.sendSessionConfigure();
			this.resendSubscriptions();
			this.setConnectionState("connected");
			this.emit("open");
		};

		ws.onmessage = (event) => {
			this.handleWsMessage(event.data as string);
		};

		ws.onerror = (event) => {
			this.emit("error", event);
		};

		ws.onclose = () => {
			this.ws = null;
			// End any active tracing session — children have already been shipped per-call.
			// Trailing `boundless.session` span is lost on unclean close (we can't send
			// over a closing socket); the children still group on the session traceID.
			if (this.tracingSession) {
				this.tracingSession.end();
				this.tracingSession = null;
			}
			this.setConnectionState("disconnected");
			this.emit("close");
			if (this.shouldReconnect) {
				this.scheduleReconnect();
			}
		};

		this.ws = ws;
	}

	/** Parse and dispatch a raw WS message. Extracted for testability. */
	handleWsMessage(raw: string): void {
		try {
			const msg = JSON.parse(raw) as {
				type: string;
				data?: unknown;
				[key: string]: unknown;
			};

			// Handle tool:call specially - auto-respond if handler is registered
			if (msg.type === "tool:call" && this.toolCallHandler) {
				const toolCall = msg as unknown as ToolCallRequest;
				const handler = this.toolCallHandler;
				if (!this.tracingSession) {
					this.tracingSession = createClientTracingSession();
				}
				this.tracingSession
					.wrapToolCall(toolCall.trace_context, () => handler(toolCall), {
						toolName: toolCall.tool_name,
					})
					.then(({ result, traceData }) => {
						this.sendWsMessage({
							type: "tool:result",
							...result,
							...(traceData ? { trace_data: traceData } : {}),
						});
					})
					.catch((err) => {
						this.emit("error", {
							code: "TOOL_CALL_ERROR",
							message: String(err),
						});
					});
				return;
			}

			// Handle tool:cancel
			if (msg.type === "tool:cancel") {
				this.emit("tool:cancel", {
					callId: msg.call_id,
					threadId: msg.thread_id,
					reason: msg.reason as string | undefined,
				});
				return;
			}

			// For events that wrap their payload under `data`, unwrap before emitting.
			// The server uses this pattern for: message:created, task:updated,
			// file:updated, context:debug, alert.
			// Events like thread:status use flat format (no `data` wrapper).
			if ("data" in msg) {
				this.emit(msg.type, msg.data);
			} else {
				this.emit(msg.type, msg);
			}
		} catch {
			// Ignore malformed messages
		}
	}

	private emit(event: string, data?: unknown): void {
		const set = this.listeners.get(event);
		if (set) {
			for (const handler of set) {
				handler(data);
			}
		}
	}

	private sendWsMessage(msg: Record<string, unknown>): void {
		if (this.ws && this.ws.readyState === WebSocket.OPEN) {
			this.ws.send(JSON.stringify(msg));
		}
	}

	private sendSessionConfigure(): void {
		if (this.clientTools.length > 0 || this.configureOptions !== undefined) {
			const msg: Record<string, unknown> = { type: "session:configure", tools: this.clientTools };
			if (this.configureOptions?.systemPromptAddition !== undefined) {
				msg.systemPromptAddition = this.configureOptions.systemPromptAddition;
			}
			this.sendWsMessage(msg);
		}
	}

	private resendSubscriptions(): void {
		if (this.subscriptions.size > 0) {
			for (const threadId of this.subscriptions) {
				this.sendWsMessage({ type: "thread:subscribe", thread_id: threadId });
			}
		}
	}

	private scheduleReconnect(): void {
		const delay = Math.min(RECONNECT_BASE_MS * 2 ** this.reconnectAttempt, RECONNECT_MAX_MS);
		// Add jitter: 0.5x to 1.5x of computed delay
		const jitteredDelay = delay * (0.5 + Math.random());
		this.reconnectAttempt++;
		this.reconnectTimer = setTimeout(() => {
			this.reconnectTimer = null;
			this.createConnection();
		}, jitteredDelay);
	}

	// ---- Threads ----

	async listThreads(opts?: {
		includeEmpty?: boolean;
		/**
		 * Maximum number of threads to return. Server caps at 200. Omit to
		 * receive the full set (back-compat default).
		 */
		limit?: number;
		/**
		 * Cursor for the next page. Pass `(last_message_at, id)` of the last
		 * thread from the previous page; the server returns rows strictly
		 * before that cursor in `(last_message_at DESC, id DESC)` order.
		 */
		before?: { last_message_at: string; id: string };
	}): Promise<ThreadListEntry[]> {
		return (await this.listThreadsPage(opts)).threads;
	}

	/**
	 * Like {@link listThreads} but also returns `total` — the server's count
	 * of threads matching the same filter, independent of the cursor/limit
	 * window, read from the `X-Total-Count` response header. Use this when
	 * rendering a "N threads" total alongside a paginated list so the count
	 * reflects the full set rather than the loaded page. Falls back to the
	 * returned page length if the header is missing.
	 */
	async listThreadsPage(opts?: {
		includeEmpty?: boolean;
		limit?: number;
		before?: { last_message_at: string; id: string };
	}): Promise<{ threads: ThreadListEntry[]; total: number }> {
		const params = new URLSearchParams();
		if (opts?.includeEmpty) params.set("include_empty", "true");
		if (opts?.limit !== undefined) params.set("limit", String(opts.limit));
		if (opts?.before) {
			params.set("before_ts", opts.before.last_message_at);
			params.set("before_id", opts.before.id);
		}
		const qs = params.toString();
		const res = await this.fetchOk(`/api/threads${qs ? `?${qs}` : ""}`);
		const threads = (await res.json()) as ThreadListEntry[];
		const headerValue = res.headers.get("X-Total-Count");
		const parsed = headerValue !== null ? Number.parseInt(headerValue, 10) : Number.NaN;
		const total = Number.isFinite(parsed) ? parsed : threads.length;
		return { threads, total };
	}

	/**
	 * Creates a new thread on the connected bound daemon. Callers may tag
	 * the thread with an `interface` value (e.g., "boundless") so the agent
	 * can inject the right platform context on every turn. Omitting the
	 * option results in `interface: "web"`, preserving prior behavior.
	 */
	async createThread(options?: CreateThreadOptions): Promise<Thread> {
		const body: Record<string, unknown> = {};
		if (options?.interface) {
			body.interface = options.interface;
		}
		return this.fetchJson("/api/threads", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(body),
		});
	}

	async createMcpThread(): Promise<CreateMcpThreadResult> {
		return this.fetchJson("/api/mcp/threads", { method: "POST" });
	}

	async getThread(id: string): Promise<Thread> {
		return this.fetchJson(`/api/threads/${id}`);
	}

	async getThreadStatus(id: string): Promise<ThreadStatus> {
		const data = await this.fetchJson(`/api/threads/${id}/status`);
		return threadStatusSchema.parse(data);
	}

	async getContextDebug(threadId: string): Promise<ContextDebugTurn[]> {
		return this.fetchJson(`/api/threads/${threadId}/context-debug`);
	}

	// ---- Messages ----

	async listMessages(threadId: string, options?: { limit?: number }): Promise<Message[]> {
		const params = new URLSearchParams();
		if (options?.limit) params.set("limit", String(options.limit));
		const qs = params.toString();
		return this.fetchJson(`/api/threads/${threadId}/messages${qs ? `?${qs}` : ""}`);
	}

	sendMessage(
		threadId: string,
		content: string | ContentBlock[],
		options?: SendMessageOptions,
	): void {
		// Open a span for the user-facing send so the server-side
		// `web.handle-message` becomes a child of this client root. When OTEL
		// is not initialized the API returns no-op spans and `injectTraceContext`
		// returns null, so the wire shape is unchanged. The span is closed
		// synchronously after writing to the WS — we don't have a useful end
		// signal on the WS protocol, so this span only covers the local
		// preparation and the wire write. Server-side spans inherit the
		// parent context via the injected trace_context carrier.
		const tracer = trace.getTracer("bound.client");
		const span = tracer.startSpan("client.send-message", {
			attributes: {
				"thread.id": threadId,
				"message.content_length": content.length,
				"model.id": options?.modelId ?? "",
			},
		});
		try {
			context.with(trace.setSpan(context.active(), span), () => {
				const traceContext = injectTraceContext();
				const msg: Record<string, unknown> = {
					type: "message:send",
					thread_id: threadId,
					content,
					...(traceContext ? { trace_context: JSON.stringify(traceContext) } : {}),
				};
				if (options?.modelId) msg.model_id = options.modelId;
				if (options?.fileId) msg.file_ids = [options.fileId];
				// Stamp the sender's UTC offset (minutes, east-of-UTC positive) so the
				// server can render the user-message timestamp prefix in local wall-clock.
				// getTimezoneOffset() returns minutes WEST of UTC (positive for west), so
				// negate it. `null` suppresses; a number overrides; undefined auto-derives
				// from the host's local tz (correct for browser + boundless, which run on
				// the user's machine).
				const tzOffset =
					options?.tzOffsetMinutes === undefined
						? -new Date().getTimezoneOffset()
						: options.tzOffsetMinutes;
				if (typeof tzOffset === "number" && Number.isFinite(tzOffset)) {
					msg.tz_offset = tzOffset;
				}
				this.sendWsMessage(msg);
			});
			span.setStatus({ code: SpanStatusCode.OK });
		} catch (err) {
			span.setStatus({
				code: SpanStatusCode.ERROR,
				message: err instanceof Error ? err.message : String(err),
			});
			throw err;
		} finally {
			span.end();
		}
	}

	async redactMessage(threadId: string, messageId: string): Promise<RedactMessageResult> {
		return this.fetchJson(`/api/threads/${threadId}/messages/${messageId}/redact`, {
			method: "POST",
		});
	}

	async redactThread(threadId: string): Promise<RedactThreadResult> {
		return this.fetchJson(`/api/threads/${threadId}/redact`, { method: "POST" });
	}

	// ---- Files ----

	async listFiles(): Promise<FileListEntry[]> {
		return this.fetchJson("/api/files");
	}

	async getFile(path: string): Promise<AgentFile> {
		return this.fetchJson(`/api/files/${path}`);
	}

	async downloadFile(path: string): Promise<Response> {
		const res = await fetch(`${this.baseUrl}/api/files/download?path=${encodeURIComponent(path)}`);
		if (!res.ok) {
			let body: ApiErrorBody | undefined;
			try {
				body = (await res.json()) as ApiErrorBody;
			} catch {
				// noop
			}
			throw new BoundApiError(body?.error ?? `HTTP ${res.status}`, res.status, body?.details);
		}
		return res;
	}

	async uploadFile(file: Blob, filename: string): Promise<AgentFile> {
		const formData = new FormData();
		formData.append("file", file, filename);
		return this.fetchJson("/api/files/upload", {
			method: "POST",
			body: formData,
		});
	}

	// ---- Tasks ----

	async listTasks(options?: { status?: string }): Promise<TaskListEntry[]> {
		const params = new URLSearchParams();
		if (options?.status) params.set("status", options.status);
		const qs = params.toString();
		return this.fetchJson(`/api/tasks${qs ? `?${qs}` : ""}`);
	}

	async getTask(id: string): Promise<TaskListEntry> {
		return this.fetchJson(`/api/tasks/${id}`);
	}

	async cancelTask(id: string): Promise<Task> {
		return this.fetchJson(`/api/tasks/${id}/cancel`, { method: "POST" });
	}

	async updateTask(
		id: string,
		updates: { no_history?: boolean; model_hint?: string; alert_threshold?: number },
	): Promise<Task> {
		return this.fetchJson(`/api/tasks/${id}`, {
			method: "PATCH",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(updates),
		});
	}

	// ---- Advisories ----

	async listAdvisories(options?: { status?: AdvisoryStatus }): Promise<Advisory[]> {
		const params = new URLSearchParams();
		if (options?.status) params.set("status", options.status);
		const qs = params.toString();
		return this.fetchJson(`/api/advisories${qs ? `?${qs}` : ""}`);
	}

	async countAdvisories(): Promise<AdvisoryCount> {
		return this.fetchJson("/api/advisories/count");
	}

	async approveAdvisory(id: string): Promise<Advisory> {
		return this.fetchJson(`/api/advisories/${id}/approve`, { method: "POST" });
	}

	async dismissAdvisory(id: string): Promise<Advisory> {
		return this.fetchJson(`/api/advisories/${id}/dismiss`, { method: "POST" });
	}

	async deferAdvisory(id: string): Promise<Advisory> {
		return this.fetchJson(`/api/advisories/${id}/defer`, { method: "POST" });
	}

	async applyAdvisory(id: string): Promise<Advisory> {
		return this.fetchJson(`/api/advisories/${id}/apply`, { method: "POST" });
	}

	// ---- Webhooks ----

	async listWebhooks(): Promise<WebhookListEntry[]> {
		return this.fetchJson("/api/webhooks");
	}

	async getWebhook(id: string): Promise<WebhookListEntry> {
		return this.fetchJson(`/api/webhooks/${id}`);
	}

	async createWebhook(options: CreateWebhookOptions): Promise<WebhookCreateResponse> {
		return this.fetchJson("/api/webhooks", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(options),
		});
	}

	async updateWebhook(id: string, options: UpdateWebhookOptions): Promise<WebhookListEntry> {
		return this.fetchJson(`/api/webhooks/${id}`, {
			method: "PATCH",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(options),
		});
	}

	async deleteWebhook(id: string): Promise<void> {
		await this.fetchVoid(`/api/webhooks/${id}`, { method: "DELETE" });
	}

	async rotateWebhookSecret(id: string): Promise<WebhookRotateResponse> {
		return this.fetchJson(`/api/webhooks/${id}/rotate`, { method: "POST" });
	}

	/**
	 * Enumerate webhook delivery URLs across the cluster (#36). Returns the
	 * webhook's name and an array of URL entries — hub URL (if this node is
	 * a spoke), local URL(s) from the sync server bind config, and one URL
	 * per peer host with a non-empty `sync_url`.
	 */
	async listWebhookUrls(id: string): Promise<WebhookUrlsResponse> {
		return this.fetchJson(`/api/webhooks/${id}/urls`);
	}

	// ---- Status ----

	async getStatus(): Promise<HostStatus> {
		return this.fetchJson("/api/status");
	}

	async getNetwork(): Promise<NetworkStatus> {
		return this.fetchJson("/api/status/network");
	}

	async listModels(): Promise<ModelsResponse> {
		return this.fetchJson("/api/status/models");
	}

	async cancelThread(threadId: string): Promise<CancelResult> {
		return this.fetchJson(`/api/status/cancel/${threadId}`, { method: "POST" });
	}

	// ---- Memory ----

	async getMemoryGraph(): Promise<MemoryGraphResponse> {
		return this.fetchJson("/api/memory/graph");
	}

	// ---- Skills ----

	async listSkills(options?: { status?: string }): Promise<Skill[]> {
		const params = new URLSearchParams();
		if (options?.status) params.set("status", options.status);
		const qs = params.toString();
		return this.fetchJson(`/api/skills${qs ? `?${qs}` : ""}`);
	}

	async getSkill(
		id: string,
	): Promise<{ skill: Skill; content: string; files: { path: string; size: number }[] }> {
		return this.fetchJson(`/api/skills/${id}`);
	}

	async createSkill(
		data:
			| FormData
			| {
					name: string;
					description: string;
					body: string;
					allowed_tools?: string;
					compatibility?: string;
			  },
	): Promise<{ skill: Skill }> {
		if (data instanceof FormData) {
			return this.fetchJson("/api/skills", {
				method: "POST",
				body: data,
			});
		}
		return this.fetchJson("/api/skills", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(data),
		});
	}

	async updateSkill(
		id: string,
		data: {
			description?: string;
			body?: string;
			allowed_tools?: string;
			compatibility?: string;
		},
	): Promise<{ skill: Skill }> {
		return this.fetchJson(`/api/skills/${id}`, {
			method: "PATCH",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(data),
		});
	}

	async retireSkill(id: string, reason?: string): Promise<{ skill: Skill }> {
		return this.fetchJson(`/api/skills/${id}/retire`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ reason }),
		});
	}

	async activateSkill(id: string): Promise<{ skill: Skill }> {
		return this.fetchJson(`/api/skills/${id}/activate`, {
			method: "POST",
		});
	}
}
