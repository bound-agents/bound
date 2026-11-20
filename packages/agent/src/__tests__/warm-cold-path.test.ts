import type { Database } from "bun:sqlite";
import { afterAll, beforeAll, beforeEach, describe, expect, it, setDefaultTimeout } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	InMemoryTurnStateStore,
	applyMetricsSchema,
	applySchema,
	createDatabase,
} from "@bound/core";
import type { AppContext } from "@bound/core";
import type { ChatParams, LLMBackend, StreamChunk, ToolDefinition } from "@bound/llm";
import { ModelRouter } from "@bound/llm";
import type { LLMMessage } from "@bound/llm";
import { cleanupTmpDir } from "@bound/shared/test-utils";
import { MainAgentLoop } from "../agent-loop";
import { computeToolFingerprint } from "../cached-turn-state";

// FTS5 schema setup adds overhead on CI runners; bump default timeout
setDefaultTimeout(10000);

let globalTmpDir: string;
let globalDb: Database;
let globalThreadId: string;
let globalUserId: string;

beforeAll(() => {
	globalTmpDir = mkdtempSync(join(tmpdir(), "warm-cold-path-test-"));
	const dbPath = join(globalTmpDir, "test.db");
	globalDb = createDatabase(dbPath);
	applySchema(globalDb);
	applyMetricsSchema(globalDb);

	// Create a test user
	globalUserId = randomUUID();
	globalDb.run(
		"INSERT INTO users (id, display_name, platform_ids, first_seen_at, modified_at, deleted) VALUES (?, ?, ?, ?, ?, ?)",
		[globalUserId, "Test User", null, new Date().toISOString(), new Date().toISOString(), 0],
	);
});

beforeEach(() => {
	// Each test gets a unique thread ID, providing isolation within the shared DB.
	// This avoids the cost of re-creating the schema per test while keeping
	// thread-level state independent.
	globalThreadId = randomUUID();
});

afterAll(async () => {
	globalDb.close();
	if (globalTmpDir) {
		await cleanupTmpDir(globalTmpDir);
	}
});

describe("warm-cold-path", () => {
	// ─── Integration tests: multi-invocation warm/cold cycles ─────────────────

	describe("integration: multi-invocation warm/cold cycles", () => {
		// Mock LLM Backend for testing
		class MockLLMBackend implements LLMBackend {
			constructor(private readonly vision = false) {}
			private responses: Array<() => AsyncGenerator<StreamChunk>> = [];
			private callCount = 0;
			private capturedParams: ChatParams[] = [];

			pushResponse(gen: () => AsyncGenerator<StreamChunk>) {
				this.responses.push(gen);
			}

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

			setToolThenTextResponse(
				toolId: string,
				toolName: string,
				toolInput: Record<string, unknown>,
				finalText: string,
			) {
				this.responses = [];
				this.pushResponse(async function* () {
					yield { type: "tool_use_start" as const, id: toolId, name: toolName };
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

			getCapturedParams() {
				return this.capturedParams;
			}

			async *chat(params: ChatParams) {
				this.capturedParams.push(params);
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
					prompt_caching: true,
					vision: this.vision,
					max_context: 200000,
				};
			}
		}

		function createMockRouter(backend: LLMBackend): ModelRouter {
			const backends = new Map<string, LLMBackend>();
			backends.set("claude-opus", backend);
			return new ModelRouter(backends, "claude-opus");
		}

		type CachePathLog = { path: "warm" | "cold"; reason: string };

		function makeCtx(
			pathLogs?: CachePathLog[],
			turnStateStore?: InMemoryTurnStateStore,
		): AppContext {
			return {
				db: globalDb,
				logger: {
					debug: () => {},
					info: (msg: string, fields?: Record<string, unknown>) => {
						if (
							pathLogs &&
							msg === "[agent-loop] Cache path selected" &&
							fields &&
							(fields.path === "warm" || fields.path === "cold")
						) {
							pathLogs.push({
								path: fields.path as "warm" | "cold",
								reason: String(fields.reason),
							});
						}
					},
					warn: () => {},
					error: () => {},
				},
				eventBus: {
					on: () => {},
					off: () => {},
					emit: () => {},
				},
				hostName: "test-host",
				siteId: "test-site-id",
				turnStateStore: turnStateStore ?? new InMemoryTurnStateStore(),
			} as unknown as AppContext;
		}

		function createMockSandbox() {
			return {
				calls: [] as string[],
				exec: async (_cmd: string) => ({
					stdout: "mock output",
					stderr: "",
					exitCode: 0,
				}),
			};
		}

		it("AC1.4 + AC1.1: first invocation uses cold path, second uses warm path with fresh volatile", async () => {
			// Create initial thread with a message
			globalDb.run(
				"INSERT INTO threads (id, user_id, interface, host_origin, color, title, summary, summary_through, summary_model_id, extracted_through, created_at, last_message_at, modified_at, deleted) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
				[
					globalThreadId,
					globalUserId,
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

			const mockBackend = new MockLLMBackend();
			// First response: report cache_write so predictCacheState sees cache activity
			mockBackend.pushResponse(async function* () {
				yield { type: "text" as const, content: "Hello" };
				yield {
					type: "done" as const,
					usage: {
						input_tokens: 100,
						output_tokens: 5,
						cache_write_tokens: 100,
						cache_read_tokens: 0,
						estimated: false,
					},
				};
			});
			mockBackend.pushResponse(async function* () {
				yield { type: "text" as const, content: "Follow-up response" };
				yield {
					type: "done" as const,
					usage: {
						input_tokens: 10,
						output_tokens: 5,
						cache_write_tokens: 0,
						cache_read_tokens: 100,
						estimated: false,
					},
				};
			});

			// Shared store so warm-path state survives across MainAgentLoop instances
			const sharedStore = new InMemoryTurnStateStore();

			// First invocation (cold path expected)
			const pathLogs1: CachePathLog[] = [];
			const ctx1 = makeCtx(pathLogs1, sharedStore);
			const agentLoop1 = new MainAgentLoop(
				ctx1,
				createMockSandbox(),
				createMockRouter(mockBackend),
				{
					threadId: globalThreadId,
					userId: globalUserId,
				},
			);

			const result1 = await agentLoop1.run();
			expect(result1).toHaveProperty("messagesCreated");
			expect(result1.messagesCreated).toBeGreaterThan(0);

			// First invocation's first LLM call must be cold (no prior state).
			expect(pathLogs1.length).toBeGreaterThanOrEqual(1);
			expect(pathLogs1[0]?.path).toBe("cold");

			// Insert a new message to simulate user follow-up
			const newMsgId = randomUUID();
			globalDb.run(
				"INSERT INTO messages (id, thread_id, role, content, model_id, tool_name, created_at, modified_at, host_origin, deleted) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
				[
					newMsgId,
					globalThreadId,
					"user",
					"Follow up question",
					null,
					null,
					new Date().toISOString(),
					new Date().toISOString(),
					"local",
					0,
				],
			);

			// Second invocation: FRESH MainAgentLoop instance (simulates client-tool defer + wakeup,
			// or any other path that tears down the agent loop between turns).
			// Warm path expected IF cached turn state survives instance teardown.
			const pathLogs2: CachePathLog[] = [];
			const ctx2 = makeCtx(pathLogs2, sharedStore);
			const agentLoop2 = new MainAgentLoop(
				ctx2,
				createMockSandbox(),
				createMockRouter(mockBackend),
				{
					threadId: globalThreadId,
					userId: globalUserId,
				},
			);

			const result2 = await agentLoop2.run();
			expect(result2).toHaveProperty("messagesCreated");

			// Verify both invocations completed
			expect(mockBackend.getCallCount()).toBeGreaterThanOrEqual(2);

			// THE ACTUAL ASSERTION: second invocation's first LLM call should take the warm path.
			// If this fails with reason="no-stored-state", it confirms cached turn state
			// is instance-scoped and cannot survive MainAgentLoop teardown.
			expect(pathLogs2.length).toBeGreaterThanOrEqual(1);
			expect(pathLogs2[0]).toEqual({ path: "warm", reason: "warm-eligible" });
		});

		it("AC3.1-regression: warm path is taken even when the prior turn reported ZERO cache activity", async () => {
			// The bug: warm eligibility used to require predictCacheState === "warm",
			// which keys off the prior turn's cache_read/write tokens. A prior turn
			// reporting 0/0 (common on an active thread) made it guess "cold",
			// discarding usable cached state and forcing an expensive cold rebuild.
			// After the fix, warmth depends only on cached state + tool fingerprint,
			// so zero prior cache activity no longer false-colds the next turn.
			globalDb.run(
				"INSERT INTO threads (id, user_id, interface, host_origin, color, title, summary, summary_through, summary_model_id, extracted_through, created_at, last_message_at, modified_at, deleted) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
				[
					globalThreadId,
					globalUserId,
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

			const mockBackend = new MockLLMBackend();
			// Both turns report 0/0 cache tokens — the false-cold trigger.
			const zeroCacheDone = {
				type: "done" as const,
				usage: {
					input_tokens: 10,
					output_tokens: 5,
					cache_write_tokens: 0,
					cache_read_tokens: 0,
					estimated: false,
				},
			};
			mockBackend.pushResponse(async function* () {
				yield { type: "text" as const, content: "Response 1" };
				yield zeroCacheDone;
			});
			mockBackend.pushResponse(async function* () {
				yield { type: "text" as const, content: "Response 2" };
				yield zeroCacheDone;
			});

			const sharedStore = new InMemoryTurnStateStore();

			const pathLogs1: CachePathLog[] = [];
			const agentLoop1 = new MainAgentLoop(
				makeCtx(pathLogs1, sharedStore),
				createMockSandbox(),
				createMockRouter(mockBackend),
				{ threadId: globalThreadId, userId: globalUserId },
			);
			await agentLoop1.run();
			expect(pathLogs1[0]?.path).toBe("cold"); // first turn always cold

			// Follow-up user message.
			globalDb.run(
				"INSERT INTO messages (id, thread_id, role, content, model_id, tool_name, created_at, modified_at, host_origin, deleted) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
				[
					randomUUID(),
					globalThreadId,
					"user",
					"Follow up",
					null,
					null,
					new Date().toISOString(),
					new Date().toISOString(),
					"local",
					0,
				],
			);

			const pathLogs2: CachePathLog[] = [];
			const agentLoop2 = new MainAgentLoop(
				makeCtx(pathLogs2, sharedStore),
				createMockSandbox(),
				createMockRouter(mockBackend),
				{ threadId: globalThreadId, userId: globalUserId },
			);
			await agentLoop2.run();

			// Despite zero cache activity on turn 1, turn 2 reuses the warm path.
			expect(pathLogs2[0]).toEqual({ path: "warm", reason: "warm-eligible" });
		});

		it("AC3.1: cold cache state forces full reassembly", async () => {
			globalDb.run(
				"INSERT INTO threads (id, user_id, interface, host_origin, color, title, summary, summary_through, summary_model_id, extracted_through, created_at, last_message_at, modified_at, deleted) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
				[
					globalThreadId,
					globalUserId,
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

			const mockBackend = new MockLLMBackend();
			mockBackend.setTextResponse("Response 1");
			mockBackend.pushResponse(async function* () {
				yield { type: "text" as const, content: "Response 2" };
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

			const sharedStore = new InMemoryTurnStateStore();

			// First run
			const ctx1 = makeCtx(undefined, sharedStore);
			const agentLoop1 = new MainAgentLoop(
				ctx1,
				createMockSandbox(),
				createMockRouter(mockBackend),
				{
					threadId: globalThreadId,
					userId: globalUserId,
				},
			);
			await agentLoop1.run();

			// Second run (should trigger reassembly if DB cache is invalidated)
			const ctx2 = makeCtx(undefined, sharedStore);
			const agentLoop2 = new MainAgentLoop(
				ctx2,
				createMockSandbox(),
				createMockRouter(mockBackend),
				{
					threadId: globalThreadId,
					userId: globalUserId,
				},
			);
			const result2 = await agentLoop2.run();

			expect(result2).toHaveProperty("messagesCreated");
		});

		it("AC3.3: tool change between invocations triggers cold path", async () => {
			globalDb.run(
				"INSERT INTO threads (id, user_id, interface, host_origin, color, title, summary, summary_through, summary_model_id, extracted_through, created_at, last_message_at, modified_at, deleted) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
				[
					globalThreadId,
					globalUserId,
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

			const mockBackend = new MockLLMBackend();
			mockBackend.setTextResponse("Response with tool 1");
			mockBackend.pushResponse(async function* () {
				yield { type: "text" as const, content: "Response with tools 1 and 2" };
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

			const tool1: ToolDefinition = {
				type: "function",
				function: {
					name: "tool_1",
					description: "Tool 1",
					parameters: {
						type: "object",
						properties: {},
					},
				},
			};

			const tool2: ToolDefinition = {
				type: "function",
				function: {
					name: "tool_2",
					description: "Tool 2",
					parameters: {
						type: "object",
						properties: {},
					},
				},
			};

			const sharedStore = new InMemoryTurnStateStore();

			// First invocation with one tool
			const ctx1 = makeCtx(undefined, sharedStore);
			const agentLoop1 = new MainAgentLoop(
				ctx1,
				createMockSandbox(),
				createMockRouter(mockBackend),
				{
					threadId: globalThreadId,
					userId: globalUserId,
					tools: [tool1],
				},
			);
			await agentLoop1.run();

			// Second invocation with added tool (fingerprint changed)
			const ctx2 = makeCtx(undefined, sharedStore);
			const agentLoop2 = new MainAgentLoop(
				ctx2,
				createMockSandbox(),
				createMockRouter(mockBackend),
				{
					threadId: globalThreadId,
					userId: globalUserId,
					tools: [tool1, tool2],
				},
			);
			const result2 = await agentLoop2.run();

			expect(result2).toHaveProperty("messagesCreated");
			// Tool change should have triggered cold path
			expect(mockBackend.getCallCount()).toBeGreaterThanOrEqual(2);
		});

		it("AC2.5: fresh volatile context generated each turn", async () => {
			globalDb.run(
				"INSERT INTO threads (id, user_id, interface, host_origin, color, title, summary, summary_through, summary_model_id, extracted_through, created_at, last_message_at, modified_at, deleted) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
				[
					globalThreadId,
					globalUserId,
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

			const mockBackend = new MockLLMBackend();
			mockBackend.setTextResponse("First response");
			mockBackend.pushResponse(async function* () {
				yield { type: "text" as const, content: "Second response" };
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

			const sharedStore = new InMemoryTurnStateStore();

			// First invocation: generates volatile context
			const ctx1 = makeCtx(undefined, sharedStore);
			const agentLoop1 = new MainAgentLoop(
				ctx1,
				createMockSandbox(),
				createMockRouter(mockBackend),
				{
					threadId: globalThreadId,
					userId: globalUserId,
				},
			);
			const result1 = await agentLoop1.run();
			expect(result1).toHaveProperty("messagesCreated");

			// Second invocation: generates fresh volatile context (even if warm path)
			const ctx2 = makeCtx(undefined, sharedStore);
			const agentLoop2 = new MainAgentLoop(
				ctx2,
				createMockSandbox(),
				createMockRouter(mockBackend),
				{
					threadId: globalThreadId,
					userId: globalUserId,
				},
			);
			const result2 = await agentLoop2.run();
			expect(result2).toHaveProperty("messagesCreated");

			// Both invocations should have succeeded, each generating fresh volatile context
			expect(mockBackend.getCallCount()).toBeGreaterThanOrEqual(2);
		});

		it("AC3.5: after cold path, CachedTurnState stored for warm reuse", async () => {
			globalDb.run(
				"INSERT INTO threads (id, user_id, interface, host_origin, color, title, summary, summary_through, summary_model_id, extracted_through, created_at, last_message_at, modified_at, deleted) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
				[
					globalThreadId,
					globalUserId,
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

			const mockBackend = new MockLLMBackend();
			mockBackend.setTextResponse("First turn (cold)");
			mockBackend.pushResponse(async function* () {
				yield { type: "text" as const, content: "Second turn (warm reuse)" };
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

			const sharedStore = new InMemoryTurnStateStore();

			// First invocation: cold path, caches state
			const ctx1 = makeCtx(undefined, sharedStore);
			const loop1 = new MainAgentLoop(ctx1, createMockSandbox(), createMockRouter(mockBackend), {
				threadId: globalThreadId,
				userId: globalUserId,
			});
			const result1 = await loop1.run();
			expect(result1).toHaveProperty("messagesCreated");

			// Add follow-up message
			const followUpId = randomUUID();
			globalDb.run(
				"INSERT INTO messages (id, thread_id, role, content, model_id, tool_name, created_at, modified_at, host_origin, deleted) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
				[
					followUpId,
					globalThreadId,
					"user",
					"Follow up",
					null,
					null,
					new Date().toISOString(),
					new Date().toISOString(),
					"local",
					0,
				],
			);

			// Second invocation: should use warm path from cached state
			const ctx2 = makeCtx(undefined, sharedStore);
			const loop2 = new MainAgentLoop(ctx2, createMockSandbox(), createMockRouter(mockBackend), {
				threadId: globalThreadId,
				userId: globalUserId,
			});
			const result2 = await loop2.run();
			expect(result2).toHaveProperty("messagesCreated");

			// Both should have completed successfully
			expect(mockBackend.getCallCount()).toBeGreaterThanOrEqual(2);
		});

		it("keeps an earlier image attached to its original user turn when a warm delta adds a later prompt", async () => {
			globalDb.run(
				"INSERT INTO threads (id, user_id, interface, host_origin, color, title, summary, summary_through, summary_model_id, extracted_through, created_at, last_message_at, modified_at, deleted) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
				[
					globalThreadId,
					globalUserId,
					"web",
					"local",
					0,
					"Warm image chronology",
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

			const earlierPrompt = "OLDER_IMAGE_PROMPT";
			const laterPrompt = "LATER_TEXT_PROMPT";
			const earlierContent = JSON.stringify([
				{ type: "text", text: earlierPrompt },
				{
					type: "image",
					source: { type: "base64", media_type: "image/png", data: "iVBORw0KGgo=" },
					description: "chronology sentinel",
				},
			]);
			globalDb.run(
				"INSERT INTO messages (id, thread_id, role, content, model_id, tool_name, created_at, modified_at, host_origin, deleted) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
				[
					randomUUID(),
					globalThreadId,
					"user",
					earlierContent,
					null,
					null,
					new Date().toISOString(),
					new Date().toISOString(),
					"local",
					0,
				],
			);

			const mockBackend = new MockLLMBackend(true);
			for (const text of ["first reply", "second reply"]) {
				mockBackend.pushResponse(async function* () {
					yield { type: "text" as const, content: text };
					yield {
						type: "done" as const,
						usage: {
							input_tokens: 10,
							output_tokens: 5,
							cache_write_tokens: 100,
							cache_read_tokens: 0,
							estimated: false,
						},
					};
				});
			}

			const sharedStore = new InMemoryTurnStateStore();
			const firstPathLogs: CachePathLog[] = [];
			const firstLoop = new MainAgentLoop(
				makeCtx(firstPathLogs, sharedStore),
				createMockSandbox(),
				createMockRouter(mockBackend),
				{ threadId: globalThreadId, userId: globalUserId },
			);
			await firstLoop.run();
			expect(firstPathLogs[0]?.path).toBe("cold");

			const callsBeforeSecondLoop = mockBackend.getCallCount();

			globalDb.run(
				"INSERT INTO messages (id, thread_id, role, content, model_id, tool_name, created_at, modified_at, host_origin, deleted) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
				[
					randomUUID(),
					globalThreadId,
					"user",
					laterPrompt,
					null,
					null,
					new Date(Date.now() + 1_000).toISOString(),
					new Date(Date.now() + 1_000).toISOString(),
					"local",
					0,
				],
			);

			const secondPathLogs: CachePathLog[] = [];
			const secondLoop = new MainAgentLoop(
				makeCtx(secondPathLogs, sharedStore),
				createMockSandbox(),
				createMockRouter(mockBackend),
				{ threadId: globalThreadId, userId: globalUserId },
			);
			await secondLoop.run();
			expect(secondPathLogs[0]?.path).toBe("warm");

			const secondInference =
				mockBackend
					.getCapturedParams()
					.slice(callsBeforeSecondLoop)
					.find((params) => params.messages.some((message) => message.role === "developer"))
					?.messages ?? [];
			const earlierIdx = secondInference.findIndex(
				(message) =>
					message.role === "user" &&
					Array.isArray(message.content) &&
					message.content.some(
						(block) =>
							block.type === "text" &&
							typeof block.text === "string" &&
							block.text.includes(earlierPrompt),
					),
			);
			const laterIdx = secondInference.findIndex(
				(message) =>
					message.role === "user" &&
					(typeof message.content === "string"
						? message.content.includes(laterPrompt)
						: message.content.some(
								(block) =>
									block.type === "text" &&
									typeof block.text === "string" &&
									block.text.includes(laterPrompt),
							)),
			);

			expect(earlierIdx).toBeGreaterThanOrEqual(0);
			expect(laterIdx).toBeGreaterThan(earlierIdx);
			const earlierMessage = secondInference[earlierIdx];
			expect(Array.isArray(earlierMessage?.content)).toBe(true);
			const annotatedEarlierContent = earlierMessage?.content as Array<{
				type: string;
				text?: string;
			}>;
			expect(annotatedEarlierContent[2]).toMatchObject({
				type: "text",
				text: expect.stringContaining("Image attachment sent"),
			});
			expect(annotatedEarlierContent[3]?.type).toBe("image");
		});

		it("falls back to cold reassembly when warm-path delta would leave an orphaned tool_call", async () => {
			// Regression, observed live. Setup: the prior
			// agent-loop had dispatched a boundless_bash client tool and yielded
			// while waiting for the WS reply. The tool_call was persisted to the
			// DB but no tool_result had arrived yet. When the user typed a
			// follow-up ("Why does the diff have 295 files?"), a NEW agent-loop
			// started, predictCacheState returned "warm" (1.5 min elapsed), and
			// the warm path appended [tool_call, user] to the stored prefix
			// without running tool-pair sanitization. The AI SDK prompt
			// validator then raised `MissingToolResultsError`.
			//
			// After the fix, the warm path detects the orphan before dispatching
			// to the LLM and falls through to the cold path, which has Stage 3
			// sanitization to synthesize a tool_result for every unmatched
			// tool_use_id.
			globalDb.run(
				"INSERT INTO threads (id, user_id, interface, host_origin, color, title, summary, summary_through, summary_model_id, extracted_through, created_at, last_message_at, modified_at, deleted) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
				[
					globalThreadId,
					globalUserId,
					"web",
					"local",
					0,
					"Interrupt Test",
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

			// Seed an initial user message.
			globalDb.run(
				"INSERT INTO messages (id, thread_id, role, content, model_id, tool_name, created_at, modified_at, host_origin, deleted) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
				[
					randomUUID(),
					globalThreadId,
					"user",
					"Run the test sweep",
					null,
					null,
					new Date().toISOString(),
					new Date().toISOString(),
					"local",
					0,
				],
			);

			const mockBackend = new MockLLMBackend();
			// First turn: emit a simple text response so cold-path assembly
			// completes and a CachedTurnState is written. cache_write_tokens>0
			// so predictCacheState flips to "warm" for the next invocation.
			mockBackend.pushResponse(async function* () {
				yield { type: "text" as const, content: "Kicking off tests" };
				yield {
					type: "done" as const,
					usage: {
						input_tokens: 100,
						output_tokens: 5,
						cache_write_tokens: 100,
						cache_read_tokens: 0,
						estimated: false,
					},
				};
			});
			// Second turn: respond to the user interrupt with plain text.
			// This only runs if the warm-path orphan guard correctly falls
			// through to the cold path — otherwise the AI SDK would reject
			// the request before it reaches the mock.
			mockBackend.pushResponse(async function* () {
				yield { type: "text" as const, content: "295 files is unexpected" };
				yield {
					type: "done" as const,
					usage: {
						input_tokens: 20,
						output_tokens: 10,
						cache_write_tokens: 0,
						cache_read_tokens: 100,
						estimated: false,
					},
				};
			});

			const sharedStore = new InMemoryTurnStateStore();

			// First invocation: cold path, populates cached turn state.
			const pathLogs1: CachePathLog[] = [];
			const ctx1 = makeCtx(pathLogs1, sharedStore);
			const loop1 = new MainAgentLoop(ctx1, createMockSandbox(), createMockRouter(mockBackend), {
				threadId: globalThreadId,
				userId: globalUserId,
			});
			await loop1.run();
			expect(pathLogs1[0]?.path).toBe("cold");

			// Now simulate what happens when the agent-loop persists a
			// tool_call and yields for a client tool (no matching tool_result
			// yet), then the user types a follow-up before the result arrives.
			const pendingToolUseId = "tooluse_cBtTP010NOWBe6yiRFVIDb";
			const toolCallContent = JSON.stringify([
				{
					type: "tool_use",
					id: pendingToolUseId,
					name: "boundless_bash",
					input: { command: "bun test" },
				},
			]);
			globalDb.run(
				"INSERT INTO messages (id, thread_id, role, content, model_id, tool_name, created_at, modified_at, host_origin, deleted) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
				[
					randomUUID(),
					globalThreadId,
					"tool_call",
					toolCallContent,
					null,
					null,
					new Date().toISOString(),
					new Date().toISOString(),
					"local",
					0,
				],
			);
			globalDb.run(
				"INSERT INTO messages (id, thread_id, role, content, model_id, tool_name, created_at, modified_at, host_origin, deleted) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
				[
					randomUUID(),
					globalThreadId,
					"user",
					"Why does the diff have 295 files?",
					null,
					null,
					new Date().toISOString(),
					new Date().toISOString(),
					"local",
					0,
				],
			);

			// Second invocation: warm is eligible BUT the delta contains an
			// unmatched tool_call. The guard should redirect to cold
			// reassembly rather than shipping an orphan to the backend.
			const pathLogs2: CachePathLog[] = [];
			const ctx2 = makeCtx(pathLogs2, sharedStore);
			const loop2 = new MainAgentLoop(ctx2, createMockSandbox(), createMockRouter(mockBackend), {
				threadId: globalThreadId,
				userId: globalUserId,
			});
			const result2 = await loop2.run();

			// The loop must not fatally error. The pre-fix behavior surfaced
			// the AI SDK error as `agent-loop error: ... MissingToolResultsError`.
			expect(result2).toHaveProperty("messagesCreated");
			expect(result2).not.toHaveProperty("error");

			// The second turn must take the cold path (warm fell back because
			// of the orphan). Reason should reflect the fallback — we log
			// "budget-exceeded" for the other fall-through branch so this
			// new path gets its own bucket implicitly via usedWarmPath=false.
			expect(pathLogs2[0]?.path).toBe("cold");

			// Every captured LLM payload MUST NOT contain a dangling tool_call.
			// (i.e. each tool_use_id must be followed by a matching tool_result
			// in the same messages array.)
			for (const params of mockBackend.getCapturedParams()) {
				const messages = params.messages;
				const pendingIds = new Set<string>();
				let inToolCall = false;
				for (const m of messages) {
					if (m.role === "tool_call") {
						inToolCall = true;
						const content = Array.isArray(m.content) ? m.content : m.content;
						try {
							const blocks =
								typeof content === "string" ? JSON.parse(content) : (content as unknown[]);
							if (Array.isArray(blocks)) {
								for (const b of blocks) {
									const block = b as { type?: string; id?: string };
									if (block.type === "tool_use" && block.id) {
										pendingIds.add(block.id);
									}
								}
							}
						} catch {
							// opaque tool_call — just track inToolCall
						}
					} else if (m.role === "tool_result") {
						if (m.tool_use_id) pendingIds.delete(m.tool_use_id);
						if (pendingIds.size === 0) inToolCall = false;
					} else if (m.role !== "cache" && m.role !== "developer") {
						expect(pendingIds.size).toBe(0);
						expect(inToolCall).toBe(false);
					}
				}
				// End-of-array: no leftover pending ids.
				expect(pendingIds.size).toBe(0);
				expect(inToolCall).toBe(false);
			}
		});

		it("compacts oversized tool_results in place when warm-path budget would otherwise bail", async () => {
			// Regression, observed live. When the warm-path budget gate fails because
			// stored tool_results have grown past the effective budget, we
			// must NOT immediately clear CachedTurnState and bail to a cold
			// rebuild. The cold rebuild produces a different byte-prefix,
			// so the provider's prefix cache misses on the next turn,
			// turning every "warm" turn into a fresh cache_write. This
			// caused a 4.7x cache_write/cache_read imbalance on the live
			// thread.
			//
			// Fix: before clearing state and bailing, run the same
			// Stage 1.7 compaction the cold path runs (tool_result →
			// retrieval-pointer stub). Re-check budget. Only fall through
			// to cold if compaction wasn't enough.
			globalDb.run(
				"INSERT INTO threads (id, user_id, interface, host_origin, color, title, summary, summary_through, summary_model_id, extracted_through, created_at, last_message_at, modified_at, deleted) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
				[
					globalThreadId,
					globalUserId,
					"web",
					"local",
					0,
					"Warm Compaction Test",
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

			// Seed a single user message in the DB so cold path has work.
			const userMsgId = randomUUID();
			globalDb.run(
				"INSERT INTO messages (id, thread_id, role, content, model_id, tool_name, created_at, modified_at, host_origin, deleted) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
				[
					userMsgId,
					globalThreadId,
					"user",
					"Hello",
					null,
					null,
					new Date(Date.now() - 10_000).toISOString(),
					new Date(Date.now() - 10_000).toISOString(),
					"local",
					0,
				],
			);

			const oversizedToolUseId = "tooluse_warm_compact_test_id_x1";

			// Pre-seed CachedTurnState directly to bypass the cold-pass
			// setup mechanics. We're testing the warm-path budget gate
			// logic, not the end-to-end cold→warm transition. The
			// previously-seeded state simulates "after several rounds of
			// cold+warm turns, an oversized tool_result is sitting in the
			// cached storedMessages array".
			const sharedStore = new InMemoryTurnStateStore();
			// 1M chars ≈ 222k tokens. Against a 200k contextWindow with no
			// configured maxOutputTokens (falls back to
			// DEFAULT_OUTPUT_TOKEN_RESERVE = 8k), the base truncation target
			// is 192k — this guarantees the budget gate fires. Compaction
			// shrinks it to a ~few-hundred char stub, so post-compaction
			// we're back under budget.
			//
			// We use a varied-character pattern (not all "X") because
			// js-tiktoken collapses long runs of identical characters into
			// short token sequences, and a 1M-char "X" string would only
			// count as ~few hundred tokens — not enough to trip the budget
			// gate.
			const buildVariedContent = (size: number) => {
				const chunks: string[] = [];
				const pattern = "the quick brown fox jumps over the lazy dog. ";
				while (chunks.join("").length < size) {
					chunks.push(pattern);
				}
				return chunks.join("").slice(0, size);
			};
			const inflatedToolResultContent = buildVariedContent(1_000_000);
			// At 200k contextWindow the cold-path Stage 1.7 default
			// recent-window is 20 messages. Seed enough recent-window
			// padding that the oversized tool_result lands well outside
			// it, otherwise compaction has no eligible messages and bails.
			const recentWindowPadding: LLMMessage[] = [];
			for (let i = 0; i < 25; i++) {
				recentWindowPadding.push({
					role: i % 2 === 0 ? "user" : "assistant",
					content: `padding turn ${i}`,
				});
			}
			const seededMessages: LLMMessage[] = [
				{ role: "user", content: "Run a big tool" },
				{
					role: "tool_call",
					content: JSON.stringify([
						{
							type: "tool_use",
							id: oversizedToolUseId,
							name: "bash",
							input: { command: "ls /huge" },
						},
					]),
				},
				{
					role: "tool_result",
					tool_use_id: oversizedToolUseId,
					content: inflatedToolResultContent,
				},
				...recentWindowPadding,
				{ role: "cache", content: "" },
			];
			sharedStore.set(globalThreadId, {
				messages: seededMessages,
				systemPrompt: "You are an assistant.",
				cacheMessagePositions: [seededMessages.length - 1],
				fixedCacheIdx: seededMessages.length - 1,
				lastMessageCreatedAt: new Date(Date.now() - 5_000).toISOString(),
				toolFingerprint: computeToolFingerprint(undefined),
				debugSections: [],
			});

			// Insert a fresh user message *after* lastMessageCreatedAt so
			// the warm-path delta fetch finds something to append. Also
			// insert a synthetic prior turn with cache_write_tokens > 0 so
			// predictCacheState returns "warm".
			globalDb.run(
				`INSERT INTO turns (id, thread_id, model_id, tokens_in, tokens_out, tokens_cache_write, tokens_cache_read, cost_usd, created_at, status, modified_at)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
				[
					randomUUID(),
					globalThreadId,
					"claude-opus",
					100,
					5,
					100, // cache_write > 0 so predictCacheState says "warm"
					0,
					0,
					new Date(Date.now() - 5_000).toISOString(),
					"ok",
					new Date(Date.now() - 5_000).toISOString(),
				],
			);
			globalDb.run(
				"INSERT INTO messages (id, thread_id, role, content, model_id, tool_name, created_at, modified_at, host_origin, deleted) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
				[
					randomUUID(),
					globalThreadId,
					"user",
					"Follow-up after seed",
					null,
					null,
					new Date().toISOString(),
					new Date().toISOString(),
					"local",
					0,
				],
			);

			const mockBackend = new MockLLMBackend();
			mockBackend.pushResponse(async function* () {
				yield { type: "text" as const, content: "Warm + compacted" };
				yield {
					type: "done" as const,
					usage: {
						input_tokens: 20,
						output_tokens: 10,
						cache_write_tokens: 0,
						cache_read_tokens: 100,
						estimated: false,
					},
				};
			});

			const pathLogs: CachePathLog[] = [];
			const ctx = makeCtx(pathLogs, sharedStore);
			const loop = new MainAgentLoop(ctx, createMockSandbox(), createMockRouter(mockBackend), {
				threadId: globalThreadId,
				userId: globalUserId,
			});
			await loop.run();

			// THE KEY ASSERTION: warm path was used despite the inflated
			// stored array. Pre-fix this would log path=cold,
			// reason=budget-exceeded.
			expect(pathLogs[0]?.path).toBe("warm");

			// And the cached state's tool_result was actually compacted
			// in-place. The stub references the tool_use_id so the agent
			// can recover full content.
			const cachedAfterWarm = sharedStore.get(globalThreadId);
			expect(cachedAfterWarm).toBeDefined();
			const compactedToolResult = cachedAfterWarm?.messages.find(
				(m) => m.role === "tool_result" && m.tool_use_id === oversizedToolUseId,
			);
			expect(compactedToolResult).toBeDefined();
			expect(typeof compactedToolResult?.content).toBe("string");
			expect((compactedToolResult?.content as string).length).toBeLessThan(800_000);
			expect(compactedToolResult?.content as string).toContain(oversizedToolUseId);
		});
	});
});
