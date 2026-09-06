import { describe, expect, it } from "bun:test";
import { ChatGptOAuthDriver, createChatGptOAuthFetch } from "./driver";
import type { TokenManager } from "./token-store";

describe("createChatGptOAuthFetch", () => {
	it("replaces the SDK sentinel authorization and injects the ChatGPT account headers", async () => {
		let seen: Request | undefined;
		const wrapped = createChatGptOAuthFetch({
			tokenManager: {
				getAccessToken: async () => ({ accessToken: "access-token", accountId: "acct_123" }),
			},
			baseFetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
				seen = new Request(input, init);
				return new Response("ok");
			}) as typeof fetch,
		});

		await wrapped("https://chatgpt.com/backend-api/codex/responses", {
			headers: { Authorization: "Bearer sentinel" },
		});

		expect(seen?.headers.get("authorization")).toBe("Bearer access-token");
		expect(seen?.headers.get("chatgpt-account-id")).toBe("acct_123");
		expect(seen?.headers.get("user-agent")).toBe("bound");
		expect(seen?.headers.get("originator")).toBe("bound");
	});
});

/** Minimal /responses SSE stream the @ai-sdk/openai Responses parser accepts. */
function responsesSse(): Response {
	const events = [
		`event: response.created\ndata: ${JSON.stringify({
			type: "response.created",
			response: { id: "resp_1", model: "gpt-6-astra" },
		})}`,
		`event: response.completed\ndata: ${JSON.stringify({
			type: "response.completed",
			response: {
				id: "resp_1",
				model: "gpt-6-astra",
				status: "completed",
				usage: {
					input_tokens: 3,
					input_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 },
					output_tokens: 1,
					output_tokens_details: { reasoning_tokens: 0 },
					total_tokens: 4,
				},
			},
		})}`,
	].join("\n\n");
	return new Response(`${events}\n\n`, {
		status: 200,
		headers: { "content-type": "text/event-stream" },
	});
}

const tokenManager = {
	getAccessToken: async () => ({ accessToken: "access-token", accountId: "acct_123" }),
} as unknown as TokenManager;

async function captureChat(params: {
	threadId?: string;
}): Promise<{ request: Request; body: Record<string, unknown> }> {
	let request: Request | undefined;
	const driver = new ChatGptOAuthDriver({
		tokenManager,
		model: "gpt-6-astra",
		contextWindow: 700_000,
		fetch: async (input, init) => {
			request = new Request(input as RequestInfo, init);
			return responsesSse();
		},
	});

	for await (const _ of driver.chat({
		...(params.threadId && { threadId: params.threadId }),
		messages: [{ role: "user", content: "hello" }],
	})) {
		// Drain the stream so the injected fetch runs.
	}
	if (!request) throw new Error("provider did not issue a request");
	return { request, body: (await request.clone().json()) as Record<string, unknown> };
}

describe("ChatGptOAuthDriver prompt-cache routing", () => {
	// The codex backend has no prompt_cache_breakpoint field, so cache reuse
	// rides the automatic prefix cache keyed by a session-stable
	// prompt_cache_key — the same mechanism the Codex CLI reference client
	// uses (keyed by conversation session id).
	it("keys the automatic prefix cache by the Bound thread id", async () => {
		const { request, body } = await captureChat({ threadId: "thread-123" });
		expect(body.prompt_cache_key).toBe("thread-123");
		expect(body.store).toBe(false);
		expect(request.headers.get("chatgpt-account-id")).toBe("acct_123");
		// Markers must NOT ride this surface — the field is not on the codex
		// allowlist and would 400 like temperature/top_p do.
		expect(JSON.stringify(body)).not.toContain("prompt_cache_breakpoint");
	});

	it("omits the cache key when no threadId is present", async () => {
		const { body } = await captureChat({});
		expect("prompt_cache_key" in body).toBe(false);
	});
});
