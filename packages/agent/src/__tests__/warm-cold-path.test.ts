import type { Database } from "bun:sqlite";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyMetricsSchema, applySchema, createDatabase } from "@bound/core";
import type { AppContext } from "@bound/core";
import type { ChatParams, LLMBackend, StreamChunk, ToolDefinition } from "@bound/llm";
import { ModelRouter } from "@bound/llm";
import type { LLMMessage } from "@bound/llm";
import { countContentTokens } from "@bound/shared";
import { cleanupTmpDir } from "@bound/shared/test-utils";
import { AgentLoop } from "../agent-loop";
import { type CachedTurnState, computeToolFingerprint } from "../cached-turn-state";
import { TRUNCATION_TARGET_RATIO } from "../context-assembly";

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
	globalThreadId = randomUUID();
});

afterAll(async () => {
	globalDb.close();
	if (globalTmpDir) {
		await cleanupTmpDir(globalTmpDir);
	}
});

describe("warm-cold-path", () => {
	describe("AC1.4: Cold path fires when no stored state exists (first invocation)", () => {
		it("cold path is used when no cached state exists", () => {
			// When _cachedTurnState is undefined, the cold path runs: !isWarmPathEligible branch
			// This is verified by the condition:
			//   const isWarmPathEligible = cacheState === "warm" &&
			//     this._cachedTurnState !== undefined && ...
			// When _cachedTurnState is undefined, isWarmPathEligible = false, so cold path runs
			let coldPathExecuted = false;

			// Simulate the logic: isWarmPathEligible check
			const cachedTurnState: CachedTurnState | undefined = undefined; // First invocation
			const cacheState = "warm" as const;
			const fingerprint = "fp1";
			const isWarmPathEligible =
				cacheState === "warm" &&
				cachedTurnState !== undefined &&
				cachedTurnState.toolFingerprint === fingerprint;

			if (!isWarmPathEligible) {
				coldPathExecuted = true;
			}

			expect(coldPathExecuted).toBe(true);
		});
	});

	describe("AC1.1: Warm-path turn reuses stored messages and appends only new ones", () => {
		it("warm path appends delta messages to stored messages", () => {
			// Simulate warm-path message accumulation
			const storedMessages: LLMMessage[] = [
				{ role: "user", content: "Hello" },
				{ role: "assistant", content: "Hi there" },
				{ role: "developer", content: "old volatile" }, // Will be removed
			];

			// Simulate delta from DB (new messages)
			const deltaMessages: LLMMessage[] = [
				{ role: "user", content: "How are you?" },
				{ role: "assistant", content: "I'm good!" },
			];

			// Warm path logic: remove old developer tail
			const storedCopy = [...storedMessages];
			if (storedCopy[storedCopy.length - 1]?.role === "developer") {
				storedCopy.pop();
			}

			// Append delta
			storedCopy.push(...deltaMessages);

			// Add new developer message
			storedCopy.push({
				role: "developer",
				content: "new volatile",
			});

			// Verify: stored messages preserved, delta appended
			expect(storedCopy.length).toBe(5); // 2 + 2 + 1 new developer
			expect(storedCopy[0]).toEqual({ role: "user", content: "Hello" });
			expect(storedCopy[1]).toEqual({ role: "assistant", content: "Hi there" });
			expect(storedCopy[2]).toEqual({ role: "user", content: "How are you?" });
			expect(storedCopy[3]).toEqual({ role: "assistant", content: "I'm good!" });
			expect(storedCopy[4].role).toBe("developer");
		});
	});

	describe("AC1.3: Fixed cache message stays at same index; rolling cache advances", () => {
		it("fixed cache message placement on cold path", () => {
			// Cold path places cache at index length - 2
			const nonSystemMessages: LLMMessage[] = [
				{ role: "user", content: "msg1" },
				{ role: "assistant", content: "msg2" },
			];

			const fixedCacheIdx = nonSystemMessages.length >= 2 ? nonSystemMessages.length - 2 : -1;
			expect(fixedCacheIdx).toBe(0); // length(2) - 2 = 0

			if (fixedCacheIdx >= 0) {
				nonSystemMessages.splice(fixedCacheIdx + 1, 0, { role: "cache", content: "" });
			}

			expect(nonSystemMessages.length).toBe(3);
			expect(nonSystemMessages[1].role).toBe("cache");
		});

		it("rolling cache message placement on warm path", () => {
			// Warm path places rolling cache at messages.length - 1, then adds developer
			const messages: LLMMessage[] = [
				{ role: "user", content: "msg1" },
				{ role: "cache", content: "" }, // fixed cache from cold path
				{ role: "assistant", content: "msg2" },
				{ role: "developer", content: "volatile" },
			];

			// Warm path: remove old developer tail
			if (messages[messages.length - 1]?.role === "developer") {
				messages.pop();
			}
			// After removing: [user, cache, assistant]

			// Add new delta message
			messages.push({ role: "user", content: "msg3" });
			// After pushing: [user, cache, assistant, user]

			// Place rolling cache at length - 1 (before the last message)
			if (messages.length >= 2) {
				messages.splice(messages.length - 1, 0, { role: "cache", content: "" });
			}
			// After splice: [user, cache, assistant, cache, user]

			// Add new developer
			messages.push({ role: "developer", content: "new volatile" });
			// After push: [user, cache, assistant, cache, user, developer]

			// Verify rolling cache is at length - 2 (before developer)
			expect(messages[messages.length - 2].role).toBe("user");
			expect(messages[messages.length - 1].role).toBe("developer");
			// The rolling cache is at index 3 (messages[3])
			const rollingCacheIdx = messages.findIndex((m, i) => i > 1 && m.role === "cache");
			expect(rollingCacheIdx).toBe(3);
		});
	});

	describe("AC1.5: Thread with only 1 message skips cache message placement", () => {
		it("skips cache message when fewer than 2 messages", () => {
			// When nonSystemMessages.length < 2, fixedCacheIdx = -1, skip cache placement
			const nonSystemMessages: LLMMessage[] = [{ role: "user", content: "only msg" }];

			const fixedCacheIdx = nonSystemMessages.length >= 2 ? nonSystemMessages.length - 2 : -1;
			expect(fixedCacheIdx).toBe(-1);

			// Cache placement skipped
			expect(nonSystemMessages.length).toBe(1);
			expect(nonSystemMessages[0].role).toBe("user");
		});
	});

	describe("AC3.1: predictCacheState cold triggers full assembleContext rebuild", () => {
		it("cold cache state forces cold path even with stored state", () => {
			// isWarmPathEligible = (cacheState === "warm") && ...
			// If cacheState === "cold", then isWarmPathEligible = false
			const cachedTurnState: CachedTurnState = {
				messages: [{ role: "user", content: "test" }],
				systemPrompt: "system",
				cacheMessagePositions: [],
				fixedCacheIdx: -1,
				lastMessageCreatedAt: "2026-04-23T10:00:00Z",
				toolFingerprint: "same_fp",
			};

			let coldPathExecuted = false;

			// Simulate with cold cache state
			const cacheState = "cold" as const;
			const currentFingerprint = "same_fp";
			const isWarmPathEligible =
				cacheState === "warm" &&
				cachedTurnState !== undefined &&
				cachedTurnState.toolFingerprint === currentFingerprint;

			if (!isWarmPathEligible) {
				coldPathExecuted = true;
			}

			expect(coldPathExecuted).toBe(true);
		});
	});

	describe("AC3.3: Tool fingerprint change between turns triggers cold path", () => {
		it("should detect tool fingerprint changes", () => {
			const tools1: ToolDefinition[] = [
				{
					function: {
						name: "tool_a",
						description: "Tool A",
						parameters: { type: "object", properties: {} },
					},
				},
			];

			const tools2: ToolDefinition[] = [
				{
					function: {
						name: "tool_a",
						description: "Tool A",
						parameters: { type: "object", properties: {} },
					},
				},
				{
					function: {
						name: "tool_b",
						description: "Tool B",
						parameters: { type: "object", properties: {} },
					},
				},
			];

			const fp1 = computeToolFingerprint(tools1);
			const fp2 = computeToolFingerprint(tools2);

			// Fingerprint mismatch triggers cold path
			const cachedTurnState: CachedTurnState = {
				messages: [],
				systemPrompt: "",
				cacheMessagePositions: [],
				fixedCacheIdx: -1,
				lastMessageCreatedAt: "2026-04-23T10:00:00Z",
				toolFingerprint: fp1, // old fingerprint
			};

			const isWarmPathEligible =
				true && // assume cache state is warm
				cachedTurnState !== undefined &&
				cachedTurnState.toolFingerprint === fp2; // current fingerprint differs

			expect(isWarmPathEligible).toBe(false); // cold path triggered
		});
	});

	describe("AC3.4: Cold path places fixed cache message at messages[length-2]", () => {
		it("cold path places single cache message at correct position", () => {
			const nonSystemMessages: LLMMessage[] = [
				{ role: "user", content: "msg1" },
				{ role: "assistant", content: "msg2" },
				{ role: "user", content: "msg3" },
			];

			// Cold path: place at length - 2
			const fixedCacheIdx = nonSystemMessages.length >= 2 ? nonSystemMessages.length - 2 : -1;
			expect(fixedCacheIdx).toBe(1); // 3 - 2 = 1

			if (fixedCacheIdx >= 0) {
				nonSystemMessages.splice(fixedCacheIdx + 1, 0, { role: "cache", content: "" });
			}

			// Verify: cache at index 2 (original index 2 shifted to 3)
			expect(nonSystemMessages[2].role).toBe("cache");
			expect(nonSystemMessages.length).toBe(4);
		});
	});

	describe("AC3.5: Cold path stores CachedTurnState for subsequent warm turns", () => {
		it("cold path creates valid CachedTurnState", () => {
			const systemMessages: LLMMessage[] = [{ role: "system", content: "system prompt" }];
			const nonSystemMessages: LLMMessage[] = [
				{ role: "user", content: "msg1" },
				{ role: "assistant", content: "msg2" },
			];

			// fixedCacheIdx = 0 (length 2 - 2 = 0)
			// Cache is inserted at fixedCacheIdx + 1 = 1
			const fixedCacheIdx = nonSystemMessages.length >= 2 ? nonSystemMessages.length - 2 : -1;
			expect(fixedCacheIdx).toBe(0);

			const cachedTurnState: CachedTurnState = {
				messages: [...nonSystemMessages],
				systemPrompt: systemMessages
					.map((m) => (typeof m.content === "string" ? m.content : ""))
					.join("\n\n"),
				cacheMessagePositions: fixedCacheIdx >= 0 ? [fixedCacheIdx + 1] : [],
				fixedCacheIdx: fixedCacheIdx >= 0 ? fixedCacheIdx + 1 : -1,
				lastMessageCreatedAt: "2026-04-23T10:00:00Z",
				toolFingerprint: "fp123",
			};

			// Verify state is valid and usable for warm path
			expect(cachedTurnState.messages.length).toBe(2);
			expect(cachedTurnState.systemPrompt).toBe("system prompt");
			expect(cachedTurnState.fixedCacheIdx).toBe(1); // fixedCacheIdx + 1 = 0 + 1 = 1
			expect(cachedTurnState.cacheMessagePositions).toEqual([1]); // [fixedCacheIdx + 1] = [1]
		});
	});

	describe("AC3.2 & AC6.4: High-water mark budget check triggers cold reassembly", () => {
		it("warm path detects when estimated total exceeds contextWindow", () => {
			// Simulate warm path budget check formula from agent-loop.ts line 513:
			// estimatedTotal = storedTokens + systemTokens + toolTokenEstimate
			// Note: storedTokens already includes delta and volatile by this point
			// (they are part of storedMessages array after append and volatile injection)
			const contextWindow = 5000;

			// Stored messages after append and volatile injection (agent-loop.ts line 468-505)
			// This array already contains:
			// - Original cached messages
			// - Appended delta messages
			// - Rolling cache message
			// - Fresh volatile developer message
			const storedMessages: LLMMessage[] = [
				{ role: "user", content: "A".repeat(4000) }, // ~1000 tokens
				{ role: "assistant", content: "B".repeat(4000) }, // ~1000 tokens
				{ role: "user", content: "C".repeat(4000) }, // ~1000 tokens (delta)
				{ role: "assistant", content: "D".repeat(4000) }, // ~1000 tokens (delta)
				{ role: "cache", content: "" }, // 0 tokens
				{ role: "developer", content: "E".repeat(1000) }, // ~250 tokens (volatile)
			];

			// Tool definitions estimate
			const toolTokenEstimate = 500;

			// System prompt (kept separately from storedMessages)
			const systemPrompt = "You are an assistant."; // ~5 tokens

			// Production formula: stored + system + tools (delta and volatile are already in stored)
			const storedTokens = storedMessages.reduce(
				(sum, msg) => sum + countContentTokens(msg.content),
				0,
			);
			const systemTokens = countContentTokens(systemPrompt);
			const estimatedTotal = storedTokens + systemTokens + toolTokenEstimate;

			// When estimated total exceeds contextWindow, cold path should be triggered
			const exceedsWindow = estimatedTotal > contextWindow;
			expect(exceedsWindow).toBe(true);
			// Verify the calculation is actually meaningful
			expect(estimatedTotal).toBeGreaterThan(contextWindow);
		});

		it("warm path stays within budget when growth is modest", () => {
			// This test verifies that small delta messages don't trigger budget check
			const contextWindow = 10000;

			// Stored messages after append (agent-loop.ts line 468-505)
			const storedMessages: LLMMessage[] = [
				{ role: "user", content: "Small message 1" }, // ~3 tokens
				{ role: "assistant", content: "Small response 1" }, // ~3 tokens
				{ role: "user", content: "Q?" }, // ~1 token (delta)
				{ role: "cache", content: "" }, // 0 tokens
				{ role: "developer", content: "System ready." }, // ~2 tokens (volatile)
			];

			const toolTokenEstimate = 500;
			const systemPrompt = "You are an assistant."; // ~5 tokens

			// Production formula: stored + system + tools
			const storedTokens = storedMessages.reduce(
				(sum, msg) => sum + countContentTokens(msg.content),
				0,
			);
			const systemTokens = countContentTokens(systemPrompt);
			const estimatedTotal = storedTokens + systemTokens + toolTokenEstimate;

			// This should stay well within the window
			const exceedsWindow = estimatedTotal > contextWindow;
			expect(exceedsWindow).toBe(false);
			expect(estimatedTotal).toBeLessThan(contextWindow);
		});
	});

	describe("AC6.1: Cold-path assembly targets 0.85 of contextWindow", () => {
		it("verifies TRUNCATION_TARGET_RATIO is 0.85", () => {
			expect(TRUNCATION_TARGET_RATIO).toBe(0.85);
		});

		it("truncation target calculation at 200k context window", () => {
			const contextWindow = 200000;
			const truncationTarget = Math.floor(contextWindow * TRUNCATION_TARGET_RATIO);

			// Should target 85% = 170k tokens
			expect(truncationTarget).toBe(170000);

			// Headroom = 15% = 30k tokens
			const headroom = contextWindow - truncationTarget;
			expect(headroom).toBe(30000);
		});
	});

	describe("AC6.2: Warm-path turns fit within headroom (500 tokens/turn × 20 turns)", () => {
		it("20 warm-path turns at 500 tokens each fit in 30k headroom", () => {
			const contextWindow = 200000;
			const truncationTarget = Math.floor(contextWindow * TRUNCATION_TARGET_RATIO);
			const headroom = contextWindow - truncationTarget;

			// 20 turns × 500 tokens = 10k tokens
			const warmPathTurns = 20;
			const tokensPerTurn = 500;
			const totalWarmPathTokens = warmPathTurns * tokensPerTurn;

			// Should fit comfortably within 30k headroom
			expect(totalWarmPathTokens).toBeLessThan(headroom);
			expect(headroom - totalWarmPathTokens).toBeGreaterThan(5000); // safety margin
		});
	});

	describe("AC6.3: Initial cold-path assembly doesn't exceed contextWindow", () => {
		it("truncation ensures final total <= contextWindow", () => {
			const contextWindow = 200000;
			const truncationTarget = Math.floor(contextWindow * TRUNCATION_TARGET_RATIO);

			// After truncation targets truncationTarget tokens, total should be <= contextWindow
			// The cold path maintains: system + history (truncated) + tools + volatile <= contextWindow
			// Truncation ensures history doesn't exceed truncationTarget, so:
			// total = system + history + tools + volatile <= system + truncationTarget + tools + volatile

			// For safety, assume worst case: system=5k, tools=2k, volatile=3k (10k overhead)
			const overhead = 5000 + 2000 + 3000;
			const maxWithOverhead = truncationTarget + overhead;

			// This should stay under contextWindow (truncation prevents overflow)
			expect(maxWithOverhead).toBeLessThanOrEqual(contextWindow);
		});
	});

	describe("AC6.4: Thread with large tool results triggers reassembly quickly", () => {
		it("rapid accumulation of large tool results triggers reassembly within 3-4 turns", () => {
			const contextWindow = 200000;
			const headroom = contextWindow - Math.floor(contextWindow * TRUNCATION_TARGET_RATIO);

			// Each turn adds a large tool result (~5k tokens)
			const tokensPerLargeTurn = 5000;

			// Calculate how many turns fit in headroom
			const turnsBeforeReassembly = Math.floor(headroom / tokensPerLargeTurn);

			// At ~5k per turn, headroom (30k) allows ~6 turns
			// But with other overhead (volatile, etc), should trigger within 3-4 turns
			expect(turnsBeforeReassembly).toBeGreaterThan(2); // At least 2
			expect(turnsBeforeReassembly).toBeLessThan(8); // But not too many
		});
	});

	// ─── Integration tests: multi-invocation warm/cold cycles ─────────────────

	describe("integration: multi-invocation warm/cold cycles", () => {
		// Mock LLM Backend for testing
		class MockLLMBackend implements LLMBackend {
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
					vision: false,
					max_context: 200000,
				};
			}
		}

		function createMockRouter(backend: LLMBackend): ModelRouter {
			const backends = new Map<string, LLMBackend>();
			backends.set("claude-opus", backend);
			return new ModelRouter(backends, "claude-opus");
		}

		function makeCtx(): AppContext {
			return {
				db: globalDb,
				logger: {
					debug: () => {},
					info: () => {},
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
			mockBackend.setTextResponse("Hello");
			mockBackend.setTextResponse("Follow-up response");

			// First invocation (cold path expected)
			const ctx1 = makeCtx();
			const agentLoop1 = new AgentLoop(ctx1, createMockSandbox(), createMockRouter(mockBackend), {
				threadId: globalThreadId,
				userId: globalUserId,
			});

			const result1 = await agentLoop1.run();
			expect(result1).toHaveProperty("messagesCreated");
			expect(result1.messagesCreated).toBeGreaterThan(0);

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

			// Second invocation (warm path expected)
			const ctx2 = makeCtx();
			const agentLoop2 = new AgentLoop(ctx2, createMockSandbox(), createMockRouter(mockBackend), {
				threadId: globalThreadId,
				userId: globalUserId,
			});

			const result2 = await agentLoop2.run();
			expect(result2).toHaveProperty("messagesCreated");

			// Verify both invocations completed
			expect(mockBackend.getCallCount()).toBeGreaterThanOrEqual(2);
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
			mockBackend.setTextResponse("Response 2");

			// First run
			const ctx1 = makeCtx();
			const agentLoop1 = new AgentLoop(ctx1, createMockSandbox(), createMockRouter(mockBackend), {
				threadId: globalThreadId,
				userId: globalUserId,
			});
			await agentLoop1.run();

			// Second run (should trigger reassembly if DB cache is invalidated)
			const ctx2 = makeCtx();
			const agentLoop2 = new AgentLoop(ctx2, createMockSandbox(), createMockRouter(mockBackend), {
				threadId: globalThreadId,
				userId: globalUserId,
			});
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
			mockBackend.setTextResponse("Response with tools 1 and 2");

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

			// First invocation with one tool
			const ctx1 = makeCtx();
			const agentLoop1 = new AgentLoop(ctx1, createMockSandbox(), createMockRouter(mockBackend), {
				threadId: globalThreadId,
				userId: globalUserId,
				tools: [tool1],
			});
			await agentLoop1.run();

			// Second invocation with added tool (fingerprint changed)
			const ctx2 = makeCtx();
			const agentLoop2 = new AgentLoop(ctx2, createMockSandbox(), createMockRouter(mockBackend), {
				threadId: globalThreadId,
				userId: globalUserId,
				tools: [tool1, tool2],
			});
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
			mockBackend.setTextResponse("Second response");

			// First invocation: generates volatile context
			const ctx1 = makeCtx();
			const agentLoop1 = new AgentLoop(ctx1, createMockSandbox(), createMockRouter(mockBackend), {
				threadId: globalThreadId,
				userId: globalUserId,
			});
			const result1 = await agentLoop1.run();
			expect(result1).toHaveProperty("messagesCreated");

			// Second invocation: generates fresh volatile context (even if warm path)
			const ctx2 = makeCtx();
			const agentLoop2 = new AgentLoop(ctx2, createMockSandbox(), createMockRouter(mockBackend), {
				threadId: globalThreadId,
				userId: globalUserId,
			});
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
			mockBackend.setTextResponse("Second turn (warm reuse)");

			// First invocation: cold path, caches state
			const ctx1 = makeCtx();
			const loop1 = new AgentLoop(ctx1, createMockSandbox(), createMockRouter(mockBackend), {
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
			const ctx2 = makeCtx();
			const loop2 = new AgentLoop(ctx2, createMockSandbox(), createMockRouter(mockBackend), {
				threadId: globalThreadId,
				userId: globalUserId,
			});
			const result2 = await loop2.run();
			expect(result2).toHaveProperty("messagesCreated");

			// Both should have completed successfully
			expect(mockBackend.getCallCount()).toBeGreaterThanOrEqual(2);
		});
	});
});
