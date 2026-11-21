import { describe, expect, it } from "bun:test";
import type { CopilotAccountInfo } from "./auth-core";
import { GitHubCopilotDriver, messagesHaveImages, resolveReasoningEffort } from "./driver";
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

async function collectChunks(stream: AsyncIterable<unknown>): Promise<unknown[]> {
	const chunks: unknown[] = [];
	for await (const c of stream) chunks.push(c);
	return chunks;
}

function doneChunk(chunks: unknown[]): { type: "done"; cost_usd?: number } | undefined {
	return chunks.find(
		(c): c is { type: "done"; cost_usd?: number } =>
			typeof c === "object" && c !== null && (c as { type?: string }).type === "done",
	);
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

	it("stamps the messages route's cost with the 1h cache-write subset at cache_write_1h_price", async () => {
		// The messages route is tagged usageProvider: "anthropic", so the bridge
		// extracts the 1h/5m split from providerMetadata.anthropic.usage.cache_creation
		// and stampCost prices the 1h subset at cache_write_1h_price.
		const requests: Request[] = [];
		// A messages SSE whose message_start usage carries a cache_creation split:
		// 1000 cache-write tokens total, 600 of them 1h.
		const splitMessagesSse = () => {
			const events = [
				`event: message_start\ndata: ${JSON.stringify({
					type: "message_start",
					message: {
						id: "msg_1",
						type: "message",
						role: "assistant",
						model: "claude-haiku-5.5",
						content: [],
						stop_reason: null,
						usage: {
							input_tokens: 3,
							output_tokens: 0,
							cache_creation_input_tokens: 1000,
							cache_creation: {
								ephemeral_1h_input_tokens: 600,
								ephemeral_5m_input_tokens: 400,
							},
						},
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
		};
		const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
			const req = new Request(input, init);
			requests.push(req);
			const url = new URL(req.url);
			if (url.pathname.endsWith("/models")) {
				return new Response(
					JSON.stringify({
						data: [
							{
								id: "claude-haiku-5.5",
								supported_endpoints: ["/v1/messages"],
								billing: {
									token_prices: {
										batch_size: 1_000_000,
										default: {
											input_price: 10,
											output_price: 50,
											cache_read_price: 1,
											cache_write_price: 12.5,
											cache_write_1h_price: 20,
										},
									},
								},
							},
						],
					}),
					{ status: 200, headers: { "content-type": "application/json" } },
				);
			}
			if (url.pathname.endsWith("/v1/messages")) return splitMessagesSse();
			return new Response("not found", { status: 404 });
		}) as typeof fetch;
		const driver = new GitHubCopilotDriver({
			tokenManager,
			model: "claude-haiku-5.5",
			contextWindow: 200000,
			account,
			fetch: fetchImpl,
		});
		const chunks = await collectChunks(
			driver.chat({ messages: [{ role: "user", content: "hi" }] }),
		);
		const done = doneChunk(chunks) as
			| {
					type: "done";
					cost_usd?: number;
					usage: {
						input_tokens: number;
						output_tokens: number;
						cache_read_tokens: number | null;
						cache_write_tokens: number | null;
						cache_write_1h_tokens?: number | null;
					};
			  }
			| undefined;
		// The split rode through to the done usage: 600 of the 1000 cache-write tokens.
		expect(done?.usage.cache_write_tokens).toBe(1000);
		expect(done?.usage.cache_write_1h_tokens).toBe(600);
		// Cost derives from the reported usage so it is independent of how the
		// anthropic adapter reports input_tokens. The 1h subset (600) prices at
		// cache_write_1h_price (20) and the remaining 400 at cache_write_price (12.5);
		// if the split were dropped the whole 1000 would price at 12.5 and this would
		// fail. Units: USD = tokens * price / batch_size(1e6) / 100.
		const u = done?.usage;
		const expected =
			((u?.input_tokens ?? 0) * 10 +
				(u?.output_tokens ?? 0) * 50 +
				(u?.cache_read_tokens ?? 0) * 1 +
				400 * 12.5 +
				600 * 20) /
			1_000_000 /
			100;
		expect(done?.cost_usd).toBeCloseTo(expected, 14);
	});

	it("stamps done.cost_usd from the catalog pricing for a fixed model", async () => {
		const requests: Request[] = [];
		const driver = new GitHubCopilotDriver({
			tokenManager,
			model: "gpt-5.6",
			contextWindow: 200000,
			account,
			fetch: makeFetch({
				catalog: [
					{
						id: "gpt-5.6",
						supported_endpoints: ["/responses"],
						billing: {
							token_prices: {
								batch_size: 1_000_000,
								default: { input_price: 100, output_price: 800 },
							},
						},
					},
				],
				requests,
			}),
		});
		// responsesSse reports input_tokens: 3, output_tokens: 1.
		// USD = (3*100 + 1*800) / 1e6 / 100 = 1100 / 1e8.
		const chunks = await collectChunks(
			driver.chat({ messages: [{ role: "user", content: "hi" }] }),
		);
		const done = doneChunk(chunks);
		expect(done?.cost_usd).toBeCloseTo(1100 / 1e8, 14);
	});

	it("stamps done.cost_usd from the selected model's catalog price when model is auto", async () => {
		const requests: Request[] = [];
		const driver = new GitHubCopilotDriver({
			tokenManager,
			model: "auto",
			contextWindow: 200000,
			account,
			fetch: makeFetch({
				auto: {
					session_token: "sess_1",
					selected_model: { id: "gpt-5.6" },
					expires_at: Date.now() / 1000 + 3600,
				},
				catalog: [
					{
						id: "gpt-5.6",
						supported_endpoints: ["/responses"],
						billing: {
							token_prices: {
								batch_size: 1_000_000,
								default: { input_price: 100, output_price: 800 },
							},
							auto_discount: 0.5,
						},
					},
				],
				requests,
			}),
		});
		const chunks = await collectChunks(
			driver.chat({ messages: [{ role: "user", content: "hi" }] }),
		);
		const done = doneChunk(chunks);
		// auto route applies the 0.5 auto_discount: (1100 / 1e8) * 0.5.
		expect(done?.cost_usd).toBeCloseTo((1100 / 1e8) * 0.5, 14);
	});

	it("leaves done.cost_usd unset when the catalog has no pricing for the model", async () => {
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
		const chunks = await collectChunks(
			driver.chat({ messages: [{ role: "user", content: "hi" }] }),
		);
		const done = doneChunk(chunks);
		expect(done?.cost_usd).toBeUndefined();
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

describe("messagesHaveImages document file_ref", () => {
	it("detects an image-media document file_ref as a vision request", () => {
		// A document part whose source is a file_ref resolving to image media is a
		// vision request even though its block type is "document", not "image".
		expect(
			messagesHaveImages([
				{
					role: "user",
					content: [
						{
							type: "document",
							source: { type: "file_ref", file_id: "f1", media_type: "image/png" },
						} as unknown as ContentBlock,
					],
				},
			]),
		).toBe(true);
	});

	it("does not treat a non-image document file_ref as a vision request", () => {
		// A document file_ref resolving to a PDF is not a vision request.
		expect(
			messagesHaveImages([
				{
					role: "user",
					content: [
						{
							type: "document",
							source: { type: "file_ref", file_id: "f1", media_type: "application/pdf" },
						} as unknown as ContentBlock,
					],
				},
			]),
		).toBe(false);
	});
});

describe("resolveReasoningEffort", () => {
	it("passes a canonical effort through when the model advertises no list", () => {
		// No advertised reasoning_effort list: only the canonical low/medium/high
		// are allowed through.
		expect(resolveReasoningEffort({ effort: "medium" }, undefined)).toBe("medium");
		expect(resolveReasoningEffort({ effort: "low" }, [])).toBe("low");
	});

	it("drops a non-canonical effort when the model advertises no list", () => {
		// "xhigh" is not in the canonical trio and there is no advertised list to
		// validate it against, so it is omitted from the wire.
		expect(resolveReasoningEffort({ effort: "xhigh" }, undefined)).toBeUndefined();
	});

	it("returns undefined when no effort is requested and thinking is not disabled", () => {
		expect(resolveReasoningEffort({}, ["low", "medium", "high"])).toBeUndefined();
	});

	it("does not map thinking:disabled to none when the model omits none", () => {
		// disabled only maps to "none" when the model lists "none"; absent that, and
		// with no explicit effort, nothing is forwarded.
		expect(
			resolveReasoningEffort({ thinking: { type: "disabled" } }, ["low", "medium", "high"]),
		).toBeUndefined();
	});

	it("returns undefined for effort:max when no weaker tier is advertised", () => {
		// "max" with neither "max" nor any weaker ranked level listed resolves to
		// nothing rather than inventing a tier.
		expect(resolveReasoningEffort({ effort: "max" }, ["unknown-tier"])).toBeUndefined();
	});
});

describe("GitHubCopilotDriver auto selection from array content", () => {
	it("extracts the last user text from array content for the /auto prompt", async () => {
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
		// The last user turn carries array content with text blocks; lastUserText
		// must join them into the /auto prompt rather than sending an empty string.
		await drain(
			driver.chat({
				threadId: "t-arr",
				messages: [
					{
						role: "user",
						content: [
							{ type: "text", text: "first line" },
							{ type: "text", text: "second line" },
						],
					},
				],
			}),
		);
		const auto = requests.find((r) => new URL(r.url).pathname.endsWith("/auto"));
		if (!auto) throw new Error("no /auto request issued");
		const body = JSON.parse(await auto.text()) as { prompt?: string };
		expect(body.prompt).toBe("first line\nsecond line");
	});
});

describe("GitHubCopilotDriver account resolution", () => {
	it("throws when constructed with neither an account nor a resolver", async () => {
		// The default resolver must refuse rather than silently proceed without a
		// validated endpoint.
		const driver = new GitHubCopilotDriver({
			tokenManager,
			model: "gpt-4.1",
			contextWindow: 128000,
			fetch: makeFetch({ requests: [] }),
		});
		await expect(
			drain(driver.chat({ messages: [{ role: "user", content: "hi" }] })),
		).rejects.toThrow(/requires account or resolveAccount/);
	});

	it("resets endpoint state after a failed account lookup so the next turn retries", async () => {
		let calls = 0;
		const resolveAccount = async (): Promise<CopilotAccountInfo> => {
			calls++;
			if (calls === 1) throw new Error("transient account lookup failure");
			return account;
		};
		const driver = new GitHubCopilotDriver({
			tokenManager,
			model: "gpt-4.1",
			contextWindow: 128000,
			resolveAccount,
			fetch: makeFetch({ catalog: [], requests: [] }),
		});
		// First turn fails in the endpoint resolver; the driver must clear its cached
		// endpoint promise so a second turn re-resolves rather than replaying the
		// rejected promise forever.
		await expect(
			drain(driver.chat({ messages: [{ role: "user", content: "hi" }] })),
		).rejects.toThrow(/transient account lookup failure/);
		await drain(driver.chat({ messages: [{ role: "user", content: "hi" }] }));
		expect(calls).toBe(2);
	});
});

describe("GitHubCopilotDriver error mapping", () => {
	/** A fake fetch that answers control routes but returns a 4xx on inference. */
	function erroringFetch(opts: {
		requests: Request[];
		inferenceBody: unknown;
		auto?: { session_token: string; selected_model: { id: string }; expires_at: number };
	}): typeof fetch {
		return (async (input: RequestInfo | URL, init?: RequestInit) => {
			const req = new Request(input, init);
			opts.requests.push(req);
			const url = new URL(req.url);
			if (url.pathname.endsWith("/models")) {
				return new Response(JSON.stringify({ data: [] }), {
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
			// Inference route (chat completions / responses): a 400 with a plan error.
			return new Response(JSON.stringify(opts.inferenceBody), {
				status: 400,
				headers: { "content-type": "application/json" },
			});
		}) as typeof fetch;
	}

	it("rewrites a model_not_supported 400 into an actionable plan error", async () => {
		const requests: Request[] = [];
		const driver = new GitHubCopilotDriver({
			tokenManager,
			model: "gpt-4.1",
			contextWindow: 128000,
			account,
			fetch: erroringFetch({
				requests,
				inferenceBody: { error: { message: "model_not_supported", code: "model_not_supported" } },
			}),
		});
		// A 400 whose message names model_not_supported must surface as the
		// actionable "unavailable for this plan" message, not the raw API error.
		await expect(
			drain(driver.chat({ model: "gpt-4.1", messages: [{ role: "user", content: "hi" }] })),
		).rejects.toThrow(/unavailable for this plan/);
	});

	it("passes a non-plan 400 through unchanged", async () => {
		const requests: Request[] = [];
		const driver = new GitHubCopilotDriver({
			tokenManager,
			model: "gpt-4.1",
			contextWindow: 128000,
			account,
			fetch: erroringFetch({
				requests,
				inferenceBody: { error: { message: "context length exceeded" } },
			}),
		});
		// A 400 that is not a plan/model problem is not rewritten with the plan hint.
		await expect(
			drain(driver.chat({ model: "gpt-4.1", messages: [{ role: "user", content: "hi" }] })),
		).rejects.not.toThrow(/unavailable for this plan/);
	});

	it("invalidates the auto-session on a 4xx so the next turn re-resolves", async () => {
		const requests: Request[] = [];
		const driver = new GitHubCopilotDriver({
			tokenManager,
			model: "auto",
			contextWindow: 200000,
			account,
			now: () => 0,
			fetch: erroringFetch({
				requests,
				inferenceBody: { error: { message: "no_available_model_endpoints" } },
				auto: {
					session_token: "sess-1",
					selected_model: { id: "mai-code-2-flash" },
					expires_at: 3600,
				},
			}),
		});
		// The inference 4xx is a session error on an auto turn: the cached session is
		// invalidated, so a second turn issues a fresh /auto request.
		await expect(
			drain(driver.chat({ threadId: "t-inv", messages: [{ role: "user", content: "hi" }] })),
		).rejects.toThrow();
		await expect(
			drain(driver.chat({ threadId: "t-inv", messages: [{ role: "user", content: "hi" }] })),
		).rejects.toThrow();
		const autoCalls = requests.filter((r) => new URL(r.url).pathname.endsWith("/auto")).length;
		expect(autoCalls).toBe(2);
	});
});
