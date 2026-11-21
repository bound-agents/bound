import { describe, expect, it } from "bun:test";
import type { CopilotAccountInfo } from "./auth-core";
import { GitHubCopilotDriver, messagesHaveImages } from "./driver";
import type { CopilotTokenManager } from "./token-store";

const account: CopilotAccountInfo = {
	chatEnabled: true,
	copilotPlan: "individual",
	apiEndpoint: "https://api.individual.githubcopilot.com",
};

const tokenManager = {
	getAccessToken: async () => "ghu_abc",
} as unknown as CopilotTokenManager;

/** A minimal Anthropic Messages SSE the @ai-sdk/anthropic parser accepts. */
function messagesSse(): Response {
	const events = [
		`event: message_start\ndata: ${JSON.stringify({
			type: "message_start",
			message: {
				id: "msg_1",
				type: "message",
				role: "assistant",
				model: "claude-sonnet-4.5",
				content: [],
				stop_reason: null,
				usage: { input_tokens: 3, output_tokens: 0 },
			},
		})}`,
		`event: content_block_start\ndata: ${JSON.stringify({
			type: "content_block_start",
			index: 0,
			content_block: { type: "text", text: "" },
		})}`,
		`event: content_block_delta\ndata: ${JSON.stringify({
			type: "content_block_delta",
			index: 0,
			delta: { type: "text_delta", text: "hi" },
		})}`,
		`event: content_block_stop\ndata: ${JSON.stringify({ type: "content_block_stop", index: 0 })}`,
		`event: message_delta\ndata: ${JSON.stringify({
			type: "message_delta",
			delta: { stop_reason: "end_turn" },
			usage: { output_tokens: 1 },
		})}`,
		`event: message_stop\ndata: ${JSON.stringify({ type: "message_stop" })}`,
	].join("\n\n");
	return new Response(`${events}\n\n`, {
		status: 200,
		headers: { "content-type": "text/event-stream" },
	});
}

/** A minimal /responses SSE the @ai-sdk/openai Responses parser accepts. */
function responsesSse(modelId: string): Response {
	const events = [
		`event: response.created\ndata: ${JSON.stringify({
			type: "response.created",
			response: { id: "resp_1", model: modelId },
		})}`,
		`event: response.completed\ndata: ${JSON.stringify({
			type: "response.completed",
			response: {
				id: "resp_1",
				model: modelId,
				status: "completed",
				usage: {
					input_tokens: 3,
					input_tokens_details: { cached_tokens: 0 },
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

/** A chat-completions SSE the @ai-sdk/openai .chat parser accepts. */
function chatSse(modelId: string): Response {
	const events = [
		JSON.stringify({
			id: "c1",
			object: "chat.completion.chunk",
			model: modelId,
			choices: [{ index: 0, delta: { role: "assistant", content: "hi" }, finish_reason: null }],
		}),
		JSON.stringify({
			id: "c1",
			object: "chat.completion.chunk",
			model: modelId,
			choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
			usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 },
		}),
		"[DONE]",
	]
		.map((d) => `data: ${d}`)
		.join("\n\n");
	return new Response(`${events}\n\n`, {
		status: 200,
		headers: { "content-type": "text/event-stream" },
	});
}

/**
 * A fake fetch that answers the control-plane routes (/models, /auto) and routes
 * inference by URL + records every request for assertions.
 */
function makeFetch(opts: {
	catalog?: unknown[];
	auto?: { session_token: string; selected_model: { id: string }; expires_at: number };
	requests: Request[];
}): typeof fetch {
	return (async (input: RequestInfo | URL, init?: RequestInit) => {
		const req = new Request(input, init);
		opts.requests.push(req);
		const url = new URL(req.url);
		if (url.pathname.endsWith("/models")) {
			return new Response(JSON.stringify({ data: opts.catalog ?? [] }), {
				status: 200,
				headers: { "content-type": "application/json" },
			});
		}
		if (url.pathname.endsWith("/auto")) {
			return new Response(JSON.stringify(opts.auto ?? {}), {
				status: 200,
				headers: { "content-type": "application/json" },
			});
		}
		if (url.pathname.endsWith("/v1/messages")) return messagesSse();
		if (url.pathname.endsWith("/responses")) return responsesSse("gpt-5.6");
		if (url.pathname.endsWith("/chat/completions")) return chatSse("gpt-4.1");
		return new Response("not found", { status: 404 });
	}) as typeof fetch;
}

async function drain(stream: AsyncIterable<unknown>): Promise<void> {
	for await (const _ of stream) {
		// consume
	}
}

/** Find the single inference request among all recorded requests. */
function inferenceRequest(requests: Request[]): Request {
	const inf = requests.find((r) => {
		const p = new URL(r.url).pathname;
		return (
			p.endsWith("/v1/messages") || p.endsWith("/responses") || p.endsWith("/chat/completions")
		);
	});
	if (!inf) throw new Error("no inference request issued");
	return inf;
}

describe("messagesHaveImages", () => {
	it("detects image and file_ref content blocks", () => {
		expect(messagesHaveImages([{ role: "user", content: "hi" }])).toBe(false);
		expect(
			messagesHaveImages([
				{
					role: "user",
					content: [
						{ type: "text", text: "look" },
						{ type: "image", source: { type: "base64", media_type: "image/png", data: "x" } },
					],
				},
			]),
		).toBe(true);
		expect(
			messagesHaveImages([
				{
					role: "user",
					content: [
						{
							type: "image",
							source: { type: "file_ref", file_id: "f1", media_type: "image/png" },
						},
					],
				},
			]),
		).toBe(true);
	});
});

describe("GitHubCopilotDriver routing", () => {
	it("routes a claude-* model over the Anthropic Messages endpoint with the Bearer and integration id", async () => {
		const requests: Request[] = [];
		const driver = new GitHubCopilotDriver({
			tokenManager,
			model: "claude-sonnet-4.5",
			contextWindow: 200000,
			account,
			fetch: makeFetch({
				catalog: [
					{ id: "claude-sonnet-4.5", supported_endpoints: ["/v1/messages", "/chat/completions"] },
				],
				requests,
			}),
		});
		await drain(driver.chat({ messages: [{ role: "user", content: "hi" }] }));
		const inf = inferenceRequest(requests);
		expect(new URL(inf.url).pathname).toBe("/v1/messages");
		expect(inf.headers.get("authorization")).toBe("Bearer ghu_abc");
		expect(inf.headers.get("copilot-integration-id")).toBe("copilot-developer-cli");
		expect(inf.headers.get("x-api-key")).toBeNull();
		// Latest message is a user turn → initiator user.
		expect(inf.headers.get("x-initiator")).toBe("user");
	});

	it("routes a gpt-5.x model over the Responses endpoint", async () => {
		const requests: Request[] = [];
		const driver = new GitHubCopilotDriver({
			tokenManager,
			model: "gpt-5.6",
			contextWindow: 200000,
			account,
			fetch: makeFetch({
				catalog: [{ id: "gpt-5.6", supported_endpoints: ["/responses"] }],
				requests,
			}),
		});
		await drain(driver.chat({ messages: [{ role: "user", content: "hi" }] }));
		expect(new URL(inferenceRequest(requests).url).pathname).toBe("/responses");
	});

	it("routes a gpt-4.1 model over chat completions and uses the name heuristic when absent from the catalog", async () => {
		const requests: Request[] = [];
		const driver = new GitHubCopilotDriver({
			tokenManager,
			model: "gpt-4.1",
			contextWindow: 128000,
			account,
			fetch: makeFetch({ catalog: [], requests }),
		});
		await drain(driver.chat({ messages: [{ role: "user", content: "hi" }] }));
		expect(new URL(inferenceRequest(requests).url).pathname).toBe("/chat/completions");
	});

	it("sets x-initiator agent when the latest message is a tool result", async () => {
		const requests: Request[] = [];
		const driver = new GitHubCopilotDriver({
			tokenManager,
			model: "gpt-4.1",
			contextWindow: 128000,
			account,
			fetch: makeFetch({ catalog: [], requests }),
		});
		await drain(
			driver.chat({
				messages: [
					{ role: "user", content: "run it" },
					{ role: "assistant", content: [{ type: "tool_use", id: "t1", name: "x", input: {} }] },
					{
						role: "tool_result",
						content: [{ type: "tool_result", tool_use_id: "t1", content: "done" }],
					},
				],
			}),
		);
		expect(inferenceRequest(requests).headers.get("x-initiator")).toBe("agent");
	});

	it("resolves model:auto to the selected model, routes it, and carries the session token", async () => {
		const requests: Request[] = [];
		const driver = new GitHubCopilotDriver({
			tokenManager,
			model: "auto",
			contextWindow: 200000,
			account,
			now: () => 0,
			fetch: makeFetch({
				catalog: [{ id: "mai-code-2-flash", supported_endpoints: ["/responses"] }],
				auto: {
					session_token: "sess-xyz",
					selected_model: { id: "mai-code-2-flash" },
					expires_at: 3600,
				},
				requests,
			}),
		});
		await drain(
			driver.chat({ threadId: "t-1", messages: [{ role: "user", content: "pick one" }] }),
		);
		// The /auto call happened.
		expect(requests.some((r) => new URL(r.url).pathname.endsWith("/auto"))).toBe(true);
		const inf = inferenceRequest(requests);
		expect(new URL(inf.url).pathname).toBe("/responses");
		expect(inf.headers.get("copilot-session-token")).toBe("sess-xyz");
	});

	it("reports vision + prompt_caching capabilities", () => {
		const driver = new GitHubCopilotDriver({
			tokenManager,
			model: "claude-sonnet-4.5",
			contextWindow: 200000,
			account,
			fetch: makeFetch({ requests: [] }),
		});
		const caps = driver.capabilities();
		expect(caps.vision).toBe(true);
		expect(caps.prompt_caching).toBe(true);
		expect(caps.tool_use).toBe(true);
		expect(caps.max_context).toBe(200000);
	});
});
