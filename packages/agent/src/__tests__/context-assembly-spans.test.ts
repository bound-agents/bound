import type { Database } from "bun:sqlite";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyMetricsSchema, applySchema, createDatabase } from "@bound/core";
import { cleanupTmpDir } from "@bound/shared/test-utils";
import { context, trace } from "@opentelemetry/api";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import {
	BasicTracerProvider,
	InMemorySpanExporter,
	SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import { assembleContext } from "../context-assembly";

describe("Context Assembly OTEL Spans", () => {
	let db: Database;
	let tmpDir: string;
	let provider: BasicTracerProvider;
	let exporter: InMemorySpanExporter;
	let userId: string;

	beforeAll(() => {
		tmpDir = mkdtempSync(join(tmpdir(), "context-spans-test-"));
		db = createDatabase(join(tmpDir, "test.db"));
		applySchema(db);
		applyMetricsSchema(db);
		userId = randomUUID();
		db.run(
			"INSERT INTO users (id, display_name, platform_ids, first_seen_at, modified_at, deleted) VALUES (?, ?, ?, ?, ?, ?)",
			[userId, "Test User", null, new Date().toISOString(), new Date().toISOString(), 0],
		);
		context.setGlobalContextManager(new AsyncLocalStorageContextManager().enable());
		exporter = new InMemorySpanExporter();
		provider = new BasicTracerProvider();
		provider.addSpanProcessor(new SimpleSpanProcessor(exporter));
		trace.setGlobalTracerProvider(provider);
	});
	beforeEach(() => exporter.reset());
	afterAll(async () => {
		db.close();
		await cleanupTmpDir(tmpDir);
		await provider.shutdown();
		trace.disable();
		context.disable();
	});

	function createThread(withMessage = true): string {
		const threadId = randomUUID();
		const now = new Date().toISOString();
		db.run(
			"INSERT INTO threads (id, user_id, interface, host_origin, color, title, summary, summary_through, summary_model_id, extracted_through, created_at, last_message_at, modified_at, deleted) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
			[threadId, userId, "web", "local", 0, "Test", null, null, null, null, now, now, now, 0],
		);
		if (withMessage)
			db.run(
				"INSERT INTO messages (id, thread_id, role, content, model_id, tool_name, created_at, modified_at, host_origin, deleted) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
				[randomUUID(), threadId, "user", "hello", null, null, now, now, "local", 0],
			);
		return threadId;
	}

	function assembleUnderParent(threadId: string, params: Record<string, unknown> = {}) {
		const parent = trace.getTracer("test").startSpan("agent-loop.assemble-context");
		context.with(trace.setSpan(context.active(), parent), () =>
			assembleContext({ db, threadId, userId, ...params }),
		);
		parent.end();
		return exporter.getFinishedSpans();
	}

	it("uses exactly three direct durable context children and moves every stage to timed events", () => {
		const spans = assembleUnderParent(createThread());
		const contextSpans = spans.filter((span) => span.name.startsWith("context."));
		expect(contextSpans).toHaveLength(3);
		expect(contextSpans.map((span) => span.name).sort()).toEqual([
			"context.budget",
			"context.contextualize",
			"context.history.prepare",
		]);
		const parent = spans.find((span) => span.name === "agent-loop.assemble-context");
		for (const span of contextSpans) expect(span.parentSpanId).toBe(parent?.spanContext().spanId);
		const events = contextSpans.flatMap((span) => span.events);
		for (const name of [
			"context.stage-1-message-retrieval",
			"context.stage-1.5-retroactive-result-truncation",
			"context.stage-2-purge-substitution",
			"context.stage-2.5-role-filtering",
			"context.stage-3-tool-pair-sanitization",
			"context.stage-4-message-queueing",
			"context.stage-5-annotation",
			"context.stage-5b-content-substitution",
			"context.stage-5.5-volatile-enrichment",
			"context.stage-6-assembly",
			"context.stage-7-budget-validation",
			"context.stage-8-metric-recording",
			"context.helper.annotate-with-tokens",
			"context.helper.tokenize-system-prompt",
			"context.helper.sum-history-tokens",
		]) {
			const event = events.find((candidate) => candidate.name === name);
			expect(event).toBeDefined(name);
			expect(typeof event?.attributes?.["context.elapsed_ms"]).toBe("number");
		}
		const history = contextSpans.find((span) => span.name === "context.history.prepare");
		expect(
			history?.events.find((event) => event.name === "context.stage-1-message-retrieval")
				?.attributes.message_count,
		).toBe(1);
		const budget = contextSpans.find((span) => span.name === "context.budget");
		expect(typeof budget?.attributes["context.total_tokens"]).toBe("number");
		expect(typeof budget?.attributes["context.headroom"]).toBe("number");
	});

	function expectContextSignals(spans: ReturnType<typeof exporter.getFinishedSpans>) {
		const contextSpans = spans.filter((span) => span.name.startsWith("context."));
		expect(contextSpans.length).toBeLessThanOrEqual(4);
		for (const span of contextSpans) {
			for (const event of span.events) {
				if (!event.name.startsWith("context.")) continue;
				expect(typeof event.attributes["context.elapsed_ms"]).toBe("number");
				expect(["ok", "error"]).toContain(event.attributes["context.outcome"]);
			}
		}
	}

	it("keeps the bounded span/event contract through truncation and budget pressure", () => {
		const truncationThread = createThread(false);
		const now = new Date().toISOString();
		for (let i = 0; i < 20; i++) {
			db.run(
				"INSERT INTO messages (id, thread_id, role, content, model_id, tool_name, created_at, modified_at, host_origin, deleted) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
				[
					randomUUID(),
					truncationThread,
					i % 2 === 0 ? "user" : "assistant",
					"word ".repeat(200),
					null,
					null,
					new Date(Date.parse(now) + i * 1000).toISOString(),
					new Date(Date.parse(now) + i * 1000).toISOString(),
					"local",
					0,
				],
			);
		}
		const parent = trace.getTracer("test").startSpan("agent-loop.assemble-context");
		let result: ReturnType<typeof assembleContext>;
		context.with(trace.setSpan(context.active(), parent), () => {
			result = assembleContext({
				db,
				threadId: truncationThread,
				userId,
				contextWindow: 5_000,
				maxOutputTokens: 1_000,
				truncationTargetTokens: 100,
			});
		});
		parent.end();
		if (!result) throw new Error("expected truncation assembly result");
		expect(result.debug.truncated).toBeGreaterThan(0);
		expectContextSignals(exporter.getFinishedSpans());

		exporter.reset();
		const pressureThread = createThread();
		const pressureParent = trace.getTracer("test").startSpan("agent-loop.assemble-context");
		context.with(trace.setSpan(context.active(), pressureParent), () => {
			result = assembleContext({
				db,
				threadId: pressureThread,
				userId,
				contextWindow: 10_000,
				maxOutputTokens: 1_000,
				toolTokenEstimate: 9_500,
			});
		});
		pressureParent.end();
		if (!result) throw new Error("expected budget-pressure assembly result");
		expect(result.debug.budgetPressure).toBe(true);
		expectContextSignals(exporter.getFinishedSpans());
	});

	it("records an error event and status on the owning span without replacing the exception", () => {
		const parent = trace.getTracer("test").startSpan("agent-loop.assemble-context");
		const failure = new Error("forced stage failure");
		expect(() =>
			context.with(trace.setSpan(context.active(), parent), () =>
				assembleContext({
					db: new Proxy(db, {
						get(target, property, receiver) {
							if (property === "query")
								return () => {
									throw failure;
								};
							return Reflect.get(target, property, receiver);
						},
					}) as Database,
					threadId: createThread(),
					userId,
				}),
			),
		).toThrow(failure);
		parent.end();
		const spans = exporter.getFinishedSpans();
		expectContextSignals(spans);
		const history = spans.find((span) => span.name === "context.history.prepare");
		const event = history?.events.find(
			(candidate) => candidate.name === "context.stage-1-message-retrieval",
		);
		expect(event?.attributes["context.outcome"]).toBe("error");
		expect(event?.attributes["context.error"]).toContain("forced stage failure");
		expect(history?.status.code).toBe(2);
	});

	it("keeps optional no-history contextualization and budget events on durable spans", () => {
		const spans = assembleUnderParent(createThread(false), { noHistory: true });
		const contextualize = spans.find((span) => span.name === "context.contextualize");
		const budget = spans.find((span) => span.name === "context.budget");
		expect(
			contextualize?.events.some((event) => event.name === "context.stage-5.5-volatile-enrichment"),
		).toBe(true);
		expect(budget?.events.some((event) => event.name === "context.stage-7-budget-validation")).toBe(
			true,
		);
		expect(budget?.events.some((event) => event.name === "context.stage-8-metric-recording")).toBe(
			true,
		);
	});
});
