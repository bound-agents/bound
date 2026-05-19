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

	/** Set a heartbeat + text + done response (for TTFT testing) */
	setHeartbeatTextResponse(text: string) {
		this.responses = [];
		this.pushResponse(async function* () {
			yield { type: "heartbeat" as const };
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

	/** Set a single text response */
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

describe("LLM Driver Spans (OTEL)", () => {
	let tmpDir: string;
	let dbPath: string;
	let db: Database;
	let threadId: string;
	let userId: string;
	let exporter: InMemorySpanExporter;
	let provider: BasicTracerProvider;

	beforeAll(async () => {
		tmpDir = mkdtempSync(join(tmpdir(), "llm-driver-spans-test-"));
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
		trace.disable();
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

	it("should create llm-driver.chat child span under agent-loop.llm-call", async () => {
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

		// Verify spans were created
		const spans = exporter.getFinishedSpans();
		const llmCallSpan = spans.find((s) => s.name === "agent-loop.llm-call");
		const driverSpan = spans.find((s) => s.name === "llm-driver.chat");

		expect(llmCallSpan).toBeDefined();
		expect(driverSpan).toBeDefined();
		// Verify parent-child nesting: driverSpan is child of llmCallSpan
		expect(driverSpan?.parentSpanId).toBe(llmCallSpan?.spanContext().spanId);
	});

	it("should record llm-driver.chat attributes (model, provider)", async () => {
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
				content: "Test",
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

		const spans = exporter.getFinishedSpans();
		const driverSpan = spans.find((s) => s.name === "llm-driver.chat");

		expect(driverSpan).toBeDefined();
		expect(driverSpan?.attributes?.["llm.model"]).toBeDefined();
		expect(driverSpan?.attributes?.["llm.provider"]).toBe("local");
	});

	it("should record time-to-first-token event on first non-heartbeat chunk", async () => {
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
				title: "Test Thread TTFT",
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
				content: "Test TTFT",
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
		backend.setHeartbeatTextResponse("Response with heartbeat");

		const router = new ModelRouter(new Map([["test-model", backend]]), "test-model");
		const ctx = makeCtx();
		const sandbox = createMockSandbox();

		const loop = new AgentLoop(ctx, sandbox as any, router, {
			threadId,
			userId,
			modelId: "test-model",
		});

		await loop.run();

		const spans = exporter.getFinishedSpans();
		const driverSpan = spans.find((s) => s.name === "llm-driver.chat");

		expect(driverSpan).toBeDefined();
		expect(driverSpan?.events).toBeDefined();

		const ttftEvent = driverSpan?.events?.find((e) => e.name === "time-to-first-token");
		expect(ttftEvent).toBeDefined("Should have time-to-first-token event");
	});

	it("should record completion event with token counts", async () => {
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
				title: "Test Thread Completion",
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
				content: "Test completion",
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
		backend.setTextResponse("Test response");

		const router = new ModelRouter(new Map([["test-model", backend]]), "test-model");
		const ctx = makeCtx();
		const sandbox = createMockSandbox();

		const loop = new AgentLoop(ctx, sandbox as any, router, {
			threadId,
			userId,
			modelId: "test-model",
		});

		await loop.run();

		const spans = exporter.getFinishedSpans();
		const driverSpan = spans.find((s) => s.name === "llm-driver.chat");

		expect(driverSpan).toBeDefined();
		expect(driverSpan?.events).toBeDefined();

		const completionEvent = driverSpan?.events?.find((e) => e.name === "completion");
		expect(completionEvent).toBeDefined("Should have completion event");
		expect(completionEvent?.attributes?.["llm.input_tokens"]).toBe(10);
		expect(completionEvent?.attributes?.["llm.output_tokens"]).toBe(5);
	});

	it("should set OK status on successful completion", async () => {
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
				title: "Test Thread OK",
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
				content: "Test OK status",
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
		backend.setTextResponse("Success");

		const router = new ModelRouter(new Map([["test-model", backend]]), "test-model");
		const ctx = makeCtx();
		const sandbox = createMockSandbox();

		const loop = new AgentLoop(ctx, sandbox as any, router, {
			threadId,
			userId,
			modelId: "test-model",
		});

		await loop.run();

		const spans = exporter.getFinishedSpans();
		const driverSpan = spans.find((s) => s.name === "llm-driver.chat");

		expect(driverSpan).toBeDefined();
		expect(driverSpan?.status?.code).toBe(1); // OK status code is 1
	});
});
