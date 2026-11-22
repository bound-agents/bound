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
		// Codex client parity (codex-rs/codex-api/src/requests/headers.rs
		// build_session_headers): every Responses request pins the session
		// identity headers alongside the body prompt_cache_key.
		expect(request.headers.get("session-id")).toBe("thread-123");
		expect(request.headers.get("thread-id")).toBe("thread-123");
		// Markers must NOT ride this surface — the field is not on the codex
		// allowlist and would 400 like temperature/top_p do.
		expect(JSON.stringify(body)).not.toContain("prompt_cache_breakpoint");
	});

	it("omits the cache key and session headers when no threadId is present", async () => {
		const { request, body } = await captureChat({});
		expect("prompt_cache_key" in body).toBe(false);
		expect(request.headers.get("session-id")).toBeNull();
		expect(request.headers.get("thread-id")).toBeNull();
	});
});

/** A /responses SSE whose assistant turn carries an encrypted-reasoning item. */
function responsesSseWithEncryptedReasoning(): Response {
	const events = [
		`event: response.created\ndata: ${JSON.stringify({
			type: "response.created",
			response: { id: "resp_1", model: "gpt-6-astra" },
		})}`,
		`event: response.output_item.added\ndata: ${JSON.stringify({
			type: "response.output_item.added",
			output_index: 0,
			item: { type: "reasoning", id: "rs_1", summary: [] },
		})}`,
		`event: response.output_item.done\ndata: ${JSON.stringify({
			type: "response.output_item.done",
			output_index: 0,
			item: {
				type: "reasoning",
				id: "rs_1",
				summary: [],
				encrypted_content: "ENC-codex",
			},
		})}`,
		`event: response.output_item.added\ndata: ${JSON.stringify({
			type: "response.output_item.added",
			output_index: 1,
			item: { type: "message", id: "msg_1", role: "assistant", content: [] },
		})}`,
		`event: response.content_part.added\ndata: ${JSON.stringify({
			type: "response.content_part.added",
			item_id: "msg_1",
			output_index: 1,
			content_index: 0,
			part: { type: "output_text", text: "" },
		})}`,
		`event: response.output_text.delta\ndata: ${JSON.stringify({
			type: "response.output_text.delta",
			item_id: "msg_1",
			output_index: 1,
			content_index: 0,
			delta: "answer",
		})}`,
		`event: response.output_text.done\ndata: ${JSON.stringify({
			type: "response.output_text.done",
			item_id: "msg_1",
			output_index: 1,
			content_index: 0,
			text: "answer",
		})}`,
		`event: response.output_item.done\ndata: ${JSON.stringify({
			type: "response.output_item.done",
			output_index: 1,
			item: {
				type: "message",
				id: "msg_1",
				role: "assistant",
				content: [{ type: "output_text", text: "answer" }],
			},
		})}`,
		`event: response.completed\ndata: ${JSON.stringify({
			type: "response.completed",
			response: {
				id: "resp_1",
				model: "gpt-6-astra",
				status: "completed",
				usage: {
					input_tokens: 3,
					input_tokens_details: { cached_tokens: 0 },
					output_tokens: 1,
					output_tokens_details: { reasoning_tokens: 1 },
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

function encryptedReasoningRejection(): Response {
	return new Response(
		JSON.stringify({
			error: {
				message:
					"The encrypted content rsn_abc could not be verified. Reason: Encrypted content could not be decrypted or parsed.",
				type: "invalid_request_error",
			},
		}),
		{ status: 400, headers: { "content-type": "application/json" } },
	);
}

async function collect(
	it: AsyncIterable<{ type: string; content?: string }>,
): Promise<{ type: string; content?: string }[]> {
	const out: { type: string; content?: string }[] = [];
	for await (const chunk of it) out.push(chunk);
	return out;
}

describe("ChatGptOAuthDriver encrypted-reasoning provenance (cross-provider)", () => {
	// gpt-5.6-sol is served on this host by chatgpt-oauth (Codex) and on another
	// host by bedrock-mantle. Encrypted reasoning does not cross providers:
	// replaying a Mantle blob into Codex 400s, and vice versa. Three layers under
	// test: (1) stamp minted encrypted reasoning with this deployment's origin;
	// (2) drop a replayed block whose origin is foreign; (3) strip-and-retry once
	// on a provider rejection.
	const siteId = "codex-host";
	const mintedOrigin = `${siteId}:chatgpt-oauth`;

	it("stamps minted encrypted reasoning with this deployment's origin", async () => {
		let request: Request | undefined;
		const driver = new ChatGptOAuthDriver({
			tokenManager,
			model: "gpt-6-astra",
			contextWindow: 700_000,
			siteId,
			fetch: async (input, init) => {
				request = new Request(input as RequestInfo, init);
				return responsesSseWithEncryptedReasoning();
			},
		});
		const out = await collect(
			driver.chat({ messages: [{ role: "user", content: "hello" }] }) as AsyncIterable<{
				type: string;
				content?: string;
			}>,
		);
		if (!request) throw new Error("no request issued");
		// The reasoning-end chunk carries both the encrypted blob and the origin.
		const thinking = (out as Array<Record<string, unknown>>).find(
			(c) => c.type === "thinking" && c.reasoning_encrypted_content,
		);
		expect(thinking?.reasoning_encrypted_content).toBe("ENC-codex");
		expect(thinking?.reasoning_origin).toBe(mintedOrigin);
	});

	it("drops a replayed block whose origin was minted on a DIFFERENT provider", async () => {
		let body = "";
		const driver = new ChatGptOAuthDriver({
			tokenManager,
			model: "gpt-6-astra",
			contextWindow: 700_000,
			siteId,
			fetch: async (input, init) => {
				const req = new Request(input as RequestInfo, init);
				body = await req.clone().text();
				return responsesSse();
			},
		});
		await collect(
			driver.chat({
				messages: [
					{ role: "user", content: "ask" },
					{
						role: "assistant",
						content: [
							{
								type: "thinking",
								thinking: "",
								reasoning_encrypted_content: "ENC-from-mantle",
								reasoning_origin: "mantle-host:bedrock-mantle:us-east-2:openai_responses",
							},
							{ type: "text", text: "prior" },
						],
					},
					{ role: "user", content: "next" },
				],
			}) as AsyncIterable<{ type: string; content?: string }>,
		);
		// The foreign Mantle blob must be gone from the Codex request body.
		expect(body).not.toContain("ENC-from-mantle");
	});

	it("retries once with encrypted reasoning stripped on a provider rejection", async () => {
		const bodies: string[] = [];
		let call = 0;
		const driver = new ChatGptOAuthDriver({
			tokenManager,
			model: "gpt-6-astra",
			contextWindow: 700_000,
			siteId,
			fetch: async (input, init) => {
				const req = new Request(input as RequestInfo, init);
				bodies.push(await req.clone().text());
				call++;
				return call === 1 ? encryptedReasoningRejection() : responsesSseWithEncryptedReasoning();
			},
		});
		// A same-origin block (minted here) survives layer-1; the rejection then
		// forces the layer-2 strip, so the retry body is free of the blob.
		const out = await collect(
			driver.chat({
				messages: [
					{ role: "user", content: "ask" },
					{
						role: "assistant",
						content: [
							{
								type: "thinking",
								thinking: "",
								reasoning_encrypted_content: "ENC-local",
								reasoning_origin: mintedOrigin,
							},
							{ type: "text", text: "prior" },
						],
					},
					{ role: "user", content: "next" },
				],
			}) as AsyncIterable<{ type: string; content?: string }>,
		);
		expect(call).toBe(2);
		// First body replays the same-origin blob (kept by layer 1); the stripped
		// retry drops it.
		expect(bodies[0]).toContain("ENC-local");
		expect(bodies[1]).not.toContain("ENC-local");
		expect(out.some((c) => c.type === "text" && c.content?.includes("answer"))).toBe(true);
	});
});

describe("ChatGptOAuthDriver.refreshAuth (#285, R-RT13)", () => {
	it("delegates to the token manager's forceRefresh and returns its result", async () => {
		let calls = 0;
		const stub = {
			getAccessToken: async () => ({ accessToken: "access-token", accountId: "acct_123" }),
			forceRefresh: async () => {
				calls++;
				return true;
			},
		} as unknown as TokenManager;
		const driver = new ChatGptOAuthDriver({
			tokenManager: stub,
			model: "gpt-6-astra",
			contextWindow: 700_000,
		});
		expect(await driver.refreshAuth()).toBe(true);
		expect(calls).toBe(1);
	});

	it("propagates a failed refresh (false) so the loop backs off and advises re-login", async () => {
		const stub = {
			getAccessToken: async () => ({ accessToken: "access-token", accountId: "acct_123" }),
			forceRefresh: async () => false,
		} as unknown as TokenManager;
		const driver = new ChatGptOAuthDriver({
			tokenManager: stub,
			model: "gpt-6-astra",
			contextWindow: 700_000,
		});
		expect(await driver.refreshAuth()).toBe(false);
	});
});
