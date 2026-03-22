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
	async listThreads(): Promise<Thread[]> {
		return fetchJson("/api/threads");
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

	async listMessages(threadId: string): Promise<Message[]> {
		return fetchJson(`/api/threads/${threadId}/messages`);
	},

	async sendMessage(threadId: string, content: string, modelId?: string): Promise<Message> {
		const body: Record<string, string> = { content };
		if (modelId) body.model_id = modelId;
		return fetchJson(`/api/threads/${threadId}/messages`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(body),
		});
	},
};
