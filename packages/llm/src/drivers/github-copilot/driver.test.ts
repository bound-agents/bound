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

	it("reports extended_thinking true when the configured model routes to messages", () => {
		const driver = new GitHubCopilotDriver({
			tokenManager,
			model: "claude-sonnet-4.5",
			contextWindow: 200000,
			account,
			fetch: makeFetch({ requests: [] }),
		});
		expect(driver.capabilities().extended_thinking).toBe(true);
	});

	it("reports extended_thinking false when the configured model routes to responses or chat", () => {
		const responses = new GitHubCopilotDriver({
			tokenManager,
			model: "gpt-5.6",
			contextWindow: 200000,
			account,
			fetch: makeFetch({ requests: [] }),
		});
		expect(responses.capabilities().extended_thinking).toBe(false);
		const chat = new GitHubCopilotDriver({
			tokenManager,
			model: "gpt-4.1",
			contextWindow: 128000,
			account,
			fetch: makeFetch({ requests: [] }),
		});
		expect(chat.capabilities().extended_thinking).toBe(false);
	});
});

describe("GitHubCopilotDriver system prompt (Messages route)", () => {
	it("sends the system text in the request body on a Claude turn with a system prompt", async () => {
		const requests: Request[] = [];
		const driver = new GitHubCopilotDriver({
			tokenManager,
			model: "claude-sonnet-4.5",
			contextWindow: 200000,
			account,
			fetch: makeFetch({
				catalog: [{ id: "claude-sonnet-4.5", supported_endpoints: ["/v1/messages"] }],
				requests,
			}),
		});
		// Before the fix this threw synchronously: streamText rejects a role:"system"
		// message without allowSystemInMessages, so the request never left.
		await drain(
			driver.chat({
				system: "You are a careful assistant.",
				messages: [{ role: "user", content: "hi" }],
			}),
		);
		const inf = inferenceRequest(requests);
		expect(new URL(inf.url).pathname).toBe("/v1/messages");
		const body = JSON.parse(await inf.text()) as {
			system?: Array<{ type?: string; text?: string; cache_control?: unknown }> | string;
		};
		const systemText =
			typeof body.system === "string"
				? body.system
				: (body.system ?? []).map((b) => b.text ?? "").join("");
		expect(systemText).toContain("You are a careful assistant.");
	});

	it("carries cache_control on the system block when caching is enabled", async () => {
		const requests: Request[] = [];
		const driver = new GitHubCopilotDriver({
			tokenManager,
			model: "claude-sonnet-4.5",
			contextWindow: 200000,
			account,
			fetch: makeFetch({
				catalog: [{ id: "claude-sonnet-4.5", supported_endpoints: ["/v1/messages"] }],
				requests,
			}),
		});
		await drain(
			driver.chat({
				system: "You are a careful assistant.",
				cache_ttl: "5m",
				messages: [{ role: "user", content: "hi" }],
			}),
		);
		const inf = inferenceRequest(requests);
		const body = JSON.parse(await inf.text()) as {
			system?: Array<{ type?: string; text?: string; cache_control?: unknown }>;
		};
		expect(Array.isArray(body.system)).toBe(true);
		const block = (body.system ?? []).find((b) => (b.text ?? "").includes("careful"));
		expect(block?.cache_control).toBeDefined();
	});
});

describe("GitHubCopilotDriver reasoning effort (Responses route)", () => {
	async function responsesBody(
		params: Parameters<GitHubCopilotDriver["chat"]>[0],
		catalog: unknown[],
	): Promise<Record<string, unknown>> {
		const requests: Request[] = [];
		const driver = new GitHubCopilotDriver({
			tokenManager,
			model: "gpt-5.6",
			contextWindow: 200000,
			account,
			fetch: makeFetch({ catalog, requests }),
		});
		await drain(driver.chat(params));
		const inf = inferenceRequest(requests);
		expect(new URL(inf.url).pathname).toBe("/responses");
		return JSON.parse(await inf.text()) as Record<string, unknown>;
	}

	const gpt56Catalog = [
		{
			id: "gpt-5.6",
			supported_endpoints: ["/responses"],
			capabilities: {
				supports: { reasoning_effort: ["none", "low", "medium", "high", "xhigh", "max"] },
			},
		},
	];

	it("forwards reasoning.effort when the model advertises the value", async () => {
		const body = await responsesBody(
			{ model: "gpt-5.6", effort: "high", messages: [{ role: "user", content: "hi" }] },
			gpt56Catalog,
		);
		const reasoning = body.reasoning as { effort?: string } | undefined;
		expect(reasoning?.effort).toBe("high");
		// store:false + encrypted_content ride inline so replayed reasoning works.
		expect(body.store).toBe(false);
		expect(body.include).toContain("reasoning.encrypted_content");
	});

	it("omits reasoning.effort when no effort is requested", async () => {
		const body = await responsesBody(
			{ model: "gpt-5.6", messages: [{ role: "user", content: "hi" }] },
			gpt56Catalog,
		);
		const reasoning = body.reasoning as { effort?: string } | undefined;
		expect(reasoning?.effort).toBeUndefined();
	});

	it("drops an effort the model does not advertise", async () => {
		const body = await responsesBody(
			{ model: "gpt-5.6", effort: "none", messages: [{ role: "user", content: "hi" }] },
			[
				{
					id: "gpt-5.6",
					supported_endpoints: ["/responses"],
					// list omits "none" → unlisted value dropped
					capabilities: { supports: { reasoning_effort: ["low", "medium", "high"] } },
				},
			],
		);
		const reasoning = body.reasoning as { effort?: string } | undefined;
		expect(reasoning?.effort).toBeUndefined();
	});

	it("maps effort:max to the highest advertised level when max is absent", async () => {
		const body = await responsesBody(
			{ model: "gpt-5.6", effort: "max", messages: [{ role: "user", content: "hi" }] },
			[
				{
					id: "gpt-5.6",
					supported_endpoints: ["/responses"],
					capabilities: { supports: { reasoning_effort: ["low", "medium", "high", "xhigh"] } },
				},
			],
		);
		const reasoning = body.reasoning as { effort?: string } | undefined;
		expect(reasoning?.effort).toBe("xhigh");
	});

	it("maps thinking disabled to effort:none when the model advertises none", async () => {
		const body = await responsesBody(
			{
				model: "gpt-5.6",
				thinking: { type: "disabled" },
				messages: [{ role: "user", content: "hi" }],
			},
			gpt56Catalog,
		);
		const reasoning = body.reasoning as { effort?: string } | undefined;
		expect(reasoning?.effort).toBe("none");
	});
});

describe("GitHubCopilotDriver reasoning effort (Chat route)", () => {
	it("forwards reasoning_effort on chat completions when the model advertises it", async () => {
		const requests: Request[] = [];
		const driver = new GitHubCopilotDriver({
			tokenManager,
			model: "gemini-2.5-pro",
			contextWindow: 128000,
			account,
			fetch: makeFetch({
				catalog: [
					{
						id: "gemini-2.5-pro",
						supported_endpoints: ["/chat/completions"],
						capabilities: { supports: { reasoning_effort: ["low", "medium", "high"] } },
					},
				],
				requests,
			}),
		});
		await drain(
			driver.chat({
				model: "gemini-2.5-pro",
				effort: "medium",
				messages: [{ role: "user", content: "hi" }],
			}),
		);
		const inf = inferenceRequest(requests);
		expect(new URL(inf.url).pathname).toBe("/chat/completions");
		const body = JSON.parse(await inf.text()) as { reasoning_effort?: string };
		expect(body.reasoning_effort).toBe("medium");
	});

	it("omits reasoning_effort on chat completions when no effort resolves", async () => {
		const requests: Request[] = [];
		const driver = new GitHubCopilotDriver({
			tokenManager,
			model: "gpt-4.1",
			contextWindow: 128000,
			account,
			fetch: makeFetch({ catalog: [], requests }),
		});
		await drain(driver.chat({ model: "gpt-4.1", messages: [{ role: "user", content: "hi" }] }));
		const inf = inferenceRequest(requests);
		const body = JSON.parse(await inf.text()) as { reasoning_effort?: string };
		expect(body.reasoning_effort).toBeUndefined();
	});
});
