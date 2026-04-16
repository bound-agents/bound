import type { Advisory, AdvisoryStatus, AgentFile, Message, Task, Thread } from "@bound/shared";
import { z } from "zod";
import type {
	AdvisoryCount,
	ApiErrorBody,
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

export class BoundClient {
	private readonly baseUrl: string;

	/**
	 * @param baseUrl Base URL for the Bound API. Defaults to "" (empty string)
	 *   for browser usage with relative URLs. Server consumers should pass the
	 *   full URL, e.g. "http://localhost:3001".
	 */
	constructor(baseUrl = "") {
		// Strip trailing slash for consistent path joining
		this.baseUrl = baseUrl.replace(/\/+$/, "");
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

	// ---- Threads ----

	async listThreads(): Promise<ThreadListEntry[]> {
		return this.fetchJson("/api/threads");
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

	async listMessages(threadId: string): Promise<Message[]> {
		return this.fetchJson(`/api/threads/${threadId}/messages`);
	}

	async sendMessage(
		threadId: string,
		content: string,
		options?: SendMessageOptions,
	): Promise<Message> {
		const body: Record<string, unknown> = { content };
		if (options?.modelId) body.model_id = options.modelId;
		if (options?.fileId) body.file_ids = [options.fileId];
		return this.fetchJson(`/api/threads/${threadId}/messages`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(body),
		});
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
