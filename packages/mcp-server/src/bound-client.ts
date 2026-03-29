export class BoundNotRunningError extends Error {
	constructor(url: string) {
		super(`Bound agent is not running at ${url}.`);
		this.name = "BoundNotRunningError";
	}
}

export interface ThreadStatus {
	active: boolean;
	state: string | null;
	detail: string | null;
}

export interface BoundMessage {
	id: string;
	thread_id: string;
	role: string;
	content: string;
	model_id: string | null;
	tool_name: string | null;
	created_at: string;
	modified_at: string | null;
	host_origin: string;
}

export class BoundClient {
	constructor(private readonly baseUrl: string) {}

	async createMcpThread(): Promise<{ thread_id: string }> {
		try {
			const res = await fetch(`${this.baseUrl}/api/mcp/threads`, { method: "POST" });
			if (!res.ok) throw new BoundNotRunningError(this.baseUrl);
			return (await res.json()) as { thread_id: string };
		} catch (e) {
			if (e instanceof BoundNotRunningError) throw e;
			throw new BoundNotRunningError(this.baseUrl);
		}
	}

	async sendMessage(threadId: string, text: string): Promise<void> {
		try {
			const res = await fetch(`${this.baseUrl}/api/threads/${threadId}/messages`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ content: text }),
			});
			if (!res.ok) throw new BoundNotRunningError(this.baseUrl);
		} catch (e) {
			if (e instanceof BoundNotRunningError) throw e;
			throw new BoundNotRunningError(this.baseUrl);
		}
	}

	async getStatus(threadId: string): Promise<ThreadStatus> {
		try {
			const res = await fetch(`${this.baseUrl}/api/threads/${threadId}/status`);
			if (!res.ok) throw new BoundNotRunningError(this.baseUrl);
			return (await res.json()) as ThreadStatus;
		} catch (e) {
			if (e instanceof BoundNotRunningError) throw e;
			throw new BoundNotRunningError(this.baseUrl);
		}
	}

	async getMessages(threadId: string): Promise<BoundMessage[]> {
		try {
			const res = await fetch(`${this.baseUrl}/api/threads/${threadId}/messages`);
			if (!res.ok) throw new BoundNotRunningError(this.baseUrl);
			return (await res.json()) as BoundMessage[];
		} catch (e) {
			if (e instanceof BoundNotRunningError) throw e;
			throw new BoundNotRunningError(this.baseUrl);
		}
	}
}
