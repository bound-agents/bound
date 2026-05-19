import type { Database } from "bun:sqlite";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyMetricsSchema, applySchema, createDatabase, insertRow } from "@bound/core";
import type { AppContext, EventBusImpl } from "@bound/core";
import type { LLMBackend, RegisteredTool, StreamChunk } from "@bound/llm";
import { ModelRouter } from "@bound/llm";
import { cleanupTmpDir } from "@bound/shared/test-utils";
import { trace } from "@opentelemetry/api";
import {
	BasicTracerProvider,
	InMemorySpanExporter,
	SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import { AgentLoop } from "../agent-loop";

// Mock LLM Backend that returns tool calls
class MockLLMBackend implements LLMBackend {
	private responses: Array<() => AsyncGenerator<StreamChunk>> = [];
	private callCount = 0;

	/** Push a response generator */
	pushResponse(gen: () => AsyncGenerator<StreamChunk>) {
		this.responses.push(gen);
	}

	/** Set a tool_use response followed by a text response (simulating tool execution flow) */
	setToolThenTextResponse(
		toolId: string,
		toolName: string,
		toolInput: Record<string, unknown>,
		finalText: string,
	) {
		this.responses = [];
		// First response: tool use call
		this.pushResponse(async function* () {
			yield {
				type: "tool_use_start" as const,
				id: toolId,
				name: toolName,
			};
			yield {
				type: "tool_use_args" as const,
				id: toolId,
				partial_json: JSON.stringify(toolInput),
			};
			yield { type: "tool_use_end" as const, id: toolId };
			yield {
				type: "done" as const,
				usage: {
					input_tokens: 10,
					output_tokens: 15,
					cache_write_tokens: null,
					cache_read_tokens: null,
					estimated: false,
				},
			};
		});
		// Second response: final text after tool execution
		this.pushResponse(async function* () {
			yield { type: "text" as const, content: finalText };
			yield {
				type: "done" as const,
				usage: {
					input_tokens: 20,
					output_tokens: 10,
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

describe("Tool Dispatch Spans (OTEL)", () => {
	let tmpDir: string;
	let dbPath: string;
	let db: Database;
	let threadId: string;
	let userId: string;
	let exporter: InMemorySpanExporter;
	let provider: BasicTracerProvider;

	beforeAll(async () => {
		tmpDir = mkdtempSync(join(tmpdir(), "tool-dispatch-spans-test-"));
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

	it("should create tool.execute span for builtin tools", async () => {
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
				content: "Query some data",
				model_id: null,
				tool_name: null,
				created_at: new Date().toISOString(),
				modified_at: new Date().toISOString(),
				host_origin: "local",
				deleted: 0,
			},
			userId,
		);

		// Create a mock tool registry with a builtin tool
		const toolRegistry = new Map<string, RegisteredTool>();
		toolRegistry.set("query", {
			name: "query",
			kind: "builtin",
			schema: {
				type: "object",
				properties: {
					query: { type: "string" },
				},
			},
			execute: async (_input: Record<string, unknown>) => {
				return "Query result";
			},
		});

		const backend = new MockLLMBackend();
		backend.setToolThenTextResponse(
			"query-1",
			"query",
			{ query: "SELECT * FROM users" },
			"Query executed",
		);

		const router = new ModelRouter(new Map([["test-model", backend]]), "test-model");
		const ctx = makeCtx();
		const sandbox = createMockSandbox();

		const loop = new AgentLoop(ctx, sandbox as any, router, {
			threadId,
			userId,
			modelId: "test-model",
			toolRegistry,
		});

		await loop.run();

		// Verify tool.execute span was created
		const spans = exporter.getFinishedSpans();
		const toolSpan = spans.find(
			(s) => s.name === "tool.execute" && s.attributes?.["tool.name"] === "query",
		);

		expect(toolSpan).toBeDefined("Should have tool.execute span for query");
	});

	it("should record tool.name and tool.kind attributes", async () => {
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
				title: "Test Thread Attributes",
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
				content: "Query with attributes",
				model_id: null,
				tool_name: null,
				created_at: new Date().toISOString(),
				modified_at: new Date().toISOString(),
				host_origin: "local",
				deleted: 0,
			},
			userId,
		);

		const toolRegistry = new Map<string, RegisteredTool>();
		toolRegistry.set("query", {
			name: "query",
			kind: "builtin",
			schema: {
				type: "object",
				properties: {
					query: { type: "string" },
				},
			},
			execute: async (_input: Record<string, unknown>) => {
				return "Success";
			},
		});

		const backend = new MockLLMBackend();
		backend.setToolThenTextResponse("query-2", "query", { query: "SELECT 1" }, "Success");

		const router = new ModelRouter(new Map([["test-model", backend]]), "test-model");
		const ctx = makeCtx();
		const sandbox = createMockSandbox();

		const loop = new AgentLoop(ctx, sandbox as any, router, {
			threadId,
			userId,
			modelId: "test-model",
			toolRegistry,
		});

		await loop.run();

		const spans = exporter.getFinishedSpans();
		const toolSpan = spans.find(
			(s) => s.name === "tool.execute" && s.attributes?.["tool.name"] === "query",
		);

		expect(toolSpan).toBeDefined();
		expect(toolSpan?.attributes?.["tool.name"]).toBe("query");
		expect(toolSpan?.attributes?.["tool.kind"]).toBe("builtin");
		expect(toolSpan?.attributes?.["tool.call_id"]).toBe("query-2");
	});

	it("should set OK status on successful tool execution", async () => {
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
				content: "Query for OK status",
				model_id: null,
				tool_name: null,
				created_at: new Date().toISOString(),
				modified_at: new Date().toISOString(),
				host_origin: "local",
				deleted: 0,
			},
			userId,
		);

		const toolRegistry = new Map<string, RegisteredTool>();
		toolRegistry.set("query", {
			name: "query",
			kind: "builtin",
			schema: {
				type: "object",
				properties: {},
			},
			execute: async (_input: Record<string, unknown>) => {
				return "Success result";
			},
		});

		const backend = new MockLLMBackend();
		backend.setToolThenTextResponse("query-3", "query", {}, "OK result");

		const router = new ModelRouter(new Map([["test-model", backend]]), "test-model");
		const ctx = makeCtx();
		const sandbox = createMockSandbox();

		const loop = new AgentLoop(ctx, sandbox as any, router, {
			threadId,
			userId,
			modelId: "test-model",
			toolRegistry,
		});

		await loop.run();

		const spans = exporter.getFinishedSpans();
		const toolSpan = spans.find((s) => s.name === "tool.execute");

		expect(toolSpan).toBeDefined();
		expect(toolSpan?.status?.code).toBe(1); // OK status code is 1
	});

	it("should set ERROR status when tool returns error (exitCode: 1)", async () => {
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
				title: "Test Thread Error",
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
				content: "Query that will fail",
				model_id: null,
				tool_name: null,
				created_at: new Date().toISOString(),
				modified_at: new Date().toISOString(),
				host_origin: "local",
				deleted: 0,
			},
			userId,
		);

		const toolRegistry = new Map<string, RegisteredTool>();
		toolRegistry.set("query", {
			name: "query",
			kind: "builtin",
			schema: {
				type: "object",
				properties: {},
			},
			execute: async (_input: Record<string, unknown>) => {
				return "Error: Database connection failed";
			},
		});

		const backend = new MockLLMBackend();
		backend.setToolThenTextResponse("query-err", "query", {}, "Error handled");

		const router = new ModelRouter(new Map([["test-model", backend]]), "test-model");
		const ctx = makeCtx();
		const sandbox = createMockSandbox();

		const loop = new AgentLoop(ctx, sandbox as any, router, {
			threadId,
			userId,
			modelId: "test-model",
			toolRegistry,
		});

		await loop.run();

		const spans = exporter.getFinishedSpans();
		const toolSpan = spans.find((s) => s.name === "tool.execute");

		expect(toolSpan).toBeDefined();
		expect(toolSpan?.status?.code).toBe(2); // ERROR code is 2
		expect(toolSpan?.status?.message).toContain("Error:");
	});

	it("should set ERROR status on tool execution exception", async () => {
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
				title: "Test Thread Exception",
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
				content: "Query that throws exception",
				model_id: null,
				tool_name: null,
				created_at: new Date().toISOString(),
				modified_at: new Date().toISOString(),
				host_origin: "local",
				deleted: 0,
			},
			userId,
		);

		const toolRegistry = new Map<string, RegisteredTool>();
		toolRegistry.set("query", {
			name: "query",
			kind: "builtin",
			schema: {
				type: "object",
				properties: {},
			},
			execute: async (_input: Record<string, unknown>) => {
				throw new Error("Unexpected exception in tool");
			},
		});

		const backend = new MockLLMBackend();
		backend.setToolThenTextResponse("query-exc", "query", {}, "Exception handled");

		const router = new ModelRouter(new Map([["test-model", backend]]), "test-model");
		const ctx = makeCtx();
		const sandbox = createMockSandbox();

		const loop = new AgentLoop(ctx, sandbox as any, router, {
			threadId,
			userId,
			modelId: "test-model",
			toolRegistry,
		});

		await loop.run();

		const spans = exporter.getFinishedSpans();
		const toolSpan = spans.find((s) => s.name === "tool.execute");

		expect(toolSpan).toBeDefined();
		expect(toolSpan?.status?.code).toBe(2); // ERROR
		expect(toolSpan?.status?.message).toContain("Unexpected exception");
	});

	it("should parent tool.execute span under agent-loop.tool-execute", async () => {
		insertRow(
			db,
			"threads",
			{
				id: threadId,
				user_id: userId,
				interface: "web",
				host_origin: "local",
				color: 0,
				title: "Test Thread Parenting",
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
				content: "Query for parenting test",
				model_id: null,
				tool_name: null,
				created_at: new Date().toISOString(),
				modified_at: new Date().toISOString(),
				host_origin: "local",
				deleted: 0,
			},
			userId,
		);

		const toolRegistry = new Map<string, RegisteredTool>();
		toolRegistry.set("query", {
			name: "query",
			kind: "builtin",
			schema: { type: "object", properties: { query: { type: "string" } } },
			execute: async () => "Result",
		});

		const backend = new MockLLMBackend();
		backend.setToolThenTextResponse("query-parent", "query", { query: "SELECT 1" }, "Done");

		const router = new ModelRouter(new Map([["test-model", backend]]), "test-model");
		const ctx = makeCtx();
		const sandbox = createMockSandbox();

		const loop = new AgentLoop(ctx, sandbox as any, router, {
			threadId,
			userId,
			modelId: "test-model",
			toolRegistry,
		});

		await loop.run();

		const spans = exporter.getFinishedSpans();
		const toolExecuteSpan = spans.find((s) => s.name === "agent-loop.tool-execute");
		const toolSpan = spans.find((s) => s.name === "tool.execute");

		expect(toolExecuteSpan).toBeDefined();
		expect(toolSpan).toBeDefined();
		// tool.execute should be a child of agent-loop.tool-execute
		expect(toolSpan?.parentSpanId).toBe(toolExecuteSpan?.spanContext().spanId);
	});

	it("should record tool.input_size and tool.output_size attributes", async () => {
		insertRow(
			db,
			"threads",
			{
				id: threadId,
				user_id: userId,
				interface: "web",
				host_origin: "local",
				color: 0,
				title: "Test Thread Size",
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
				content: "Query for size test",
				model_id: null,
				tool_name: null,
				created_at: new Date().toISOString(),
				modified_at: new Date().toISOString(),
				host_origin: "local",
				deleted: 0,
			},
			userId,
		);

		const toolRegistry = new Map<string, RegisteredTool>();
		toolRegistry.set("query", {
			name: "query",
			kind: "builtin",
			schema: { type: "object", properties: { query: { type: "string" } } },
			execute: async () => "Query result data here",
		});

		const backend = new MockLLMBackend();
		backend.setToolThenTextResponse(
			"query-size",
			"query",
			{ query: "SELECT * FROM users" },
			"Done",
		);

		const router = new ModelRouter(new Map([["test-model", backend]]), "test-model");
		const ctx = makeCtx();
		const sandbox = createMockSandbox();

		const loop = new AgentLoop(ctx, sandbox as any, router, {
			threadId,
			userId,
			modelId: "test-model",
			toolRegistry,
		});

		await loop.run();

		const spans = exporter.getFinishedSpans();
		const toolSpan = spans.find((s) => s.name === "tool.execute");

		expect(toolSpan).toBeDefined();
		expect(toolSpan?.attributes?.["tool.input_size"]).toBeDefined();
		expect(typeof toolSpan?.attributes?.["tool.input_size"]).toBe("number");
		expect(toolSpan?.attributes?.["tool.input_size"] as number).toBeGreaterThan(0);
		expect(toolSpan?.attributes?.["tool.output_size"]).toBeDefined();
		expect(typeof toolSpan?.attributes?.["tool.output_size"]).toBe("number");
		expect(toolSpan?.attributes?.["tool.output_size"] as number).toBeGreaterThan(0);
	});

	it("should create agent-loop.tool-persist span after tool execution", async () => {
		insertRow(
			db,
			"threads",
			{
				id: threadId,
				user_id: userId,
				interface: "web",
				host_origin: "local",
				color: 0,
				title: "Test Thread Persist",
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
				content: "Query for persist test",
				model_id: null,
				tool_name: null,
				created_at: new Date().toISOString(),
				modified_at: new Date().toISOString(),
				host_origin: "local",
				deleted: 0,
			},
			userId,
		);

		const toolRegistry = new Map<string, RegisteredTool>();
		toolRegistry.set("query", {
			name: "query",
			kind: "builtin",
			schema: { type: "object", properties: { query: { type: "string" } } },
			execute: async () => "Persist result",
		});

		const backend = new MockLLMBackend();
		backend.setToolThenTextResponse("query-persist", "query", { query: "SELECT 1" }, "Done");

		const router = new ModelRouter(new Map([["test-model", backend]]), "test-model");
		const ctx = makeCtx();
		const sandbox = createMockSandbox();

		const loop = new AgentLoop(ctx, sandbox as any, router, {
			threadId,
			userId,
			modelId: "test-model",
			toolRegistry,
		});

		await loop.run();

		const spans = exporter.getFinishedSpans();
		const toolPersistSpan = spans.find((s) => s.name === "agent-loop.tool-persist");
		const turnSpan = spans.find((s) => s.name === "agent-loop.turn");

		expect(toolPersistSpan).toBeDefined();
		expect(turnSpan).toBeDefined();
		// tool-persist should be a child of the turn
		expect(toolPersistSpan?.parentSpanId).toBe(turnSpan?.spanContext().spanId);
	});
});
