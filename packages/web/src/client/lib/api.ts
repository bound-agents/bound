export interface Thread {
	id: string;
	user_id: string;
	interface: "web" | "discord";
	host_origin: string;
	color: number;
	title: string;
	summary: string | null;
	created_at: string;
	last_message_at: string;
}

export interface Message {
	id: string;
	thread_id: string;
	role: string;
	content: string;
	model_id: string | null;
	tool_name: string | null;
	created_at: string;
}

export interface Task {
	id: string;
	type: string;
	status: string;
	trigger_spec: string;
	payload: string | null;
	thread_id: string | null;
	origin_thread_id: string | null;
	claimed_by: string | null;
	next_run_at: string | null;
	last_run_at: string | null;
	run_count: number;
	max_runs: number | null;
	created_at: string;
	created_by: string | null;
	error: string | null;
}

export interface MemoryGraphNode {
	key: string;
	value: string;
	tier: "pinned" | "summary" | "default" | "detail";
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

export interface ContextDebugTurn {
	turn_id: number;
	model_id: string;
	tokens_in: number;
	tokens_out: number;
	context_debug: {
		contextWindow: number;
		totalEstimated: number;
		model: string;
		sections: Array<{
			name: string;
			tokens: number;
			children?: Array<{ name: string; tokens: number }>;
		}>;
		budgetPressure: boolean;
		truncated: number;
		crossThreadSources?: Array<{
			threadId: string;
			title: string;
			color: number;
			messageCount: number;
			lastMessageAt: string;
		}>;
	};
	created_at: string;
}

export interface ApiError {
	error: string;
	details?: unknown;
}

async function fetchJson<T>(url: string, options?: RequestInit): Promise<T> {
	const response = await fetch(url, options);
	if (!response.ok) {
		const error = (await response.json()) as ApiError;
		throw new Error(error.error);
	}
	return response.json() as Promise<T>;
}

export const api = {
	async listThreads(opts?: { includeEmpty?: boolean }): Promise<Thread[]> {
		const qs = opts?.includeEmpty ? "?include_empty=true" : "";
		return fetchJson(`/api/threads${qs}`);
	},

	async createThread(): Promise<Thread> {
		return fetchJson("/api/threads", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({}),
		});
	},

	async getThread(id: string): Promise<Thread> {
		return fetchJson(`/api/threads/${id}`);
	},

	async getTask(id: string): Promise<Task> {
		return fetchJson(`/api/tasks/${id}`);
	},

	async listMessages(threadId: string): Promise<Message[]> {
		return fetchJson(`/api/threads/${threadId}/messages`);
	},

	async getContextDebug(threadId: string): Promise<ContextDebugTurn[]> {
		return fetchJson<ContextDebugTurn[]>(`/api/threads/${threadId}/context-debug`);
	},

	async getMemoryGraph(): Promise<MemoryGraphResponse> {
		return fetchJson<MemoryGraphResponse>("/api/memory/graph");
	},
};
