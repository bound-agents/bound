import { describe, expect, it } from "bun:test";
import {
	BedrockMantleDriver,
	buildMantleOpenAIOptions,
	deriveMantleBaseUrl,
	withEmptyRetry,
} from "../bedrock-mantle-driver";
import type { StreamChunk } from "../types";

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

describe("BedrockMantleDriver", () => {
	const make = () =>
		new BedrockMantleDriver({
			region: "us-west-2",
			model: "openai.gpt-5.4",
			contextWindow: 272_000,
			profile: "test-profile",
		});

	it("constructs without resolving credentials (the provider is lazy)", () => {
		// Credential resolution happens per-request inside the SigV4 fetch, never
		// at construction — so building a driver must not touch the AWS chain.
		expect(() => make()).not.toThrow();
	});

	it("reports vision + automatic prompt caching and the configured context window", () => {
		const caps = make().capabilities();
		expect(caps.max_context).toBe(272_000);
		expect(caps.streaming).toBe(true);
		expect(caps.tool_use).toBe(true);
		expect(caps.vision).toBe(true);
		// Mantle GPT-5.x caches automatically (prefix-based, no markers) — the
		// capability is honest even though the driver places no cache breakpoints.
		expect(caps.prompt_caching).toBe(true);
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
