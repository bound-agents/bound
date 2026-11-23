import { describe, expect, it } from "bun:test";
import {
	BedrockMantleDriver,
	buildMantleOpenAIOptions,
	deriveMantleBaseUrl,
	deriveMantleBaseUrlForMode,
	withEmptyRetry,
} from "../drivers/bedrock-mantle";
import type { ChatParams, StreamChunk } from "../types";

const doneChunk = (outputTokens: number): StreamChunk => ({
	type: "done",
	usage: {
		input_tokens: 100,
		output_tokens: outputTokens,
		cache_write_tokens: null,
		cache_read_tokens: null,
		estimated: false,
	},
});
const textChunk = (content: string): StreamChunk => ({ type: "text", content });

async function* streamOf(...chunks: StreamChunk[]): AsyncIterable<StreamChunk> {
	for (const chunk of chunks) yield chunk;
}

async function collect(it: AsyncIterable<StreamChunk>): Promise<StreamChunk[]> {
	const out: StreamChunk[] = [];
	for await (const chunk of it) out.push(chunk);
	return out;
}

async function drain(it: AsyncIterable<StreamChunk>): Promise<void> {
	for await (const _ of it) {
		// consume — assertions inspect the captured request
	}
}

function anthropicSse(): Response {
	const events = [
		`event: message_start\ndata: ${JSON.stringify({
			type: "message_start",
			message: {
				id: "msg_1",
				type: "message",
				role: "assistant",
				model: "anthropic.claude-sonnet-5",
				content: [],
				stop_reason: null,
				usage: {
					input_tokens: 10,
					output_tokens: 1,
					cache_creation_input_tokens: 0,
					cache_read_input_tokens: 0,
				},
			},
		})}\n\n`,
		`event: content_block_start\ndata: ${JSON.stringify({
			type: "content_block_start",
			index: 0,
			content_block: { type: "text", text: "" },
		})}\n\n`,
		`event: content_block_delta\ndata: ${JSON.stringify({
			type: "content_block_delta",
			index: 0,
			delta: { type: "text_delta", text: "hi" },
		})}\n\n`,
		`event: content_block_stop\ndata: ${JSON.stringify({ type: "content_block_stop", index: 0 })}\n\n`,
		`event: message_delta\ndata: ${JSON.stringify({
			type: "message_delta",
			delta: { stop_reason: "end_turn" },
			usage: { output_tokens: 5 },
		})}\n\n`,
		`event: message_stop\ndata: ${JSON.stringify({ type: "message_stop" })}\n\n`,
	].join("");
	return new Response(events, {
		status: 200,
		headers: { "content-type": "text/event-stream" },
	});
}

const fakeCredentials = async () => ({
	accessKeyId: "AKIDEXAMPLE",
	secretAccessKey: "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY",
	sessionToken: "SESSION",
});

const baseParams: ChatParams = {
	model: "anthropic.claude-sonnet-5",
	messages: [{ role: "user", content: "hello" }],
};

describe("deriveMantleBaseUrl", () => {
	it("derives the region-scoped mantle Responses base URL when no override is given", () => {
		expect(deriveMantleBaseUrl("us-west-2")).toBe(
			"https://bedrock-mantle.us-west-2.api.aws/openai/v1",
		);
		expect(deriveMantleBaseUrl("us-east-2")).toBe(
			"https://bedrock-mantle.us-east-2.api.aws/openai/v1",
		);
	});

	it("honors an explicit base URL override verbatim", () => {
		expect(deriveMantleBaseUrl("us-west-2", "https://example.test/openai/v1")).toBe(
			"https://example.test/openai/v1",
		);
	});
});

describe("deriveMantleBaseUrlForMode", () => {
	it("derives protocol-specific Mantle base URLs", () => {
		expect(deriveMantleBaseUrlForMode("us-east-1", "openai_responses")).toBe(
			"https://bedrock-mantle.us-east-1.api.aws/openai/v1",
		);
		expect(deriveMantleBaseUrlForMode("us-east-1", "anthropic")).toBe(
			"https://bedrock-mantle.us-east-1.api.aws/anthropic/v1",
		);
	});

	it("honors an explicit base URL override verbatim for either mode", () => {
		expect(
			deriveMantleBaseUrlForMode("us-east-1", "anthropic", "https://example.test/custom/v1"),
		).toBe("https://example.test/custom/v1");
	});
});

describe("BedrockMantleDriver", () => {
	const make = () =>
		new BedrockMantleDriver({
			region: "us-west-2",
			model: "openai.gpt-5.4",
			contextWindow: 272_000,
			providerMode: "openai_responses",
			profile: "test-profile",
		});

	it("constructs without resolving credentials (the provider is lazy)", () => {
		// Credential resolution happens per-request inside the SigV4 fetch, never
		// at construction — so building a driver must not touch the AWS chain.
		expect(() => make()).not.toThrow();
	});

	it("reports vision + prompt caching and the configured context window", () => {
		const caps = make().capabilities();
		expect(caps.max_context).toBe(272_000);
		expect(caps.streaming).toBe(true);
		expect(caps.tool_use).toBe(true);
		expect(caps.vision).toBe(true);
		// GPT-5.4/5.5 cache automatically (exact-match, no markers); the 5.6
		// family additionally takes explicit prompt_cache_breakpoints. Either
		// way the capability bit is honest.
		expect(caps.prompt_caching).toBe(true);
	});

	it("attempts prompt_cache_breakpoint by default (no model-ID gate, #292)", () => {
		// The old supportsPromptCacheBreakpoints(modelId) string gate is retired:
		// breakpoints are attempted for every Responses model and only dropped per
		// route after an observed rejection (R-MC14, exercised via the recovery
		// module's own tests). This test pins that the model-ID branch is gone —
		// there is no exported gate to assert against anymore.
		expect(buildMantleOpenAIOptions(undefined)).not.toHaveProperty("promptCacheOptions");
	});

	it("maps the configured cache_ttl into the Responses lifetime vocabulary (30m) before sending (#293)", () => {
		// The OpenAI Responses protocol exposes a single cache lifetime, and the
		// @ai-sdk/openai schema validates `promptCacheOptions.ttl` as `z.literal("30m")`
		// LOCALLY — any other value throws InvalidArgumentError before a request is sent.
		// So the configured Anthropic-vocabulary cache_ttl ("1h"/"5m") must be quantized
		// to the Responses field's own accepted value, never forwarded verbatim.
		for (const configured of ["1h", "5m", "30m", "12h"]) {
			const opts = buildMantleOpenAIOptions(undefined, false, configured);
			expect(opts.promptCacheOptions).toEqual({ ttl: "30m" });
		}
		// promptCacheRetention is independent and always present.
		expect(buildMantleOpenAIOptions(undefined, false, "1h").promptCacheRetention).toBe("24h");
	});

	it("omits prompt_cache_options when no ttl is requested (dropped/unset)", () => {
		expect(buildMantleOpenAIOptions(undefined, false, undefined)).not.toHaveProperty(
			"promptCacheOptions",
		);
	});

	it("sends Anthropic mode to /anthropic/v1/messages with SigV4 and no x-api-key", async () => {
		let seen: Request | undefined;
		let seenBody: Record<string, unknown> | undefined;
		const captureFetch: typeof fetch = async (input, init) => {
			seen = new Request(input as RequestInfo, init);
			seenBody = JSON.parse(await seen.clone().text());
			return anthropicSse();
		};

		const driver = new BedrockMantleDriver({
			region: "us-east-1",
			model: "anthropic.claude-sonnet-5",
			contextWindow: 200_000,
			providerMode: "anthropic",
			fetch: captureFetch,
			credentials: fakeCredentials,
		});

		await drain(driver.chat(baseParams));

		expect(seen?.url).toBe("https://bedrock-mantle.us-east-1.api.aws/anthropic/v1/messages");
		expect(seen?.headers.get("authorization")).toContain("AWS4-HMAC-SHA256");
		expect(seen?.headers.get("x-amz-security-token")).toBe("SESSION");
		expect(seen?.headers.get("x-api-key")).toBeNull();
		expect(seen?.headers.get("anthropic-version")).toBe("2023-06-01");
		expect(seenBody?.model).toBe("anthropic.claude-sonnet-5");
		expect(seenBody?.messages).toEqual([
			{ role: "user", content: [{ type: "text", text: "hello" }] },
		]);
	});

	it("discovers the region's entitled lineup from /v1/models at the root (not /openai or /anthropic)", async () => {
		let seen: Request | undefined;
		const captureFetch: typeof fetch = async (input, init) => {
			seen = new Request(input as RequestInfo, init);
			return new Response(
				JSON.stringify({
					data: [
						{
							id: "openai.gpt-6.1-sol",
							object: "model",
							owned_by: "openai",
							created: 1,
							status: "ACTIVE",
							data_retention: { allowed_modes: ["disabled"], mode: "disabled", source: "account" },
						},
						{ id: "anthropic.claude-opus-5-5", object: "model", owned_by: "anthropic" },
					],
				}),
				{ status: 200, headers: { "content-type": "application/json" } },
			);
		};

		const driver = new BedrockMantleDriver({
			region: "us-east-1",
			model: "openai.gpt-6.1-sol",
			contextWindow: 400_000,
			providerMode: "openai_responses",
			fetch: captureFetch,
			credentials: fakeCredentials,
		});

		const models = await driver.discoverModels();

		// Root /v1/models, SigV4-signed; the /openai and /anthropic prefixes both 404.
		expect(seen?.url).toBe("https://bedrock-mantle.us-east-1.api.aws/v1/models");
		expect(seen?.headers.get("authorization")).toContain("AWS4-HMAC-SHA256");
		// Entitlement is provider-layer: only ids the region serves are returned.
		expect(models.map((m) => m.providerModelId)).toEqual([
			"openai.gpt-6.1-sol",
			"anthropic.claude-opus-5-5",
		]);
		// The listing carries no limits/pricing/display name, and data_retention is
		// not plumbed (no consumer) — bare ids only, limits come from models.dev.
		expect(models[0]?.maxOutputTokens).toBeUndefined();
		expect(models[0]?.pricing).toBeUndefined();
	});

	it("rejects on a non-OK discovery response so the caller degrades to config + models.dev", async () => {
		const failFetch: typeof fetch = async () => new Response("forbidden", { status: 403 });
		const driver = new BedrockMantleDriver({
			region: "us-east-2",
			model: "openai.gpt-6-sol",
			contextWindow: 400_000,
			providerMode: "openai_responses",
			fetch: failFetch,
			credentials: fakeCredentials,
		});
		await expect(driver.discoverModels()).rejects.toThrow(/403/);
	});
});

describe("buildMantleOpenAIOptions", () => {
	// The native @ai-sdk/openai provider keys reasoning-model detection off the
	// model id (modelId.startsWith("gpt-5")). Mantle ids carry an "openai."
	// prefix, so the SDK misclassifies "openai.gpt-5.5" as a non-reasoning model
	// and silently strips reasoningEffort — verified on the wire: without
	// forceReasoning the request body has no `reasoning` field at all. So the
	// driver MUST force it, or the configured effort never reaches the model.
	it("always forces reasoning-model treatment and stays stateless", () => {
		const opts = buildMantleOpenAIOptions("high");
		expect(opts.forceReasoning).toBe(true);
		expect(opts.store).toBe(false);
	});

	// gpt-5.5 does not support the in_memory cache-retention policy at all — per
	// OpenAI's prompt-caching guide, only "24h" is offered for gpt-5.5/-pro and
	// future models, and a request that omits the parameter falls to an
	// in_memory default the model can't honor, caching nothing. Verified live
	// against the mantle endpoint: store:false with no retention → cached_tokens
	// flat 0 across repeated identical prefixes; store:false + "24h" → cache
	// hits. Extended retention is explicitly permitted under Zero Data Retention
	// (only key/value tensors persist, ≤24h; never store:true), so this is the
	// ZDR-clean lever for recovering cache reads on this model.
	it("requests 24h prompt-cache retention (the only policy gpt-5.5 supports)", () => {
		const opts = buildMantleOpenAIOptions("high");
		expect(opts.promptCacheRetention).toBe("24h");
		// still stateless — retention caches the prompt prefix, not the response
		expect(opts.store).toBe(false);
	});

	it("maps a supported effort straight through to reasoningEffort", () => {
		expect(buildMantleOpenAIOptions("medium").reasoningEffort).toBe("medium");
		expect(buildMantleOpenAIOptions("high").reasoningEffort).toBe("high");
		expect(buildMantleOpenAIOptions("xhigh").reasoningEffort).toBe("xhigh");
	});

	it("folds bound's 'max' onto the OpenAI surface's strongest level", () => {
		expect(buildMantleOpenAIOptions("max").reasoningEffort).toBe("xhigh");
	});

	it("omits reasoningEffort entirely when effort is unset", () => {
		const opts = buildMantleOpenAIOptions(undefined);
		expect("reasoningEffort" in opts).toBe(false);
		// forceReasoning still holds: a reasoning model with no explicit effort
		// uses the API default, which is correct — we just don't override it.
		expect(opts.forceReasoning).toBe(true);
	});

	// Regression #272: @ai-sdk/openai defaults `reasoning.summary` to "detailed"
	// on any reasoning-model request carrying a non-`none` effort. Because this
	// driver force-reasons every Mantle `openai.` id AND supplies an effort, the
	// SDK would emit `reasoning.summary` on the wire — which the Bedrock-Mantle
	// Responses endpoint rejects with 400 `Unsupported parameter:
	// 'reasoning.summary'`. The options MUST pin `reasoningSummary: null` so the
	// SDK takes the explicit branch (it checks `!== undefined`) and drops the
	// field. `undefined` would fall back into the "detailed" default and NOT fix
	// it, so assert the value is exactly `null`.
	it("pins reasoningSummary null so the SDK's 'detailed' default never fires (effort-bearing)", () => {
		const opts = buildMantleOpenAIOptions("high", false);
		expect(opts.reasoningSummary).toBe(null);
		expect(opts.reasoningEffort).toBe("high");
		expect(opts.forceReasoning).toBe(true);
	});

	it("pins reasoningSummary null even on the thinking-disabled path", () => {
		// effort "none" alone already suppresses the summary in the SDK, but the
		// driver asserts it unconditionally (belt-and-suspenders across SDK bumps).
		const opts = buildMantleOpenAIOptions("high", true);
		expect(opts.reasoningSummary).toBe(null);
		expect(opts.reasoningEffort).toBe("none");
	});
});

describe("withEmptyRetry", () => {
	// Mantle GPT-5.x intermittently returns a completion with output_tokens=0 and
	// no content (~12% observed at the bare endpoint, store:false). store:true —
	// the one lever that might reduce it — is forbidden by the zero-retention
	// requirement, so the driver retries the empty turn. An empty turn yields
	// ONLY a `done` chunk, so discarding it and re-issuing duplicates nothing.

	it("discards an empty completion and yields the retry's content", async () => {
		const attempts = [() => streamOf(doneChunk(0)), () => streamOf(textChunk("hi"), doneChunk(5))];
		let i = 0;
		const out = await collect(
			withEmptyRetry(() => attempts[i++](), { maxRetries: 2, isAborted: () => false }),
		);
		expect(i).toBe(2); // retried once
		expect(out).toEqual([textChunk("hi"), doneChunk(5)]); // empty done swallowed
	});

	it("does not retry a turn that produced content, even at output_tokens=0", async () => {
		// A streamed-content turn whose usage rounds to 0 is NOT empty — content
		// was already yielded and cannot be un-yielded. The content guard wins.
		let i = 0;
		const out = await collect(
			withEmptyRetry(
				() => {
					i++;
					return streamOf(textChunk("x"), doneChunk(0));
				},
				{ maxRetries: 2, isAborted: () => false },
			),
		);
		expect(i).toBe(1); // single attempt
		expect(out).toEqual([textChunk("x"), doneChunk(0)]);
	});

	it("does not retry on a non-empty completion", async () => {
		let i = 0;
		const out = await collect(
			withEmptyRetry(
				() => {
					i++;
					return streamOf(textChunk("answer"), doneChunk(12));
				},
				{ maxRetries: 2, isAborted: () => false },
			),
		);
		expect(i).toBe(1);
		expect(out).toEqual([textChunk("answer"), doneChunk(12)]);
	});

	it("stops after maxRetries and yields the final empty done (no infinite loop)", async () => {
		let i = 0;
		const out = await collect(
			withEmptyRetry(
				() => {
					i++;
					return streamOf(doneChunk(0));
				},
				{ maxRetries: 2, isAborted: () => false },
			),
		);
		expect(i).toBe(3); // initial + 2 retries
		expect(out).toEqual([doneChunk(0)]); // gives up, surfaces the empty turn
	});

	it("does not retry once the request is aborted", async () => {
		let i = 0;
		const out = await collect(
			withEmptyRetry(
				() => {
					i++;
					return streamOf(doneChunk(0));
				},
				{ maxRetries: 2, isAborted: () => true },
			),
		);
		expect(i).toBe(1); // honored the cancellation, no retry
		expect(out).toEqual([doneChunk(0)]);
	});

	it("invokes onRetry with the attempt number for observability", async () => {
		const retries: number[] = [];
		const attempts = [
			() => streamOf(doneChunk(0)),
			() => streamOf(doneChunk(0)),
			() => streamOf(textChunk("ok"), doneChunk(3)),
		];
		let i = 0;
		await collect(
			withEmptyRetry(() => attempts[i++](), {
				maxRetries: 3,
				isAborted: () => false,
				onRetry: (n) => retries.push(n),
			}),
		);
		expect(retries).toEqual([1, 2]);
	});
});

function responsesSse(): Response {
	const events = [
		`event: response.created\ndata: ${JSON.stringify({
			type: "response.created",
			response: { id: "resp_1", model: "openai.gpt-5.6-sol" },
		})}`,
		`event: response.output_item.added\ndata: ${JSON.stringify({
			type: "response.output_item.added",
			output_index: 0,
			item: { type: "message", id: "msg_1", role: "assistant", content: [] },
		})}`,
		`event: response.content_part.added\ndata: ${JSON.stringify({
			type: "response.content_part.added",
			item_id: "msg_1",
			output_index: 0,
			content_index: 0,
			part: { type: "output_text", text: "" },
		})}`,
		`event: response.output_text.delta\ndata: ${JSON.stringify({
			type: "response.output_text.delta",
			item_id: "msg_1",
			output_index: 0,
			content_index: 0,
			delta: "answer",
		})}`,
		`event: response.output_text.done\ndata: ${JSON.stringify({
			type: "response.output_text.done",
			item_id: "msg_1",
			output_index: 0,
			content_index: 0,
			text: "answer",
		})}`,
		`event: response.content_part.done\ndata: ${JSON.stringify({
			type: "response.content_part.done",
			item_id: "msg_1",
			output_index: 0,
			content_index: 0,
			part: { type: "output_text", text: "answer" },
		})}`,
		`event: response.output_item.done\ndata: ${JSON.stringify({
			type: "response.output_item.done",
			output_index: 0,
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
				model: "openai.gpt-5.6-sol",
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

describe("BedrockMantleDriver — encrypted-reasoning cross-deployment recovery", () => {
	// A thread that previously ran a gpt-5.6-sol turn on a DIFFERENT Mantle
	// deployment carries that deployment's encrypted reasoning. Replaying it to
	// this deployment is rejected ("could not be verified"). Layer 2: the driver
	// retries ONCE with all encrypted reasoning stripped, and the stripped request
	// succeeds. The history carries a foreign-origin thinking block whose
	// encrypted content must be gone from the retried request body.
	const crossHostParams: ChatParams = {
		model: "openai.gpt-5.6-sol",
		messages: [
			{ role: "user", content: "first question" },
			{
				role: "assistant",
				content: [
					{
						type: "thinking",
						thinking: "",
						reasoning_encrypted_content: "ENC-foreign-origin",
						reasoning_origin: "MSI-site:us-west-2:openai_responses",
					},
					{ type: "text", text: "prior answer" },
				],
			},
			{ role: "user", content: "follow-up" },
		],
	};

	it("retries once with encrypted reasoning stripped on a deployment-mismatch rejection", async () => {
		const bodies: string[] = [];
		let call = 0;
		const captureFetch: typeof fetch = async (input, init) => {
			const req = new Request(input as RequestInfo, init);
			bodies.push(await req.clone().text());
			call++;
			// First call carries the foreign-origin encrypted reasoning and is
			// rejected; the stripped retry succeeds.
			return call === 1 ? encryptedReasoningRejection() : responsesSse();
		};

		const driver = new BedrockMantleDriver({
			region: "us-east-1",
			model: "openai.gpt-5.6-sol",
			contextWindow: 272_000,
			providerMode: "openai_responses",
			fetch: captureFetch,
			credentials: fakeCredentials,
			// This deployment's own identity; the history's block was minted on MSI,
			// so layer-1 origin matching already drops it — but assert the full retry
			// path by exercising a deployment whose siteId differs from the block's.
			siteId: "this-host:us-east-1",
		});

		const out = await collect(driver.chat(crossHostParams));

		expect(call).toBe(2); // one rejection, one stripped retry
		// Both requests must be free of the foreign encrypted blob: layer-1 origin
		// mismatch drops it on the first call, and the explicit strip drops it on
		// the retry. The turn self-heals into a text answer rather than failing.
		expect(bodies[0]).not.toContain("ENC-foreign-origin");
		expect(bodies[1]).not.toContain("ENC-foreign-origin");
		expect(out.some((c) => c.type === "text" && c.content.includes("answer"))).toBe(true);
	});

	it("does not retry when the first request succeeds", async () => {
		let call = 0;
		const captureFetch: typeof fetch = async () => {
			call++;
			return responsesSse();
		};
		const driver = new BedrockMantleDriver({
			region: "us-east-1",
			model: "openai.gpt-5.6-sol",
			contextWindow: 272_000,
			providerMode: "openai_responses",
			fetch: captureFetch,
			credentials: fakeCredentials,
			siteId: "this-host:us-east-1",
		});
		await collect(driver.chat(crossHostParams));
		expect(call).toBe(1); // no retry on a clean first attempt
	});

	it("does not run the stripped retry for a non-encrypted-reasoning error", async () => {
		// A generic 400 (not the encrypted-reasoning family) must NOT trigger the
		// layer-2 stripped retry — the error propagates. A 400 is non-retryable by
		// the SDK, so the driver issues exactly one request and never rebuilds the
		// input with reasoning stripped.
		const bodies: string[] = [];
		const captureFetch: typeof fetch = async (input, init) => {
			const req = new Request(input as RequestInfo, init);
			bodies.push(await req.clone().text());
			return new Response(
				JSON.stringify({ error: { message: "model is overloaded", type: "server_error" } }),
				{ status: 400, headers: { "content-type": "application/json" } },
			);
		};
		const driver = new BedrockMantleDriver({
			region: "us-east-1",
			model: "openai.gpt-5.6-sol",
			contextWindow: 272_000,
			providerMode: "openai_responses",
			fetch: captureFetch,
			credentials: fakeCredentials,
			siteId: "this-host:us-east-1",
		});
		await expect(collect(driver.chat(crossHostParams))).rejects.toThrow();
		// Exactly one request: no stripped rebuild fired. The inline prior text still
		// replays (layer-1 already drops the foreign blob at build time, so its
		// absence is not a strip signal; the prior-text presence is the real tell).
		expect(bodies).toHaveLength(1);
		expect(bodies[0]).toContain("prior answer");
	});
});

describe("BedrockMantleDriver — Responses cache_ttl mapping and SDK-local recovery (#293)", () => {
	const responsesParams = (cacheTtl: string): ChatParams => ({
		model: "openai.gpt-5.6-sol",
		messages: [{ role: "user", content: "hello" }],
		cache_ttl: cacheTtl,
	});

	// The operator config sets cache_ttl in the Anthropic vocabulary ("1h"/"5m").
	// On the Responses route the SDK accepts only "30m" for prompt_cache_options.ttl
	// (validated locally), so each configured value must land as "30m" on the wire —
	// the request must succeed, never a route failure.
	for (const configured of ["1h", "5m", "30m", "12h"]) {
		it(`sends prompt_cache_options.ttl "30m" for a configured cache_ttl "${configured}"`, async () => {
			const bodies: string[] = [];
			const captureFetch: typeof fetch = async (input, init) => {
				const req = new Request(input as RequestInfo, init);
				bodies.push(await req.clone().text());
				return responsesSse();
			};
			const driver = new BedrockMantleDriver({
				region: "us-east-1",
				model: "openai.gpt-5.6-sol",
				contextWindow: 272_000,
				providerMode: "openai_responses",
				fetch: captureFetch,
				credentials: fakeCredentials,
				siteId: "this-host:us-east-1",
			});

			const out = await collect(driver.chat(responsesParams(configured)));

			expect(bodies).toHaveLength(1); // one request, no local-rejection failure
			const body = JSON.parse(bodies[0] ?? "{}") as { prompt_cache_options?: { ttl?: string } };
			expect(body.prompt_cache_options?.ttl).toBe("30m");
			// The configured Anthropic-vocabulary lifetime never reaches the wire verbatim.
			if (configured !== "30m") expect(bodies[0]).not.toContain(`"ttl":"${configured}"`);
			expect(out.some((c) => c.type === "text" && c.content.includes("answer"))).toBe(true);
		});
	}

	it("recovers from an SDK-local cache-ttl rejection without failing the turn", async () => {
		// Defense in depth: even if a cache-lifetime value reached the SDK that its
		// local schema rejects (AI_InvalidArgumentError, no 400), recovery must drop
		// the field, retry once, remember the route, and let the turn land. The SDK
		// rejects promptCacheOptions BEFORE any fetch, so the first (failing) attempt
		// never reaches captureFetch; only the recovered, field-dropped retry does.
		const bodies: string[] = [];
		const captureFetch: typeof fetch = async (input, init) => {
			const req = new Request(input as RequestInfo, init);
			bodies.push(await req.clone().text());
			return responsesSse();
		};
		const driver = new BedrockMantleDriver({
			region: "us-east-1",
			model: "openai.gpt-5.6-sol",
			contextWindow: 272_000,
			providerMode: "openai_responses",
			fetch: captureFetch,
			credentials: fakeCredentials,
			siteId: "this-host:us-east-1",
		});

		// Force a value the SDK schema rejects locally by recording a use-value
		// decision the quantizer would otherwise never produce. Use the public recovery
		// state the driver reads from before building the request.
		(
			driver as unknown as {
				cacheRecovery: {
					record: (r: string, rej: { field: string; supportedValue?: string }, o: unknown) => void;
				};
			}
		).cacheRecovery.record(
			"openai.gpt-5.6-sol",
			{ field: "prompt_cache_options.ttl", supportedValue: "1h" },
			{ validValues: ["1h"] },
		);

		const out = await collect(driver.chat(responsesParams("30m")));

		// The turn still lands with a text answer; recovery dropped the bad field.
		expect(out.some((c) => c.type === "text" && c.content.includes("answer"))).toBe(true);
		expect(bodies.length).toBeGreaterThanOrEqual(1);
		// The final, successful request carries no rejected lifetime value.
		expect(bodies.at(-1)).not.toContain('"ttl":"1h"');
	});
});
