import { describe, expect, it } from "bun:test";
import { Semaphore, UmansDriver, createUmansAccount } from "../drivers/umans";
import type { BackendReadiness, ChatParams, StreamChunk } from "../types";
import { LLMError } from "../types";
import type { UmansModelMeta, UmansUsage } from "../umans-metadata";

type ScheduledTask = { dueAt: number; callback: () => void; cancelled: boolean };

function manualScheduler() {
	let now = 0;
	const tasks: ScheduledTask[] = [];
	return {
		schedule(delayMs: number, callback: () => void) {
			const task = { dueAt: now + delayMs, callback, cancelled: false };
			tasks.push(task);
			return {
				cancel: () => {
					task.cancelled = true;
				},
			};
		},
		advanceBy(ms: number) {
			now += ms;
			for (;;) {
				const task = tasks.find((candidate) => !candidate.cancelled && candidate.dueAt <= now);
				if (!task) return;
				task.cancelled = true;
				task.callback();
			}
		},
		pending() {
			return tasks.filter((task) => !task.cancelled).length;
		},
	};
}

async function flushMicrotasks(): Promise<void> {
	await Promise.resolve();
	await Promise.resolve();
	await Promise.resolve();
}

// Minimal Anthropic Messages SSE body. message_start carries cache usage;
// a text delta; message_delta carries output tokens. Enough for the AI SDK
// anthropic adapter to assemble a clean stream and surface
// providerMetadata.anthropic.cacheCreationInputTokens + cachedInputTokens.
function anthropicSse(opts?: { cacheWrite?: number; cacheRead?: number }): Response {
	const cw = opts?.cacheWrite ?? 0;
	const cr = opts?.cacheRead ?? 0;
	const events = [
		`event: message_start\ndata: ${JSON.stringify({
			type: "message_start",
			message: {
				id: "msg_1",
				type: "message",
				role: "assistant",
				model: "umans-coder",
				content: [],
				stop_reason: null,
				usage: {
					input_tokens: 10,
					output_tokens: 1,
					cache_creation_input_tokens: cw,
					cache_read_input_tokens: cr,
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

function perModelDriver(opts?: {
	fetch?: typeof fetch;
	usageFetch?: typeof import("../umans-metadata").fetchUmansUsage;
	semaphore?: Semaphore;
	reasoningLevels?: string[];
	reasoningDefault?: string;
	maxCompletionTokens?: number;
}): UmansDriver {
	const account = createUmansAccount({
		apiKey: "sk-test",
		fetch: opts?.fetch,
		usageFetch: opts?.usageFetch,
	});
	if (opts?.semaphore) account.semaphore = opts.semaphore;
	// Mark usage cache fresh so chat() doesn't try to refresh by default.
	account.usageCache = { value: {}, fetchedAt: Date.now() };
	return new UmansDriver({
		account,
		modelId: "umans-coder",
		reasoningLevels: opts?.reasoningLevels,
		reasoningDefault: opts?.reasoningDefault,
		maxCompletionTokens: opts?.maxCompletionTokens,
		capabilities: {
			streaming: true,
			tool_use: true,
			system_prompt: true,
			prompt_caching: true,
			vision: false,
			extended_thinking: true,
			max_context: 200000,
		},
	});
}

async function collect(it: AsyncIterable<StreamChunk>): Promise<StreamChunk[]> {
	const out: StreamChunk[] = [];
	for await (const c of it) out.push(c);
	return out;
}

const baseParams: ChatParams = {
	model: "umans-coder",
	messages: [{ role: "user", content: "hello" }],
};

describe("UmansDriver capabilities (AC.8)", () => {
	it("reports prompt_caching: true", () => {
		const d = perModelDriver();
		expect(d.capabilities().prompt_caching).toBe(true);
	});
});

describe("UmansDriver cache reporting (AC.8)", () => {
	it("surfaces cache-write/cache-read tokens in the done usage chunk", async () => {
		const fetch = (async () => anthropicSse({ cacheWrite: 100, cacheRead: 40 })) as typeof fetch;
		const d = perModelDriver({ fetch });
		const chunks = await collect(d.chat(baseParams));
		const done = chunks.find((c) => c.type === "done");
		expect(done).toBeDefined();
		if (done?.type !== "done") return;
		expect(done.usage.cache_write_tokens).toBe(100);
		expect(done.usage.cache_read_tokens).toBe(40);
	});

	it("sends cache_control breakpoints when the messages carry a cache marker", async () => {
		let body: string | undefined;
		const fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
			body = init?.body as string | undefined;
			return anthropicSse();
		}) as typeof fetch;
		const d = perModelDriver({ fetch });
		await collect(
			d.chat({
				model: "umans-coder",
				messages: [
					{ role: "user", content: "hello" },
					{ role: "cache", content: "" },
				],
			}),
		);
		expect(body).toBeDefined();
		expect(body).toContain("cache_control");
		expect(body).toContain("ephemeral");
	});
});

describe("UmansDriver max_tokens clamping (exclusive max_completion_tokens ceiling)", () => {
	async function sentMaxTokens(
		maxCompletionTokens: number | undefined,
		requestedMaxTokens: number,
	): Promise<number | undefined> {
		let body: Record<string, unknown> | undefined;
		const fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
			body = init?.body ? (JSON.parse(init.body as string) as Record<string, unknown>) : undefined;
			return anthropicSse();
		}) as typeof fetch;
		const d = perModelDriver({ fetch, maxCompletionTokens });
		await collect(d.chat({ ...baseParams, max_tokens: requestedMaxTokens }));
		return body?.max_tokens as number | undefined;
	}

	it("clamps a requested max_tokens at the ceiling down to cap - 1", async () => {
		// umans rejects max_tokens >= max_completion_tokens; resolution routinely
		// passes the full advertised capacity, so the driver must send cap - 1.
		expect(await sentMaxTokens(131072, 131072)).toBe(131071);
	});

	it("clamps a requested max_tokens above the ceiling down to cap - 1", async () => {
		expect(await sentMaxTokens(131072, 200000)).toBe(131071);
	});

	it("leaves a requested max_tokens below the ceiling unchanged", async () => {
		expect(await sentMaxTokens(131072, 8000)).toBe(8000);
	});

	it("sends the requested value unchanged when the model reports no ceiling", async () => {
		expect(await sentMaxTokens(undefined, 50000)).toBe(50000);
	});
});

// An Anthropic stream that ends with output_tokens=0 and NO content block —
// the shape a dropped relay stream produces (the model emitted nothing before
// the stream closed cleanly).
function emptyAnthropicSse(): Response {
	const events = [
		`event: message_start\ndata: ${JSON.stringify({
			type: "message_start",
			message: {
				id: "msg_empty",
				type: "message",
				role: "assistant",
				model: "umans-coder",
				content: [],
				stop_reason: null,
				usage: { input_tokens: 10, output_tokens: 0 },
			},
		})}\n\n`,
		`event: message_delta\ndata: ${JSON.stringify({
			type: "message_delta",
			delta: { stop_reason: "end_turn" },
			usage: { output_tokens: 0 },
		})}\n\n`,
		`event: message_stop\ndata: ${JSON.stringify({ type: "message_stop" })}\n\n`,
	].join("");
	return new Response(events, {
		status: 200,
		headers: { "content-type": "text/event-stream" },
	});
}

describe("UmansDriver empty-completion retry (dropped-stream recovery)", () => {
	it("re-issues when a stream ends empty (output_tokens=0, no content) then surfaces the retry", async () => {
		// First attempt: empty (dropped stream). Second: a normal completion.
		// The driver must swallow the empty turn and re-issue, so the consumer
		// only ever sees the recovered content — never a silent empty turn that
		// the agent loop would have to treat as degenerate.
		let call = 0;
		const fetch = (async () => {
			call++;
			return call === 1 ? emptyAnthropicSse() : anthropicSse();
		}) as typeof fetch;
		const d = perModelDriver({ fetch });
		const chunks = await collect(d.chat(baseParams));

		expect(call).toBe(2);
		const text = chunks.find((c) => c.type === "text");
		expect(text).toBeDefined();
		const done = chunks.find((c) => c.type === "done");
		expect(done).toBeDefined();
		if (done?.type === "done") {
			expect(done.usage.output_tokens).toBeGreaterThan(0);
		}
	});

	it("gives up after the retry bound and surfaces the empty done rather than looping forever", async () => {
		// Every attempt is empty: the driver must stop at the bound (original +
		// 2 retries = 3 calls) and pass the empty done through, not spin.
		let call = 0;
		const fetch = (async () => {
			call++;
			return emptyAnthropicSse();
		}) as typeof fetch;
		const d = perModelDriver({ fetch });
		const chunks = await collect(d.chat(baseParams));

		expect(call).toBe(3);
		const done = chunks.find((c) => c.type === "done");
		expect(done).toBeDefined();
	});
});

describe("UmansDriver namespace guard (AC.19)", () => {
	it("throws a clear LLMError on first iteration when invoked without a modelId", async () => {
		const account = createUmansAccount({ apiKey: "sk-test" });
		const namespace = new UmansDriver({ account, namespaceId: "umans" });
		let thrown: unknown;
		try {
			for await (const _ of namespace.chat({ messages: [{ role: "user", content: "hi" }] })) {
				// unreachable
			}
		} catch (err) {
			thrown = err;
		}
		expect(thrown).toBeInstanceOf(LLMError);
		expect((thrown as LLMError).message).toContain("not directly invokable");
		// The namespace instance carries readiness.
		expect(namespace.readiness).toBeDefined();
	});
});

describe("UmansDriver concurrency semaphore (AC.11)", () => {
	it("Semaphore caps concurrency and returns to capacity after release", async () => {
		const sema = new Semaphore(2);
		await sema.acquire();
		await sema.acquire();
		expect(sema.permits).toBe(0);
		// Third acquire blocks until a release.
		let third = false;
		const p = sema.acquire().then(() => {
			third = true;
		});
		await flushMicrotasks();
		expect(third).toBe(false);
		sema.release();
		await p;
		expect(third).toBe(true);
		// Releasing the rest returns to capacity exactly (no over-count).
		sema.release();
		sema.release();
		expect(sema.permits).toBe(2);
	});

	it("releases the slot on normal completion (permits back to capacity)", async () => {
		const sema = new Semaphore(1);
		const fetch = (async () => anthropicSse()) as typeof fetch;
		const d = perModelDriver({ fetch, semaphore: sema });
		await collect(d.chat(baseParams));
		expect(sema.permits).toBe(1);
	});

	it("releases the slot on consumer early-break (no permanent leak)", async () => {
		const sema = new Semaphore(1);
		const fetch = (async () => anthropicSse()) as typeof fetch;
		const d = perModelDriver({ fetch, semaphore: sema });
		// Break after the first chunk — the driver's finally must release.
		for await (const _ of d.chat(baseParams)) {
			break;
		}
		// Async-generator cleanup is complete when the loop exits.
		expect(sema.permits).toBe(1);
		expect(sema.permits).toBe(1);
		// A subsequent acquire succeeds (slot freed).
		await sema.acquire();
		expect(sema.permits).toBe(0);
	});

	it("releases the slot when the stream throws", async () => {
		const sema = new Semaphore(1);
		// 400 is non-retryable, so the AI SDK throws immediately rather than
		// retrying a 5xx three times.
		const fetch = (async () =>
			new Response(JSON.stringify({ error: { type: "invalid_request_error", message: "bad" } }), {
				status: 400,
				headers: { "content-type": "application/json" },
			})) as typeof fetch;
		const d = perModelDriver({ fetch, semaphore: sema });
		let threw = false;
		try {
			await collect(d.chat(baseParams));
		} catch {
			threw = true;
		}
		expect(threw).toBe(true);
		expect(sema.permits).toBe(1);
	});
});

describe("UmansDriver boxed_until 429 (AC.13)", () => {
	it("throws LLMError(429) with retryAfterMs when usage reports a future boxed_until", async () => {
		const future = Date.now() + 60_000;
		const usageFetch = (async () => ({
			ok: true as const,
			value: { boxedUntil: future } satisfies UmansUsage,
		})) as typeof import("../umans-metadata").fetchUmansUsage;
		const account = createUmansAccount({ apiKey: "sk-test", usageFetch });
		// Stale cache so maybeRefreshUsage actually refreshes.
		account.usageCache = { fetchedAt: 0 };
		const d = new UmansDriver({
			account,
			modelId: "umans-coder",
			capabilities: {
				streaming: true,
				tool_use: true,
				system_prompt: true,
				prompt_caching: true,
				vision: false,
				extended_thinking: false,
				max_context: 200000,
			},
		});
		let err: unknown;
		try {
			await collect(d.chat(baseParams));
		} catch (e) {
			err = e;
		}
		expect(err).toBeInstanceOf(LLMError);
		expect((err as LLMError).statusCode).toBe(429);
		expect((err as LLMError).retryAfterMs).toBeGreaterThan(0);
	});
});

describe("UmansDriver readiness (AC.6, AC.10)", () => {
	function lineupMeta(): Map<string, UmansModelMeta> {
		return new Map([
			[
				"umans-coder",
				{
					id: "umans-coder",
					contextWindow: 200000,
					maxCompletionTokens: 8192,
					supportsVision: true,
					supportsTools: true,
					reasoningSupported: true,
					reasoningCanDisable: false,
					pricePerMInput: 3,
					pricePerMOutput: 15,
				},
			],
		]);
	}

	it("manually retries after a failed initial attempt and becomes ready", async () => {
		const scheduler = manualScheduler();
		let metaCalls = 0;
		const metadataFetch = (async () => {
			metaCalls++;
			if (metaCalls === 1) return { ok: false as const, error: new Error("transient") };
			return { ok: true as const, value: lineupMeta() };
		}) as typeof import("../umans-metadata").fetchUmansModelMetadata;
		const usageFetch = (async () => ({
			ok: true as const,
			value: { concurrencyLimit: 4 } satisfies UmansUsage,
		})) as typeof import("../umans-metadata").fetchUmansUsage;

		const account = createUmansAccount({ apiKey: "sk-test", metadataFetch, usageFetch, scheduler });
		const namespace = new UmansDriver({ account, namespaceId: "umans" });
		const readiness = namespace.readiness as BackendReadiness;
		let registerCalls = 0;
		readiness.start({
			register() {
				registerCalls++;
			},
		});

		await flushMicrotasks();
		expect(metaCalls).toBe(1);
		expect(scheduler.pending()).toBe(1);
		expect(readiness.isReady()).toBe(false);
		scheduler.advanceBy(999);
		await flushMicrotasks();
		expect(metaCalls).toBe(1);
		scheduler.advanceBy(1);
		await flushMicrotasks();
		expect(metaCalls).toBe(2);
		expect(registerCalls).toBe(1);
		expect(readiness.isReady()).toBe(true);
		expect(account.semaphore.capacity).toBe(4);
	});

	it("disposal cancels the pending readiness retry", async () => {
		const scheduler = manualScheduler();
		let metaCalls = 0;
		const metadataFetch = (async () => {
			metaCalls++;
			return { ok: false as const, error: new Error("transient") };
		}) as typeof import("../umans-metadata").fetchUmansModelMetadata;
		const usageFetch = (async () => ({
			ok: true as const,
			value: {} satisfies UmansUsage,
		})) as typeof import("../umans-metadata").fetchUmansUsage;

		const account = createUmansAccount({ apiKey: "sk-test", metadataFetch, usageFetch, scheduler });
		const namespace = new UmansDriver({ account, namespaceId: "umans" });
		const readiness = namespace.readiness as BackendReadiness;
		let registerCalls = 0;
		readiness.start({
			register() {
				registerCalls++;
			},
		});

		await flushMicrotasks();
		expect(metaCalls).toBe(1);
		expect(scheduler.pending()).toBe(1);
		readiness.dispose();
		expect(scheduler.pending()).toBe(0);
		scheduler.advanceBy(60_000);
		await flushMicrotasks();
		expect(metaCalls).toBe(1);
		expect(registerCalls).toBe(0);
		expect(readiness.isReady()).toBe(false);
	});
});

describe("UmansDriver reasoning_effort injection", () => {
	function captureFetch() {
		const state: { body?: string } = {};
		const fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
			state.body = init?.body as string | undefined;
			return anthropicSse();
		}) as typeof fetch;
		return { fetch, state };
	}

	it("injects a per-call effort as top-level reasoning_effort on the wire", async () => {
		const { fetch, state } = captureFetch();
		const d = perModelDriver({ fetch, reasoningLevels: ["low", "high"] });
		await collect(
			d.chat({ model: "umans-coder", messages: [{ role: "user", content: "hi" }], effort: "high" }),
		);
		expect(state.body).toBeDefined();
		const parsed = JSON.parse(state.body as string);
		expect(parsed.reasoning_effort).toBe("high");
		// No legacy Anthropic thinking block.
		expect(state.body).not.toContain('"thinking"');
	});

	it("falls back to the model default_level when the requested effort isn't an advertised level", async () => {
		const { fetch, state } = captureFetch();
		const d = perModelDriver({ fetch, reasoningLevels: ["low", "high"], reasoningDefault: "low" });
		await collect(
			d.chat({
				model: "umans-coder",
				messages: [{ role: "user", content: "hi" }],
				effort: "ultra",
			}),
		);
		const parsed = JSON.parse(state.body as string);
		expect(parsed.reasoning_effort).toBe("low");
	});

	it("uses the model default_level when a turn supplies no effort", async () => {
		const { fetch, state } = captureFetch();
		const d = perModelDriver({ fetch, reasoningDefault: "medium" });
		await collect(d.chat({ model: "umans-coder", messages: [{ role: "user", content: "hi" }] }));
		const parsed = JSON.parse(state.body as string);
		expect(parsed.reasoning_effort).toBe("medium");
	});

	it("sends NO reasoning_effort when neither effort nor default_level is set", async () => {
		const { fetch, state } = captureFetch();
		const d = perModelDriver({ fetch });
		await collect(d.chat({ model: "umans-coder", messages: [{ role: "user", content: "hi" }] }));
		const parsed = JSON.parse(state.body as string);
		expect(parsed.reasoning_effort).toBeUndefined();
	});

	it("accepts a free-form effort verbatim when the model advertises no levels", async () => {
		const { fetch, state } = captureFetch();
		const d = perModelDriver({ fetch });
		await collect(
			d.chat({
				model: "umans-coder",
				messages: [{ role: "user", content: "hi" }],
				effort: "turbo",
			}),
		);
		const parsed = JSON.parse(state.body as string);
		expect(parsed.reasoning_effort).toBe("turbo");
	});
});
