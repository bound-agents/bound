import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { context, trace } from "@opentelemetry/api";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import {
	BasicTracerProvider,
	InMemorySpanExporter,
	SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import {
	bindAsyncIterable,
	setLlmDriverMetricRecorderForTest,
	withEmptyRetry,
} from "../drivers/shared";
import type { StreamChunk } from "../types";

function emptyDone(): StreamChunk {
	return {
		type: "done",
		usage: {
			input_tokens: 1,
			output_tokens: 0,
			cache_write_tokens: null,
			cache_read_tokens: null,
			estimated: false,
		},
	};
}

function textChunk(text: string): StreamChunk {
	return { type: "text", text };
}

describe("LLM driver metrics", () => {
	let exporter: InMemorySpanExporter;
	let provider: BasicTracerProvider;

	beforeEach(() => {
		exporter = new InMemorySpanExporter();
		provider = new BasicTracerProvider();
		provider.addSpanProcessor(new SimpleSpanProcessor(exporter));
		provider.register({ contextManager: new AsyncLocalStorageContextManager() });
	});

	afterEach(async () => {
		setLlmDriverMetricRecorderForTest();
		await provider.shutdown();
		trace.disable();
	});

	it("records attempts, retries, and the final empty outcome", async () => {
		const records: Array<{
			name: string;
			value: number;
			attributes: Record<string, string>;
		}> = [];
		setLlmDriverMetricRecorderForTest((name, value, attributes) =>
			records.push({ name, value, attributes }),
		);
		let attempts = 0;

		async function* run(): AsyncIterable<StreamChunk> {
			attempts++;
			yield emptyDone();
		}

		const chunks: StreamChunk[] = [];
		for await (const chunk of withEmptyRetry(run, {
			maxRetries: 1,
			isAborted: () => false,
		})) {
			chunks.push(chunk);
		}

		expect(attempts).toBe(2);
		expect(chunks).toHaveLength(1);
		expect(records).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					name: "attempt",
					value: 1,
					attributes: expect.objectContaining({ outcome: "retry" }),
				}),
				expect.objectContaining({
					name: "retry",
					value: 1,
					attributes: expect.objectContaining({ reason: "empty_completion" }),
				}),
				expect.objectContaining({
					name: "attempt",
					value: 1,
					attributes: expect.objectContaining({ outcome: "empty" }),
				}),
			]),
		);
		setLlmDriverMetricRecorderForTest();
	});

	it("traces every physical backend request and annotates empty retries", async () => {
		let attempts = 0;
		async function* run(): AsyncIterable<StreamChunk> {
			attempts++;
			yield emptyDone();
		}

		for await (const _chunk of withEmptyRetry(run, {
			maxRetries: 1,
			isAborted: () => false,
			providerName: "test-provider",
		})) {
			// Consume the terminal response.
		}

		expect(attempts).toBe(2);
		const spans = exporter
			.getFinishedSpans()
			.filter((span) => span.name === "llm.provider.request");
		expect(spans).toHaveLength(2);
		expect(spans.map((span) => span.attributes["llm.provider"])).toEqual([
			"test-provider",
			"test-provider",
		]);
		expect(spans[0]?.events).toContainEqual(
			expect.objectContaining({
				name: "llm.retry",
				attributes: { "llm.retry.reason": "empty_completion" },
			}),
		);
	});

	it("keeps the physical request span active for provider creation and iterator advances", async () => {
		const activeSpanIds: string[] = [];
		async function* run(): AsyncIterable<StreamChunk> {
			activeSpanIds.push(trace.getSpan(context.active())?.spanContext().spanId ?? "missing");
			yield textChunk("first");
			activeSpanIds.push(trace.getSpan(context.active())?.spanContext().spanId ?? "missing");
			yield emptyDone();
		}

		for await (const _chunk of withEmptyRetry(run, {
			maxRetries: 0,
			isAborted: () => false,
			providerName: "test-provider",
		})) {
			// Advance the wrapped provider iterator through all chunks.
		}

		const request = exporter
			.getFinishedSpans()
			.find((span) => span.name === "llm.provider.request");
		expect(request).toBeDefined();
		expect(activeSpanIds).toEqual([request?.spanContext().spanId, request?.spanContext().spanId]);
	});

	it("parents the physical request to the context that creates an asynchronously consumed stream", async () => {
		const parent = trace.getTracer("test").startSpan("agent-loop.turn");
		const parentContext = trace.setSpan(context.active(), parent);
		const stream = context.with(parentContext, () =>
			withEmptyRetry(
				async function* (): AsyncIterable<StreamChunk> {
					yield textChunk("first");
					yield emptyDone();
				},
				{ maxRetries: 0, isAborted: () => false, providerName: "test-provider" },
			),
		);

		for await (const _chunk of stream) {
			// Consume after the originating agent-loop context has left scope.
		}
		parent.end();

		const request = exporter
			.getFinishedSpans()
			.find((span) => span.name === "llm.provider.request");
		expect(request?.parentSpanId).toBe(parent.spanContext().spanId);
	});

	it("keeps a provider request under the context that creates a deferred driver stream", async () => {
		const parent = trace.getTracer("test").startSpan("agent-loop.turn");
		const parentContext = trace.setSpan(context.active(), parent);
		const stream = context.with(parentContext, () =>
			bindAsyncIterable(
				context.active(),
				(async function* (): AsyncIterable<StreamChunk> {
					yield* withEmptyRetry(
						async function* (): AsyncIterable<StreamChunk> {
							yield textChunk("first");
							yield emptyDone();
						},
						{ maxRetries: 0, isAborted: () => false, providerName: "test-provider" },
					);
				})(),
			),
		);

		for await (const _chunk of stream) {
			// The timeout/relay consumer advances the stream after the creating scope exits.
		}
		parent.end();

		const request = exporter
			.getFinishedSpans()
			.find((span) => span.name === "llm.provider.request");
		expect(request?.parentSpanId).toBe(parent.spanContext().spanId);
	});

	it("records the same aborted outcome on the request span and metric", async () => {
		const records: Array<{
			name: string;
			value: number;
			attributes: Record<string, string>;
		}> = [];
		setLlmDriverMetricRecorderForTest((name, value, attributes) =>
			records.push({ name, value, attributes }),
		);
		let aborted = false;
		async function* run(): AsyncIterable<StreamChunk> {
			yield textChunk("partial");
			aborted = true;
		}

		for await (const _chunk of withEmptyRetry(run, {
			maxRetries: 0,
			isAborted: () => aborted,
			providerName: "test-provider",
		})) {
			// Consume the partial response.
		}

		const request = exporter
			.getFinishedSpans()
			.find((span) => span.name === "llm.provider.request");
		expect(request?.attributes["llm.outcome"]).toBe("aborted");
		expect(records).toContainEqual({
			name: "attempt",
			value: 1,
			attributes: { provider: "test-provider", model: "unknown", outcome: "aborted" },
		});
	});

	it("records duration, TTFT, usage/cache tokens, cost, and bounded dimensions", async () => {
		const records: Array<{
			name: string;
			value: number;
			attributes: Record<string, string>;
		}> = [];
		setLlmDriverMetricRecorderForTest((name, value, attributes) =>
			records.push({ name, value, attributes }),
		);
		async function* run(): AsyncIterable<StreamChunk> {
			yield textChunk("hello");
			yield {
				type: "done",
				usage: {
					input_tokens: 10,
					output_tokens: 2,
					cache_write_tokens: 3,
					cache_read_tokens: 4,
					estimated: false,
				},
				cost_usd: 0.125,
			};
		}

		for await (const _chunk of withEmptyRetry(run, {
			maxRetries: 0,
			isAborted: () => false,
			providerName: "test-provider",
			modelId: "test-model",
		})) {
			// Consume.
		}

		expect(records).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					name: "duration",
					attributes: { provider: "test-provider", model: "test-model", outcome: "success" },
				}),
				expect.objectContaining({
					name: "ttft",
					attributes: { provider: "test-provider", model: "test-model" },
				}),
				{
					name: "tokens",
					value: 10,
					attributes: { provider: "test-provider", model: "test-model", type: "input" },
				},
				{
					name: "tokens",
					value: 2,
					attributes: { provider: "test-provider", model: "test-model", type: "output" },
				},
				{
					name: "tokens",
					value: 3,
					attributes: { provider: "test-provider", model: "test-model", type: "cache_write" },
				},
				{
					name: "tokens",
					value: 4,
					attributes: { provider: "test-provider", model: "test-model", type: "cache_read" },
				},
				{
					name: "cost",
					value: 0.125,
					attributes: { provider: "test-provider", model: "test-model" },
				},
			]),
		);
	});
});
