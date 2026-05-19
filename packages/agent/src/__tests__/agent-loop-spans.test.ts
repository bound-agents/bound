import type { Database } from "bun:sqlite";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyMetricsSchema, applySchema, createDatabase, insertRow } from "@bound/core";
import type { AppContext, EventBusImpl } from "@bound/core";
import type { LLMBackend, StreamChunk } from "@bound/llm";
import { ModelRouter } from "@bound/llm";
import { cleanupTmpDir } from "@bound/shared/test-utils";
import { trace } from "@opentelemetry/api";
import {
	BasicTracerProvider,
	InMemorySpanExporter,
	SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import { AgentLoop } from "../agent-loop";

// Mock LLM Backend that returns configurable responses
class MockLLMBackend implements LLMBackend {
	private responses: Array<() => AsyncGenerator<StreamChunk>> = [];
	private callCount = 0;

	/** Push a response generator that will be used on the next chat() call */
	pushResponse(gen: () => AsyncGenerator<StreamChunk>) {
		this.responses.push(gen);
	}

	/** Set a single text response (convenience) */
	setTextResponse(text: string) {
		this.responses = [];
		this.pushResponse(async function* () {
			yield { type: "text" as const, content: text };
			yield {
				type: "done" as const,
				usage: {
					input_tokens: 10,
					output_tokens: 5,
					cache_write_tokens: null,
					cache_read_tokens: null,
					estimated: false,
				},
			};
		});
	}

	getCallCount() {
		return this.callCount;
	}

	async *chat() {
		const gen = this.responses[this.callCount];
		this.callCount++;
		if (gen) {
			yield* gen();
		} else {
			// Default: empty text response
			yield { type: "text" as const, content: "" };
			yield {
				type: "done" as const,
				usage: {
					input_tokens: 0,
					output_tokens: 0,
					cache_write_tokens: null,
					cache_read_tokens: null,
					estimated: false,
				},
			};
		}
	}

	capabilities() {
		return {
			streaming: true,
			tool_use: true,
			system_prompt: true,
			prompt_caching: false,
			vision: false,
			max_context: 8000,
		};
	}
}

// Mock sandbox
function createMockSandbox() {
	return {
		exec: async (_cmd: string) => {
			return { stdout: "mock output", stderr: "", exitCode: 0 };
		},
	};
}

describe("Agent Loop OTEL Spans", () => {
	let tmpDir: string;
	let dbPath: string;
	let db: Database;
	let threadId: string;
	let userId: string;
	let exporter: InMemorySpanExporter;
	let provider: BasicTracerProvider;

	beforeAll(async () => {
		tmpDir = mkdtempSync(join(tmpdir(), "agent-spans-test-"));
		dbPath = join(tmpDir, "test.db");
		db = createDatabase(dbPath);
		applySchema(db);
		applyMetricsSchema(db);

		// Create a test user
		userId = randomUUID();
		insertRow(
			db,
			"users",
			{
				id: userId,
				display_name: "Test User",
				platform_ids: null,
				first_seen_at: new Date().toISOString(),
				modified_at: new Date().toISOString(),
				deleted: 0,
			},
			userId,
		);

		// Set up OTEL tracing
		exporter = new InMemorySpanExporter();
		provider = new BasicTracerProvider();
		provider.addSpanProcessor(new SimpleSpanProcessor(exporter));
		trace.setGlobalTracerProvider(provider);
	});

	beforeEach(() => {
		threadId = randomUUID();
		exporter.reset();
	});

	afterAll(async () => {
		db.close();
		if (tmpDir) {
			await cleanupTmpDir(tmpDir);
		}
		await provider.shutdown();
	});

	function makeCtx(): AppContext {
		const eventBus: Partial<EventBusImpl> = {
			on: () => {},
			off: () => {},
			emit: () => {},
		};
		return {
			db,
			logger: {
				debug: () => {},
				info: () => {},
				warn: () => {},
				error: () => {},
			},
			eventBus: eventBus as EventBusImpl,
			hostName: "test-host",
			siteId: userId,
			config: {
				modelBackends: {
					backends: [
						{
							id: "local-test",
							name: "test",
							type: "local" as const,
							models: ["test-model"],
						},
					],
					default: "local-test",
				},
			},
			turnStateStore: new Map(),
		} as unknown as AppContext;
	}

	it("should create agent-loop.turn spans with thread and task attributes", async () => {
		// Create a test thread and user message
		insertRow(
			db,
			"threads",
			{
				id: threadId,
				user_id: userId,
				interface: "web",
				host_origin: "local",
				color: 0,
				title: "Test Thread",
				summary: null,
				summary_through: null,
				summary_model_id: null,
				extracted_through: null,
				created_at: new Date().toISOString(),
				last_message_at: new Date().toISOString(),
				modified_at: new Date().toISOString(),
				deleted: 0,
			},
			userId,
		);

		insertRow(
			db,
			"messages",
			{
				id: randomUUID(),
				thread_id: threadId,
				role: "user",
				content: "Hello, agent!",
				model_id: null,
				tool_name: null,
				created_at: new Date().toISOString(),
				modified_at: new Date().toISOString(),
				host_origin: "local",
				deleted: 0,
			},
			userId,
		);

		const backend = new MockLLMBackend();
		backend.setTextResponse("Hello, user!");

		const router = new ModelRouter(new Map([["test-model", backend]]), "test-model");
		const ctx = makeCtx();
		const sandbox = createMockSandbox();

		const loop = new AgentLoop(ctx, sandbox as any, router, {
			threadId,
			userId,
			modelId: "test-model",
		});

		await loop.run();

		// Verify turn span was created
		const spans = exporter.getFinishedSpans();
		const turnSpan = spans.find((s) => s.name === "agent-loop.turn");

		expect(turnSpan).toBeDefined();
		expect(turnSpan?.attributes?.["thread.id"]).toBe(threadId);
	});

	it("should record model and token attributes on turn span", async () => {
		// Create test thread and message
		insertRow(
			db,
			"threads",
			{
				id: threadId,
				user_id: userId,
				interface: "web",
				host_origin: "local",
				color: 0,
				title: "Test Thread 2",
				summary: null,
				summary_through: null,
				summary_model_id: null,
				extracted_through: null,
				created_at: new Date().toISOString(),
				last_message_at: new Date().toISOString(),
				modified_at: new Date().toISOString(),
				deleted: 0,
			},
			userId,
		);

		insertRow(
			db,
			"messages",
			{
				id: randomUUID(),
				thread_id: threadId,
				role: "user",
				content: "Test message",
				model_id: null,
				tool_name: null,
				created_at: new Date().toISOString(),
				modified_at: new Date().toISOString(),
				host_origin: "local",
				deleted: 0,
			},
			userId,
		);

		const backend = new MockLLMBackend();
		backend.setTextResponse("Response");

		const router = new ModelRouter(new Map([["test-model", backend]]), "test-model");
		const ctx = makeCtx();
		const sandbox = createMockSandbox();

		const loop = new AgentLoop(ctx, sandbox as any, router, {
			threadId,
			userId,
			modelId: "test-model",
		});

		await loop.run();

		// Verify turn span has token attributes
		const spans = exporter.getFinishedSpans();
		const turnSpan = spans.find((s) => s.name === "agent-loop.turn");

		expect(turnSpan?.attributes?.["llm.input_tokens"]).toBeDefined();
		expect(turnSpan?.attributes?.["llm.output_tokens"]).toBeDefined();
		expect(typeof turnSpan?.attributes?.["llm.input_tokens"]).toBe("number");
		expect(typeof turnSpan?.attributes?.["llm.output_tokens"]).toBe("number");
	});

	it("should create context assembly spans during agent turn", async () => {
		// Create test thread and message
		insertRow(
			db,
			"threads",
			{
				id: threadId,
				user_id: userId,
				interface: "web",
				host_origin: "local",
				color: 0,
				title: "Test Thread 3",
				summary: null,
				summary_through: null,
				summary_model_id: null,
				extracted_through: null,
				created_at: new Date().toISOString(),
				last_message_at: new Date().toISOString(),
				modified_at: new Date().toISOString(),
				deleted: 0,
			},
			userId,
		);

		insertRow(
			db,
			"messages",
			{
				id: randomUUID(),
				thread_id: threadId,
				role: "user",
				content: "Another test",
				model_id: null,
				tool_name: null,
				created_at: new Date().toISOString(),
				modified_at: new Date().toISOString(),
				host_origin: "local",
				deleted: 0,
			},
			userId,
		);

		const backend = new MockLLMBackend();
		backend.setTextResponse("Done");

		const router = new ModelRouter(new Map([["test-model", backend]]), "test-model");
		const ctx = makeCtx();
		const sandbox = createMockSandbox();

		const loop = new AgentLoop(ctx, sandbox as any, router, {
			threadId,
			userId,
			modelId: "test-model",
		});

		await loop.run();

		// Verify context assembly spans were created
		const spans = exporter.getFinishedSpans();

		// Check for stage spans
		const stageSpanNames = [
			"context.stage-1-message-retrieval",
			"context.stage-2-purge-substitution",
		];

		for (const stageName of stageSpanNames) {
			const stageSpan = spans.find((s) => s.name === stageName);
			expect(stageSpan).toBeDefined(`Stage span "${stageName}" should exist in finished spans`);
		}
	});
});
