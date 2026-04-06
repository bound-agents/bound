import type { Database } from "bun:sqlite";
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applySchema, createDatabase, insertRow } from "@bound/core";
import type { LLMBackend, StreamChunk } from "@bound/llm";
import { ModelRouter } from "@bound/llm";
import { TypedEventEmitter } from "@bound/shared";
import { cleanupTmpDir } from "@bound/shared/test-utils";
import { AgentLoop } from "../agent-loop";

function createMockRouter(backend: LLMBackend): ModelRouter {
	const backends = new Map<string, LLMBackend>();
	backends.set("default", backend);
	return new ModelRouter(backends, "default");
}

describe("Agent Loop End-to-End Integration", () => {
	let tmpDir: string;
	let dbPath: string;
	let db: Database;

	beforeAll(() => {
		tmpDir = mkdtempSync(join(tmpdir(), "agent-integration-test-"));
		dbPath = join(tmpDir, "test.db");

		db = createDatabase(dbPath);
		applySchema(db);
	});

	afterAll(async () => {
		db.close();
		await cleanupTmpDir(tmpDir);
	});

	it("processes a message end-to-end with tool execution", async () => {
		// Setup: Create user, thread, and initial message
		const userId = randomUUID();
		const threadId = randomUUID();
		const userMessageId = randomUUID();
		const siteId = randomUUID();
		const hostName = "test-host";
		const now = new Date().toISOString();

		// Insert user
		insertRow(
			db,
			"users",
			{
				id: userId,
				display_name: "Test User",
				platform_ids: null,
				first_seen_at: now,
				modified_at: now,
				deleted: 0,
			},
			siteId,
		);

		// Insert thread
		insertRow(
			db,
			"threads",
			{
				id: threadId,
				user_id: userId,
				interface: "web",
				host_origin: "test",
				color: 0,
				title: "Test Thread",
				summary: null,
				summary_through: null,
				summary_model_id: null,
				extracted_through: null,
				created_at: now,
				last_message_at: now,
				modified_at: now,
				deleted: 0,
			},
			siteId,
		);

		// Insert user message
		insertRow(
			db,
			"messages",
			{
				id: userMessageId,
				thread_id: threadId,
				role: "user",
				content: "Remember: test value is important",
				model_id: null,
				tool_name: null,
				created_at: now,
				modified_at: now,
				host_origin: hostName,
			},
			siteId,
		);

		// Create mock LLMBackend that returns a tool_use for memorize
		let callCount = 0;
		const mockLLMBackend: LLMBackend = {
			capabilities: () => ({
				streaming: true,
				tool_use: true,
				system_prompt: true,
				prompt_caching: false,
				vision: false,
				max_context: 200000,
			}),
			async *chat() {
				callCount++;

				if (callCount === 1) {
					// First call: return a tool_use
					yield {
						type: "tool_use_start",
						toolName: "memorize",
						toolId: "tool-1",
					} as StreamChunk;
					yield {
						type: "text",
						content: '{"--key":"test-key","--value":"test-value"}',
					} as StreamChunk;
					yield {
						type: "tool_use_end",
						toolId: "tool-1",
					} as StreamChunk;
				} else if (callCount === 2) {
					// Second call: return text response
					yield {
						type: "text",
						content: "I've remembered the important value.",
					} as StreamChunk;
				}
			},
		};

		// Create mock AppContext
		const eventBus = new TypedEventEmitter();
		const mockAppContext = {
			db,
			config: {
				allowlist: { default_web_user: "test", users: { test: { display_name: "Test" } } },
				modelBackends: { backends: [], default: "" },
			},
			optionalConfig: {
				mcp_servers: [],
			},
			eventBus,
			logger: {
				debug: () => {},
				info: () => {},
				warn: () => {},
				error: () => {},
			},
			siteId,
			hostName,
		};

		// Create mock Sandbox
		const mockSandbox = {
			exec: async (_cmd: string) => ({
				stdout: "Memory saved",
				stderr: "",
				exitCode: 0,
			}),
		};

		// Run agent loop
		const agentLoop = new AgentLoop(
			// biome-ignore lint/suspicious/noExplicitAny: test mocks require any casts
			mockAppContext as any,
			// biome-ignore lint/suspicious/noExplicitAny: test mocks require any casts
			mockSandbox as any,
			createMockRouter(mockLLMBackend),
			{
				threadId,
				userId,
				modelId: "default",
			},
		);

		const result = await agentLoop.run();

		// Verify results
		expect(result.messagesCreated).toBeGreaterThan(0);
		expect(result.toolCallsMade).toBeGreaterThan(0);
		expect(result.error).toBeUndefined();

		// Verify messages were persisted
		const messages = db
			.query("SELECT id, role, content FROM messages WHERE thread_id = ? ORDER BY created_at")
			.all(threadId) as Array<{
			id: string;
			role: string;
			content: string;
		}>;

		expect(messages.length).toBeGreaterThan(1);

		// Check for assistant response
		const assistantMsg = messages.find((m) => m.role === "assistant");
		expect(assistantMsg).toBeDefined();
		// The assistant message contains the tool response in this Phase 4 test
		expect(assistantMsg?.content).toBeDefined();
	});

	it("persists messages with correct roles", async () => {
		const userId = randomUUID();
		const threadId = randomUUID();
		const siteId = randomUUID();
		const hostName = "test-host";
		const now = new Date().toISOString();

		// Setup
		insertRow(
			db,
			"users",
			{
				id: userId,
				display_name: "Test User 2",
				platform_ids: null,
				first_seen_at: now,
				modified_at: now,
				deleted: 0,
			},
			siteId,
		);

		insertRow(
			db,
			"threads",
			{
				id: threadId,
				user_id: userId,
				interface: "web",
				host_origin: "test",
				color: 0,
				title: "Test Thread 2",
				summary: null,
				summary_through: null,
				summary_model_id: null,
				extracted_through: null,
				created_at: now,
				last_message_at: now,
				modified_at: now,
				deleted: 0,
			},
			siteId,
		);

		// User message
		const userMessageId = randomUUID();
		insertRow(
			db,
			"messages",
			{
				id: userMessageId,
				thread_id: threadId,
				role: "user",
				content: "Hello!",
				model_id: null,
				tool_name: null,
				created_at: now,
				modified_at: now,
				host_origin: hostName,
			},
			siteId,
		);

		// Mock LLM that returns simple text
		const mockLLMBackend: LLMBackend = {
			capabilities: () => ({
				streaming: true,
				tool_use: true,
				system_prompt: true,
				prompt_caching: false,
				vision: false,
				max_context: 200000,
			}),
			async *chat() {
				yield {
					type: "text",
					content: "Hello! How can I help?",
				} as StreamChunk;
			},
		};

		const eventBus = new TypedEventEmitter();
		const mockAppContext = {
			db,
			config: {
				allowlist: { default_web_user: "test", users: { test: { display_name: "Test" } } },
				modelBackends: { backends: [], default: "" },
			},
			optionalConfig: {
				mcp_servers: [],
			},
			eventBus,
			logger: {
				debug: () => {},
				info: () => {},
				warn: () => {},
				error: () => {},
			},
			siteId,
			hostName,
		};

		const mockSandbox = {
			exec: async () => ({ stdout: "", stderr: "", exitCode: 0 }),
		};

		const agentLoop = new AgentLoop(
			// biome-ignore lint/suspicious/noExplicitAny: test mocks require any casts
			mockAppContext as any,
			// biome-ignore lint/suspicious/noExplicitAny: test mocks require any casts
			mockSandbox as any,
			createMockRouter(mockLLMBackend),
			{
				threadId,
				userId,
				modelId: "default",
			},
		);

		const result = await agentLoop.run();

		expect(result.error).toBeUndefined();

		// Verify message roles
		const allMessages = db
			.query("SELECT role FROM messages WHERE thread_id = ? ORDER BY created_at")
			.all(threadId) as Array<{ role: string }>;

		const roles = allMessages.map((m) => m.role);
		expect(roles).toContain("user");
		expect(roles).toContain("assistant");
	});

	it("handles LLM errors gracefully", async () => {
		const userId = randomUUID();
		const threadId = randomUUID();
		const siteId = randomUUID();
		const hostName = "test-host";
		const now = new Date().toISOString();

		// Setup
		insertRow(
			db,
			"users",
			{
				id: userId,
				display_name: "Test User 3",
				platform_ids: null,
				first_seen_at: now,
				modified_at: now,
				deleted: 0,
			},
			siteId,
		);

		insertRow(
			db,
			"threads",
			{
				id: threadId,
				user_id: userId,
				interface: "web",
				host_origin: "test",
				color: 0,
				title: "Test Thread 3",
				summary: null,
				summary_through: null,
				summary_model_id: null,
				extracted_through: null,
				created_at: now,
				last_message_at: now,
				modified_at: now,
				deleted: 0,
			},
			siteId,
		);

		const userMessageId = randomUUID();
		insertRow(
			db,
			"messages",
			{
				id: userMessageId,
				thread_id: threadId,
				role: "user",
				content: "Test",
				model_id: null,
				tool_name: null,
				created_at: now,
				modified_at: now,
				host_origin: hostName,
			},
			siteId,
		);

		// LLM that throws error
		const mockLLMBackend: LLMBackend = {
			capabilities: () => ({
				streaming: true,
				tool_use: true,
				system_prompt: true,
				prompt_caching: false,
				vision: false,
				max_context: 200000,
			}),
			// biome-ignore lint/correctness/useYield: generator throws before yield
			async *chat() {
				throw new Error("LLM service unavailable");
			},
		};

		const eventBus = new TypedEventEmitter();
		const mockAppContext = {
			db,
			config: {
				allowlist: { default_web_user: "test", users: { test: { display_name: "Test" } } },
				modelBackends: { backends: [], default: "" },
			},
			optionalConfig: {
				mcp_servers: [],
			},
			eventBus,
			logger: {
				debug: () => {},
				info: () => {},
				warn: () => {},
				error: () => {},
			},
			siteId,
			hostName,
		};

		const mockSandbox = {
			exec: async () => ({ stdout: "", stderr: "", exitCode: 0 }),
		};

		const agentLoop = new AgentLoop(
			// biome-ignore lint/suspicious/noExplicitAny: test mocks require any casts
			mockAppContext as any,
			// biome-ignore lint/suspicious/noExplicitAny: test mocks require any casts
			mockSandbox as any,
			createMockRouter(mockLLMBackend),
			{
				threadId,
				userId,
				modelId: "default",
			},
		);

		const result = await agentLoop.run();

		// Should have error
		expect(result.error).toBeDefined();
		expect(result.error).toContain("unavailable");

		// Alert message should be persisted
		const alertMsg = db
			.query("SELECT role FROM messages WHERE thread_id = ? AND role = 'alert'")
			.get(threadId) as { role: string } | undefined;

		expect(alertMsg?.role).toBe("alert");
	});
});
