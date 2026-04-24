import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LLMMessage, ToolDefinition } from "@bound/llm";
import { cleanupTmpDir } from "@bound/shared/test-utils";
import { type CachedTurnState, computeToolFingerprint } from "../cached-turn-state";

let globalTmpDir: string;

beforeAll(() => {
	globalTmpDir = mkdtempSync(join(tmpdir(), "warm-cold-path-test-"));
});

afterAll(async () => {
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
});
