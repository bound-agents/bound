import { describe, expect, it } from "bun:test";
import {
	BedrockMantleDriver,
	buildMantleOpenAIOptions,
	deriveMantleBaseUrl,
	deriveMantleBaseUrlForMode,
	supportsPromptCacheBreakpoints,
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

	it("gates explicit prompt_cache_breakpoint support on the model generation", () => {
		// GPT-5.6 family (mantle "openai." prefix included): breakpoints.
		expect(supportsPromptCacheBreakpoints("openai.gpt-5.6-terra")).toBe(true);
		expect(supportsPromptCacheBreakpoints("openai.gpt-5.6-sol")).toBe(true);
		expect(supportsPromptCacheBreakpoints("openai.gpt-5.6-luna")).toBe(true);
		expect(supportsPromptCacheBreakpoints("gpt-5.6")).toBe(true);
		// GPT-5.4/5.5 reject the field — automatic cache only.
		expect(supportsPromptCacheBreakpoints("openai.gpt-5.4")).toBe(false);
		expect(supportsPromptCacheBreakpoints("openai.gpt-5.5")).toBe(false);
		expect(supportsPromptCacheBreakpoints("anthropic.claude-sonnet-5")).toBe(false);
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
