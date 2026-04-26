import type { Advisory, AdvisoryStatus, AgentFile, Message, Task, Thread } from "@bound/shared";
import { z } from "zod";
import type {
	AdvisoryCount,
	ApiErrorBody,
	BoundClientEvents,
	CancelResult,
	ContextDebugTurn,
	CreateMcpThreadResult,
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

	private async fetchJson<T>(path: string, options?: RequestInit): Promise<T> {
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

	connect(): void {
		if (this.ws) return;
		this.shouldReconnect = true;
		this.createConnection();
	}

	disconnect(): void {
		this.shouldReconnect = false;
		if (this.reconnectTimer) {
			clearTimeout(this.reconnectTimer);
			this.reconnectTimer = null;
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

	private createConnection(): void {
		// Handle case where WebSocket is not available (e.g., in tests)
		if (typeof WebSocket === "undefined") {
			return;
		}

		const ws = new WebSocket(this.wsUrl);

		ws.onopen = () => {
			this.reconnectAttempt = 0;
			this.sendSessionConfigure();
			this.resendSubscriptions();
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
				this.toolCallHandler(toolCall)
					.then((result) => {
						this.sendWsMessage({ type: "tool:result", ...result });
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

	async listThreads(opts?: { includeEmpty?: boolean }): Promise<ThreadListEntry[]> {
		const qs = opts?.includeEmpty ? "?include_empty=true" : "";
		return this.fetchJson(`/api/threads${qs}`);
	}

	async createThread(): Promise<Thread> {
		return this.fetchJson("/api/threads", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({}),
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

	sendMessage(threadId: string, content: string, options?: SendMessageOptions): void {
		const msg: Record<string, unknown> = {
			type: "message:send",
			thread_id: threadId,
			content,
		};
		if (options?.modelId) msg.model_id = options.modelId;
		if (options?.fileId) msg.file_ids = [options.fileId];
		this.sendWsMessage(msg);
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

	async getTask(id: string): Promise<Task> {
		return this.fetchJson(`/api/tasks/${id}`);
	}

	async cancelTask(id: string): Promise<Task> {
		return this.fetchJson(`/api/tasks/${id}/cancel`, { method: "POST" });
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
}
