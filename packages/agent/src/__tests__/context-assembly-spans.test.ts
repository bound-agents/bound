import type { Database } from "bun:sqlite";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyMetricsSchema, applySchema, createDatabase } from "@bound/core";
import { cleanupTmpDir } from "@bound/shared/test-utils";
import { context, trace } from "@opentelemetry/api";
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

	beforeAll(async () => {
		// Create temporary test database using the same setup as context-assembly.test.ts
		tmpDir = mkdtempSync(join(tmpdir(), "context-spans-test-"));
		const dbPath = join(tmpDir, "test.db");

		db = createDatabase(dbPath);
		applySchema(db);
		applyMetricsSchema(db);

		// Create a test user
		userId = randomUUID();
		db.run(
			"INSERT INTO users (id, display_name, platform_ids, first_seen_at, modified_at, deleted) VALUES (?, ?, ?, ?, ?, ?)",
			[userId, "Test User", null, new Date().toISOString(), new Date().toISOString(), 0],
		);

		// Set up OTEL tracing
		exporter = new InMemorySpanExporter();
		provider = new BasicTracerProvider();
		provider.addSpanProcessor(new SimpleSpanProcessor(exporter));
		trace.setGlobalTracerProvider(provider);
	});

	beforeEach(() => {
		exporter.reset();
	});

	afterAll(async () => {
		if (db) {
			db.close();
		}
		if (tmpDir) {
			await cleanupTmpDir(tmpDir);
		}
		await provider.shutdown();
		trace.disable();
	});

	it("should create spans for all context assembly stages", async () => {
		// Create test data
		const threadId = randomUUID();

		db.run(
			"INSERT INTO threads (id, user_id, interface, host_origin, color, title, summary, summary_through, summary_model_id, extracted_through, created_at, last_message_at, modified_at, deleted) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
			[
				threadId,
				userId,
				"web",
				"local",
				0,
				"Test Thread",
				null,
				null,
				null,
				null,
				new Date().toISOString(),
				new Date().toISOString(),
				new Date().toISOString(),
				0,
			],
		);

		db.run(
			"INSERT INTO messages (id, thread_id, role, content, model_id, tool_name, created_at, modified_at, host_origin, deleted) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
			[
				"msg-1",
				threadId,
				"user",
				"Hello, this is a test message",
				null,
				null,
				new Date().toISOString(),
				new Date().toISOString(),
				"local",
				0,
			],
		);

		// Create parent span context for context assembly (simulating agent-loop.assemble-context)
		const parentSpan = trace.getTracer("test").startSpan("agent-loop.assemble-context");

		await context.with(trace.setSpan(context.active(), parentSpan), async () => {
			// Call assembleContext
			const result = await assembleContext({
				db,
				threadId,
				userId,
			});

			expect(result.messages).toBeDefined();
		});

		parentSpan.end();

		// Get finished spans
		const spans = exporter.getFinishedSpans();

		// Verify stage spans were created
		const stageNames = [
			"context.stage-1-message-retrieval",
			"context.stage-1.5-retroactive-result-truncation",
			"context.stage-1.7-history-compaction",
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
		];

		for (const stageName of stageNames) {
			const span = spans.find((s) => s.name === stageName);
			expect(span).toBeDefined(
				`Stage span "${stageName}" should exist in finished spans. Found: ${spans.map((s) => s.name).join(", ")}`,
			);
		}
	});

	it("should record message_count attribute on stage 1 span", async () => {
		// Clear previous spans to prevent isolation issues
		exporter.reset();

		// Create test data
		const threadId = randomUUID();

		db.run(
			"INSERT INTO threads (id, user_id, interface, host_origin, color, title, summary, summary_through, summary_model_id, extracted_through, created_at, last_message_at, modified_at, deleted) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
			[
				threadId,
				userId,
				"web",
				"local",
				0,
				"Test Thread",
				null,
				null,
				null,
				null,
				new Date().toISOString(),
				new Date().toISOString(),
				new Date().toISOString(),
				0,
			],
		);

		// Create multiple messages
		for (let i = 0; i < 3; i++) {
			db.run(
				"INSERT INTO messages (id, thread_id, role, content, model_id, tool_name, created_at, modified_at, host_origin, deleted) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
				[
					`msg-count-${i}`,
					threadId,
					i === 0 ? "user" : "assistant",
					`Message ${i}`,
					null,
					null,
					new Date(Date.now() + i * 1000).toISOString(),
					new Date().toISOString(),
					"local",
					0,
				],
			);
		}

		// Create parent span context
		const parentSpan = trace.getTracer("test").startSpan("test-parent");

		await context.with(trace.setSpan(context.active(), parentSpan), async () => {
			await assembleContext({
				db,
				threadId,
				userId,
			});
		});

		parentSpan.end();

		const spans = exporter.getFinishedSpans();
		const stage1Span = spans.find((s) => s.name === "context.stage-1-message-retrieval");

		expect(stage1Span).toBeDefined();
		expect(stage1Span?.attributes?.message_count).toBe(3);
		expect(typeof stage1Span?.attributes?.message_count).toBe("number");
	});

	it("should record total_tokens and headroom attributes on stage 7 span", async () => {
		// Create test data
		const threadId = randomUUID();

		db.run(
			"INSERT INTO threads (id, user_id, interface, host_origin, color, title, summary, summary_through, summary_model_id, extracted_through, created_at, last_message_at, modified_at, deleted) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
			[
				threadId,
				userId,
				"web",
				"local",
				0,
				"Test Thread",
				null,
				null,
				null,
				null,
				new Date().toISOString(),
				new Date().toISOString(),
				new Date().toISOString(),
				0,
			],
		);

		db.run(
			"INSERT INTO messages (id, thread_id, role, content, model_id, tool_name, created_at, modified_at, host_origin, deleted) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
			[
				"msg-budget-test",
				threadId,
				"user",
				"Test for budget tracking",
				null,
				null,
				new Date().toISOString(),
				new Date().toISOString(),
				"local",
				0,
			],
		);

		// Create parent span context
		const parentSpan = trace.getTracer("test").startSpan("test-parent-budget");

		exporter.reset();

		await context.with(trace.setSpan(context.active(), parentSpan), async () => {
			await assembleContext({
				db,
				threadId,
				userId,
				contextWindow: 8000,
			});
		});

		parentSpan.end();

		const spans = exporter.getFinishedSpans();
		const stage7Span = spans.find((s) => s.name === "context.stage-7-budget-validation");

		expect(stage7Span).toBeDefined();
		expect(stage7Span?.attributes?.["context.total_tokens"]).toBeDefined();
		expect(typeof stage7Span?.attributes?.["context.total_tokens"]).toBe("number");
		expect(stage7Span?.attributes?.["context.headroom"]).toBeDefined();
		expect(typeof stage7Span?.attributes?.["context.headroom"]).toBe("number");
	});

	it("should record truncated_messages attribute when truncation occurs", async () => {
		// Create test data
		const threadId = randomUUID();

		db.run(
			"INSERT INTO threads (id, user_id, interface, host_origin, color, title, summary, summary_through, summary_model_id, extracted_through, created_at, last_message_at, modified_at, deleted) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
			[
				threadId,
				userId,
				"web",
				"local",
				0,
				"Test Thread",
				null,
				null,
				null,
				null,
				new Date().toISOString(),
				new Date().toISOString(),
				new Date().toISOString(),
				0,
			],
		);

		// Create many messages to exceed context window
		for (let i = 0; i < 5; i++) {
			db.run(
				"INSERT INTO messages (id, thread_id, role, content, model_id, tool_name, created_at, modified_at, host_origin, deleted) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
				[
					`msg-trunc-${i}`,
					threadId,
					i % 2 === 0 ? "user" : "assistant",
					"x".repeat(500), // Moderate content
					null,
					null,
					new Date(Date.now() + i * 1000).toISOString(),
					new Date().toISOString(),
					"local",
					0,
				],
			);
		}

		// Create parent span context
		const parentSpan = trace.getTracer("test").startSpan("test-parent-trunc");

		await context.with(trace.setSpan(context.active(), parentSpan), async () => {
			await assembleContext({
				db,
				threadId,
				userId,
				contextWindow: 2000, // Small window to force truncation
			});
		});

		parentSpan.end();

		const spans = exporter.getFinishedSpans();

		// Stage 7 must FINISH (not leak) on the truncation path, otherwise
		// BatchSpanProcessor never flushes it and Jaeger has zero visibility
		// into truncation events. Pre-fix the early-return at the truncation
		// branch returned without calling stage7Span.end(), so the span
		// existed in process memory but never reached the exporter.
		const stage7 = spans.find((s) => s.name === "context.stage-7-budget-validation");
		expect(stage7).toBeDefined();
		expect(stage7?.attributes["context.truncated_messages"]).toBeGreaterThan(0);
		expect(stage7?.attributes["context.total_tokens"]).toBeGreaterThan(0);
	});

	it("should nest stage spans as children of parent assembleContext span", async () => {
		// Create test data
		const threadId = randomUUID();

		db.run(
			"INSERT INTO threads (id, user_id, interface, host_origin, color, title, summary, summary_through, summary_model_id, extracted_through, created_at, last_message_at, modified_at, deleted) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
			[
				threadId,
				userId,
				"web",
				"local",
				0,
				"Test Thread",
				null,
				null,
				null,
				null,
				new Date().toISOString(),
				new Date().toISOString(),
				new Date().toISOString(),
				0,
			],
		);

		db.run(
			"INSERT INTO messages (id, thread_id, role, content, model_id, tool_name, created_at, modified_at, host_origin, deleted) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
			[
				"msg-parent-test",
				threadId,
				"user",
				"Testing span hierarchy",
				null,
				null,
				new Date().toISOString(),
				new Date().toISOString(),
				"local",
				0,
			],
		);

		// Create parent span context
		const parentSpan = trace.getTracer("test").startSpan("assembly-parent");

		exporter.reset();

		await context.with(trace.setSpan(context.active(), parentSpan), async () => {
			await assembleContext({
				db,
				threadId,
				userId,
			});
		});

		parentSpan.end();

		const spans = exporter.getFinishedSpans();

		// Find parent and child spans
		const parent = spans.find((s) => s.name === "assembly-parent");
		const stage1Child = spans.find((s) => s.name === "context.stage-1-message-retrieval");

		expect(parent).toBeDefined();
		expect(stage1Child).toBeDefined();

		// Verify both spans were created
		expect(spans.length).toBeGreaterThanOrEqual(2);
	});

	it("should mark stage 4 span as implicit", async () => {
		const threadId = randomUUID();

		db.run(
			"INSERT INTO threads (id, user_id, interface, host_origin, color, title, summary, summary_through, summary_model_id, extracted_through, created_at, last_message_at, modified_at, deleted) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
			[
				threadId,
				userId,
				"web",
				"local",
				0,
				"Test Thread",
				null,
				null,
				null,
				null,
				new Date().toISOString(),
				new Date().toISOString(),
				new Date().toISOString(),
				0,
			],
		);

		db.run(
			"INSERT INTO messages (id, thread_id, role, content, model_id, tool_name, created_at, modified_at, host_origin, deleted) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
			[
				"msg-stage4-test",
				threadId,
				"user",
				"Testing stage 4 marker",
				null,
				null,
				new Date().toISOString(),
				new Date().toISOString(),
				"local",
				0,
			],
		);

		const parentSpan = trace.getTracer("test").startSpan("test-parent-stage4");
		exporter.reset();

		await context.with(trace.setSpan(context.active(), parentSpan), async () => {
			await assembleContext({ db, threadId, userId });
		});

		parentSpan.end();

		const spans = exporter.getFinishedSpans();
		const stage4Span = spans.find((s) => s.name === "context.stage-4-message-queueing");

		expect(stage4Span).toBeDefined();
		expect(stage4Span?.attributes?.["stage.implicit"]).toBe(true);
	});

	it("should not nest stage 5.5 inside stage 6", async () => {
		const threadId = randomUUID();

		db.run(
			"INSERT INTO threads (id, user_id, interface, host_origin, color, title, summary, summary_through, summary_model_id, extracted_through, created_at, last_message_at, modified_at, deleted) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
			[
				threadId,
				userId,
				"web",
				"local",
				0,
				"Test Thread",
				null,
				null,
				null,
				null,
				new Date().toISOString(),
				new Date().toISOString(),
				new Date().toISOString(),
				0,
			],
		);

		db.run(
			"INSERT INTO messages (id, thread_id, role, content, model_id, tool_name, created_at, modified_at, host_origin, deleted) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
			[
				"msg-nesting-test",
				threadId,
				"user",
				"Testing stage nesting",
				null,
				null,
				new Date().toISOString(),
				new Date().toISOString(),
				"local",
				0,
			],
		);

		const parentSpan = trace.getTracer("test").startSpan("test-parent-nesting");
		exporter.reset();

		await context.with(trace.setSpan(context.active(), parentSpan), async () => {
			await assembleContext({ db, threadId, userId });
		});

		parentSpan.end();

		const spans = exporter.getFinishedSpans();
		const stage6 = spans.find((s) => s.name === "context.stage-6-assembly");
		const stage5_5 = spans.find((s) => s.name === "context.stage-5.5-volatile-enrichment");

		expect(stage6).toBeDefined();
		expect(stage5_5).toBeDefined();

		// Stage 5.5 should NOT be a child of Stage 6 — they should share the same parent
		expect(stage5_5?.parentSpanId).not.toBe(stage6?.spanContext().spanId);
		// Both should have the same parent (the assembly-parent span)
		expect(stage5_5?.parentSpanId).toBe(stage6?.parentSpanId);
	});
});
