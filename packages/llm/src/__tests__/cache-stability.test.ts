/**
 * Cache stability invariant tests for the Bedrock driver.
 *
 * Bedrock prompt caching works by matching the byte-for-byte prefix of the
 * request up to the cachePoint marker. If ANY part of that prefix changes
 * between calls — even a single character — the cache is busted and a new
 * write occurs instead of a read.
 *
 * These tests enforce the invariants that keep the prefix stable:
 *   1. Deterministic output — same input produces identical raw requests
 *   2. No Date.now() or other non-deterministic values in the cached prefix
 *   3. cachePoint placement is predictable and stable
 *   4. System blocks are stable when the stable prefix doesn't change
 *   5. Tool config serialization is deterministic
 */

import { describe, expect, it } from "bun:test";
import {
	emitCacheDebug,
	findCachePointIndex,
	fingerprint,
	stableStringify,
} from "../bedrock-driver";
import { type ConvertInput, toBedrockMessages, toBedrockRequest } from "../bedrock/convert";
import type { ChatParams, LLMMessage, ToolDefinition } from "../types";

// ─── Helpers ────────────────────────────────────────────────────────────────

function makeInput(overrides?: Partial<ChatParams>): ConvertInput {
	return {
		params: {
			messages: [
				{ role: "user", content: "Hello" },
				{ role: "assistant", content: "Hi there!" },
				{ role: "user", content: "How are you?" },
			],
			system: "You are a helpful assistant.",
			cache_breakpoints: [1],
			...overrides,
		},
		defaultModel: "anthropic.claude-3-5-sonnet-20241022-v2:0",
	};
}

const SAMPLE_TOOLS: ToolDefinition[] = [
	{
		type: "function",
		function: {
			name: "bash",
			description: "Run a shell command",
			parameters: {
				type: "object",
				properties: { command: { type: "string" } },
				required: ["command"],
			},
		},
	},
	{
		type: "function",
		function: {
			name: "memorize",
			description: "Store a memory",
			parameters: {
				type: "object",
				properties: {
					key: { type: "string" },
					value: { type: "string" },
				},
				required: ["key", "value"],
			},
		},
	},
];

// ─── 1. Deterministic output ────────────────────────────────────────────────

describe("cache stability: deterministic output", () => {
	it("toBedrockRequest produces identical output for identical input", () => {
		const input = makeInput();
		const a = toBedrockRequest(input);
		const b = toBedrockRequest(input);

		// Byte-for-byte comparison via stable serialization
		expect(stableStringify(a)).toBe(stableStringify(b));
	});

	it("toBedrockRequest is deterministic with tools", () => {
		const input = makeInput({ tools: SAMPLE_TOOLS });
		const a = toBedrockRequest(input);
		const b = toBedrockRequest(input);

		expect(stableStringify(a)).toBe(stableStringify(b));
	});

	it("toBedrockRequest is deterministic with system_suffix", () => {
		const input = makeInput({
			system_suffix: "Current Model: opus\nThread: abc-123",
		});
		const a = toBedrockRequest(input);
		const b = toBedrockRequest(input);

		expect(stableStringify(a)).toBe(stableStringify(b));
	});

	it("toBedrockRequest is deterministic with thinking config", () => {
		const input = makeInput({
			thinking: { type: "enabled", budget_tokens: 10000 },
		});
		const a = toBedrockRequest(input);
		const b = toBedrockRequest(input);

		expect(stableStringify(a)).toBe(stableStringify(b));
	});

	it("toBedrockMessages produces identical output for identical input", () => {
		const messages: LLMMessage[] = [
			{ role: "user", content: "Run the query" },
			{
				role: "tool_call",
				content: [{ type: "tool_use", id: "tc-1", name: "query", input: { sql: "SELECT 1" } }],
			},
			{ role: "tool_result", content: "1", tool_use_id: "tc-1" },
			{ role: "user", content: "Thanks" },
		];

		const a = toBedrockMessages(messages);
		const b = toBedrockMessages(messages);

		expect(stableStringify(a)).toBe(stableStringify(b));
	});

	it("fingerprint is consistent for the same value", () => {
		const value = { a: 1, b: [2, 3], c: { d: "hello" } };
		expect(fingerprint(value)).toBe(fingerprint(value));
		expect(fingerprint(value)).toHaveLength(12);
	});
});

// ─── 2. synthetic Date.now() instability ────────────────────────────────────

describe("cache stability: synthetic tool_use_id with Date.now()", () => {
	it("tool_result with missing tool_use_id gets a non-deterministic synthetic ID", () => {
		// This test documents the known cache-busting bug: tool_result messages
		// without a tool_use_id get `synthetic-${Date.now()}-${index}` which
		// changes every call.
		const messages: LLMMessage[] = [
			{ role: "user", content: "Run command" },
			{
				role: "tool_call",
				content: JSON.stringify([{ type: "tool_use", id: "tc-1", name: "bash", input: {} }]),
			},
			{
				role: "tool_result",
				content: "output",
				tool_use_id: "", // empty — triggers synthetic ID
			},
		];

		const a = toBedrockMessages(messages);
		// Small delay to ensure Date.now() differs
		const start = Date.now();
		while (Date.now() === start) {
			/* spin */
		}
		const b = toBedrockMessages(messages);

		// Extract toolResult IDs from both runs
		const getToolResultIds = (msgs: Array<Record<string, unknown>>): string[] => {
			const ids: string[] = [];
			for (const msg of msgs) {
				if (Array.isArray(msg.content)) {
					for (const block of msg.content as Array<Record<string, unknown>>) {
						const tr = block.toolResult as { toolUseId?: string } | undefined;
						if (tr?.toolUseId) ids.push(tr.toolUseId);
					}
				}
			}
			return ids;
		};

		const idsA = getToolResultIds(a);
		const idsB = getToolResultIds(b);

		// KNOWN BUG: The synthetic IDs differ because Date.now() changes.
		// This test will FAIL once the bug is fixed (which is the point —
		// flip the assertion when we fix it).
		expect(idsA.length).toBeGreaterThan(0);
		expect(idsB.length).toBeGreaterThan(0);
		expect(idsA[0]).not.toBe(idsB[0]); // ← flip to toBe() after fix
	});

	it("tool_result with undefined tool_use_id gets a non-deterministic synthetic ID", () => {
		const messages: LLMMessage[] = [
			{ role: "user", content: "Run command" },
			{
				role: "tool_call",
				content: JSON.stringify([{ type: "tool_use", id: "tc-1", name: "bash", input: {} }]),
			},
			{
				role: "tool_result",
				content: "output",
				// tool_use_id intentionally omitted
			},
		];

		const a = toBedrockMessages(messages);
		const start = Date.now();
		while (Date.now() === start) {
			/* spin */
		}
		const b = toBedrockMessages(messages);

		const serialA = stableStringify(a);
		const serialB = stableStringify(b);

		// KNOWN BUG: serialized output differs due to Date.now() in synthetic IDs
		expect(serialA).not.toBe(serialB); // ← flip to toBe() after fix
	});

	it("tool_result with valid tool_use_id is deterministic", () => {
		const messages: LLMMessage[] = [
			{ role: "user", content: "Run command" },
			{
				role: "tool_call",
				content: JSON.stringify([{ type: "tool_use", id: "tc-1", name: "bash", input: {} }]),
			},
			{
				role: "tool_result",
				content: "output",
				tool_use_id: "tc-1",
			},
		];

		const a = toBedrockMessages(messages);
		const b = toBedrockMessages(messages);

		expect(stableStringify(a)).toBe(stableStringify(b));
	});
});

// ─── 3. cachePoint placement stability ──────────────────────────────────────

describe("cache stability: cachePoint placement", () => {
	it("cachePoint is placed on messages[length-2] (second-to-last)", () => {
		const input = makeInput();
		const raw = toBedrockRequest(input);
		const messages = raw.messages as Array<Record<string, unknown>>;

		const cpIdx = findCachePointIndex(messages);
		expect(cpIdx).toBe(messages.length - 2);
	});

	it("cachePoint index is stable when appending new messages", () => {
		// Turn N: 3 messages → cachePoint at index 1
		const inputN = makeInput();
		const rawN = toBedrockRequest(inputN);
		const msgsN = rawN.messages as Array<Record<string, unknown>>;
		const cpN = findCachePointIndex(msgsN);

		// Turn N+1: 5 messages → cachePoint at index 3
		const inputN1 = makeInput({
			messages: [
				{ role: "user", content: "Hello" },
				{ role: "assistant", content: "Hi there!" },
				{ role: "user", content: "How are you?" },
				{ role: "assistant", content: "I'm doing well!" },
				{ role: "user", content: "Great" },
			],
		});
		const rawN1 = toBedrockRequest(inputN1);
		const msgsN1 = rawN1.messages as Array<Record<string, unknown>>;
		const cpN1 = findCachePointIndex(msgsN1);

		// The cachePoint should always be at length-2
		expect(cpN).toBe(msgsN.length - 2);
		expect(cpN1).toBe(msgsN1.length - 2);

		// The prefix (everything up to the old cachePoint) in turn N should be
		// a subset of the prefix in turn N+1. The content of messages 0..cpN
		// should be identical in both turns (minus the cachePoint marker on cpN
		// in the turn-N output).
		const prefixN = msgsN.slice(0, cpN);
		const prefixN1 = msgsN1.slice(0, cpN + 1); // +1 because cpN is now a regular message in N+1

		// Messages 0..cpN-1 should be content-identical
		for (let i = 0; i < prefixN.length; i++) {
			// Strip cachePoint markers for content comparison
			const stripCachePoint = (msg: Record<string, unknown>) => {
				if (!Array.isArray(msg.content)) return msg;
				return {
					...msg,
					content: (msg.content as Array<Record<string, unknown>>).filter(
						(b) => !("cachePoint" in b),
					),
				};
			};
			expect(stableStringify(stripCachePoint(prefixN[i]))).toBe(
				stableStringify(stripCachePoint(prefixN1[i])),
			);
		}
	});

	it("no cachePoint when cache_breakpoints is empty", () => {
		const input = makeInput({ cache_breakpoints: [] });
		const raw = toBedrockRequest(input);
		const messages = raw.messages as Array<Record<string, unknown>>;

		expect(findCachePointIndex(messages)).toBe(-1);
	});

	it("no cachePoint when cache_breakpoints is undefined", () => {
		const input = makeInput({ cache_breakpoints: undefined });
		const raw = toBedrockRequest(input);
		const messages = raw.messages as Array<Record<string, unknown>>;

		expect(findCachePointIndex(messages)).toBe(-1);
	});

	it("no cachePoint when fewer than 2 messages", () => {
		const input = makeInput({
			messages: [{ role: "user", content: "Hi" }],
		});
		const raw = toBedrockRequest(input);
		const messages = raw.messages as Array<Record<string, unknown>>;

		expect(findCachePointIndex(messages)).toBe(-1);
	});
});

// ─── 4. System block stability ──────────────────────────────────────────────

describe("cache stability: system blocks", () => {
	it("system blocks are identical when stable prefix is unchanged", () => {
		const a = toBedrockRequest(makeInput());
		const b = toBedrockRequest(makeInput());

		expect(stableStringify(a.system)).toBe(stableStringify(b.system));
	});

	it("system cachePoint separates stable prefix from varying suffix", () => {
		const input = makeInput({
			system_suffix: "Current Model: opus\nThread: abc-123",
		});
		const raw = toBedrockRequest(input);
		const system = raw.system as Array<Record<string, unknown>>;

		// Three-block layout: prefix text, cachePoint, suffix text
		expect(system).toHaveLength(3);
		expect(system[0]).toEqual({ text: "You are a helpful assistant." });
		expect(system[1]).toEqual({ cachePoint: { type: "default" } });
		expect(system[2]).toEqual({ text: "Current Model: opus\nThread: abc-123" });
	});

	it("changing system_suffix does NOT change system prefix fingerprint", () => {
		const a = toBedrockRequest(makeInput({ system_suffix: "Thread: abc-123" }));
		const b = toBedrockRequest(makeInput({ system_suffix: "Thread: xyz-789" }));

		const sysA = a.system as Array<Record<string, unknown>>;
		const sysB = b.system as Array<Record<string, unknown>>;

		// The prefix (blocks before cachePoint) should be identical
		expect(stableStringify(sysA[0])).toBe(stableStringify(sysB[0]));
		expect(stableStringify(sysA[1])).toBe(stableStringify(sysB[1]));

		// The suffix (after cachePoint) should differ
		expect(stableStringify(sysA[2])).not.toBe(stableStringify(sysB[2]));
	});

	it("system blocks without cache_breakpoints concatenate prefix and suffix", () => {
		const input = makeInput({
			system_suffix: "Thread: abc-123",
			cache_breakpoints: undefined,
		});
		const raw = toBedrockRequest(input);
		const system = raw.system as Array<Record<string, unknown>>;

		// Single block with concatenated text
		expect(system).toHaveLength(1);
		expect(system[0]).toEqual({
			text: "You are a helpful assistant.\n\nThread: abc-123",
		});
	});
});

// ─── 5. Tool config stability ───────────────────────────────────────────────

describe("cache stability: tool config", () => {
	it("tool config is deterministic for the same tool set", () => {
		const input = makeInput({ tools: SAMPLE_TOOLS });
		const a = toBedrockRequest(input);
		const b = toBedrockRequest(input);

		expect(stableStringify(a.toolConfig)).toBe(stableStringify(b.toolConfig));
	});

	it("tool ordering affects the serialized output", () => {
		// This test documents that tool ORDER matters for cache stability.
		// If the agent loop sends tools in a different order between calls,
		// the cache will be busted.
		const forward = makeInput({ tools: SAMPLE_TOOLS });
		const reversed = makeInput({ tools: [...SAMPLE_TOOLS].reverse() });

		const a = toBedrockRequest(forward);
		const b = toBedrockRequest(reversed);

		// Different tool orders produce different serializations
		expect(stableStringify(a.toolConfig)).not.toBe(stableStringify(b.toolConfig));
	});

	it("tool config is null when no tools provided", () => {
		const input = makeInput({ tools: undefined });
		const raw = toBedrockRequest(input);

		expect(raw.toolConfig).toBeUndefined();
	});
});

// ─── 6. Cross-call prefix stability simulation ─────────────────────────────

describe("cache stability: multi-turn prefix preservation", () => {
	it("cached prefix content is identical across consecutive turns", () => {
		// Simulate a 3-turn conversation growing by one assistant+user pair each turn.
		const turn1Messages: LLMMessage[] = [
			{ role: "user", content: "Hello" },
			{ role: "assistant", content: "Hi!" },
			{ role: "user", content: "What's 2+2?" },
		];

		const turn2Messages: LLMMessage[] = [
			...turn1Messages,
			{ role: "assistant", content: "4" },
			{ role: "user", content: "Thanks" },
		];

		const raw1 = toBedrockRequest(makeInput({ messages: turn1Messages }));
		const raw2 = toBedrockRequest(makeInput({ messages: turn2Messages }));

		const msgs1 = raw1.messages as Array<Record<string, unknown>>;
		const msgs2 = raw2.messages as Array<Record<string, unknown>>;

		// In turn 1: cachePoint at msgs1.length-2 = index 1
		// In turn 2: cachePoint at msgs2.length-2 = index 3
		// Messages 0 and 1 from turn 1 should match messages 0 and 1 from turn 2
		// (ignoring cachePoint markers which move)
		const strip = (msg: Record<string, unknown>) => {
			if (!Array.isArray(msg.content)) return msg;
			return {
				...msg,
				content: (msg.content as Array<Record<string, unknown>>).filter(
					(b) => !("cachePoint" in b),
				),
			};
		};

		// Every message from turn 1 (stripped of cachePoint) should appear
		// identically in the same position in turn 2
		for (let i = 0; i < msgs1.length; i++) {
			expect(stableStringify(strip(msgs1[i]))).toBe(stableStringify(strip(msgs2[i])));
		}
	});

	it("tool_call + tool_result messages in prefix are stable across turns", () => {
		const baseMsgs: LLMMessage[] = [
			{ role: "user", content: "List files" },
			{
				role: "tool_call",
				content: [{ type: "tool_use", id: "tc-1", name: "bash", input: { command: "ls" } }],
			},
			{ role: "tool_result", content: "file1.txt\nfile2.txt", tool_use_id: "tc-1" },
			{ role: "user", content: "Read file1" },
		];

		const extendedMsgs: LLMMessage[] = [
			...baseMsgs,
			{
				role: "tool_call",
				content: [
					{ type: "tool_use", id: "tc-2", name: "bash", input: { command: "cat file1.txt" } },
				],
			},
			{ role: "tool_result", content: "contents of file1", tool_use_id: "tc-2" },
			{ role: "user", content: "Thanks" },
		];

		const raw1 = toBedrockRequest(makeInput({ messages: baseMsgs }));
		const raw2 = toBedrockRequest(makeInput({ messages: extendedMsgs }));

		const msgs1 = raw1.messages as Array<Record<string, unknown>>;
		const msgs2 = raw2.messages as Array<Record<string, unknown>>;

		const strip = (msg: Record<string, unknown>) => {
			if (!Array.isArray(msg.content)) return msg;
			return {
				...msg,
				content: (msg.content as Array<Record<string, unknown>>).filter(
					(b) => !("cachePoint" in b),
				),
			};
		};

		// Messages from turn 1 should be identical in turn 2 (minus cachePoint)
		for (let i = 0; i < msgs1.length; i++) {
			expect(stableStringify(strip(msgs1[i]))).toBe(stableStringify(strip(msgs2[i])));
		}
	});
});

// ─── 7. Debug logging utility tests ─────────────────────────────────────────

describe("cache stability: debug utilities", () => {
	it("stableStringify produces sorted keys", () => {
		const a = stableStringify({ z: 1, a: 2, m: 3 });
		const b = stableStringify({ a: 2, m: 3, z: 1 });
		expect(a).toBe(b);
	});

	it("stableStringify replaces Uint8Array with placeholder", () => {
		const result = stableStringify({ data: new Uint8Array([1, 2, 3]) });
		expect(result).toContain("<Uint8Array:3>");
		expect(result).not.toContain("[1,2,3]");
	});

	it("findCachePointIndex returns correct index", () => {
		const messages = [
			{ role: "user", content: [{ text: "hello" }] },
			{ role: "assistant", content: [{ text: "hi" }, { cachePoint: { type: "default" } }] },
			{ role: "user", content: [{ text: "bye" }] },
		];
		expect(findCachePointIndex(messages)).toBe(1);
	});

	it("findCachePointIndex returns -1 when no cachePoint", () => {
		const messages = [
			{ role: "user", content: [{ text: "hello" }] },
			{ role: "assistant", content: [{ text: "hi" }] },
		];
		expect(findCachePointIndex(messages)).toBe(-1);
	});

	it("emitCacheDebug returns structured entry with fingerprints", () => {
		const raw = toBedrockRequest(makeInput({ tools: SAMPLE_TOOLS }));
		const entry = emitCacheDebug(raw);
		expect(entry.seq).toBeGreaterThan(0);
		expect(entry.messageCount).toBe(3);
		expect(entry.cachePointIdx).toBe(1);
		expect(entry.fingerprints.system).not.toBeNull();
		expect(entry.fingerprints.prefixMessages).toHaveLength(12);
		expect(entry.fingerprints.suffixMessages).toHaveLength(12);
		expect(entry.fingerprints.toolConfig).not.toBeNull();
		expect(entry.fingerprints.full).toHaveLength(12);
	});

	it("emitCacheDebug fingerprints are stable for same input", () => {
		const raw = toBedrockRequest(makeInput());
		const a = emitCacheDebug(raw);
		const b = emitCacheDebug(raw);
		expect(a.fingerprints.system).toBe(b.fingerprints.system);
		expect(a.fingerprints.prefixMessages).toBe(b.fingerprints.prefixMessages);
		expect(a.fingerprints.suffixMessages).toBe(b.fingerprints.suffixMessages);
		expect(a.fingerprints.toolConfig).toBe(b.fingerprints.toolConfig);
		expect(a.fingerprints.full).toBe(b.fingerprints.full);
	});
});

// ─── 8. Inference config stability ──────────────────────────────────────────

describe("cache stability: inference config", () => {
	it("inference config is deterministic without thinking", () => {
		const input = makeInput({ temperature: 0.7, max_tokens: 4096 });
		const a = toBedrockRequest(input);
		const b = toBedrockRequest(input);

		expect(stableStringify(a.inferenceConfig)).toBe(stableStringify(b.inferenceConfig));
	});

	it("inference config is deterministic with thinking", () => {
		const input = makeInput({
			thinking: { type: "enabled", budget_tokens: 10000 },
		});
		const a = toBedrockRequest(input);
		const b = toBedrockRequest(input);

		expect(stableStringify(a.inferenceConfig)).toBe(stableStringify(b.inferenceConfig));
		expect(stableStringify(a.additionalModelRequestFields)).toBe(
			stableStringify(b.additionalModelRequestFields),
		);
	});

	it("changing thinking budget changes inference config", () => {
		const a = toBedrockRequest(makeInput({ thinking: { type: "enabled", budget_tokens: 10000 } }));
		const b = toBedrockRequest(makeInput({ thinking: { type: "enabled", budget_tokens: 20000 } }));

		// Different budgets should produce different configs (cache bust is expected)
		expect(stableStringify(a.additionalModelRequestFields)).not.toBe(
			stableStringify(b.additionalModelRequestFields),
		);
	});
});
