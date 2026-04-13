import { z } from "zod";

export class BoundNotRunningError extends Error {
	constructor(url: string, options?: { cause?: unknown }) {
		super(`Bound agent is not running at ${url}.`, options);
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

const createThreadResponseSchema = z.object({
	thread_id: z.string(),
});

const threadStatusSchema = z.object({
	active: z.boolean(),
	state: z.string().nullable(),
	detail: z.string().nullable(),
});

const boundMessageSchema = z.object({
	id: z.string(),
	thread_id: z.string(),
	role: z.string(),
	content: z.string(),
	model_id: z.string().nullable(),
	tool_name: z.string().nullable(),
	created_at: z.string(),
	modified_at: z.string().nullable(),
	host_origin: z.string(),
});

const messagesResponseSchema = z.array(boundMessageSchema);

export class BoundClient {
	constructor(private readonly baseUrl: string) {}

	async createMcpThread(): Promise<{ thread_id: string }> {
		try {
			const res = await fetch(`${this.baseUrl}/api/mcp/threads`, { method: "POST" });
			if (!res.ok) throw new BoundNotRunningError(this.baseUrl);
			const data = createThreadResponseSchema.parse(await res.json());
			return data;
		} catch (e) {
			if (e instanceof BoundNotRunningError) throw e;
			throw new BoundNotRunningError(this.baseUrl, { cause: e });
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
			throw new BoundNotRunningError(this.baseUrl, { cause: e });
		}
	}

	async getStatus(threadId: string): Promise<ThreadStatus> {
		try {
			const res = await fetch(`${this.baseUrl}/api/threads/${threadId}/status`);
			if (!res.ok) throw new BoundNotRunningError(this.baseUrl);
			const data = threadStatusSchema.parse(await res.json());
			return data;
		} catch (e) {
			if (e instanceof BoundNotRunningError) throw e;
			throw new BoundNotRunningError(this.baseUrl, { cause: e });
		}
	}

	async getMessages(threadId: string): Promise<BoundMessage[]> {
		try {
			const res = await fetch(`${this.baseUrl}/api/threads/${threadId}/messages`);
			if (!res.ok) throw new BoundNotRunningError(this.baseUrl);
			const data = messagesResponseSchema.parse(await res.json());
			return data;
		} catch (e) {
			if (e instanceof BoundNotRunningError) throw e;
			throw new BoundNotRunningError(this.baseUrl, { cause: e });
		}
	}
}
