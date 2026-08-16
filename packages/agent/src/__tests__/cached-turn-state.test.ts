import { describe, expect, it } from "bun:test";
import { InMemoryTurnStateStore } from "@bound/core";
import type { LLMMessage, ToolDefinition } from "@bound/llm";
import fc from "fast-check";
import { type CachedTurnState, computeToolFingerprint } from "../cached-turn-state";

describe("computeToolFingerprint", () => {
	it("returns 'empty' for undefined tools", () => {
		expect(computeToolFingerprint(undefined)).toBe("empty");
	});

	it("returns 'empty' for empty tools array", () => {
		expect(computeToolFingerprint([])).toBe("empty");
	});

	it("is deterministic and independent of distinct-name tool order", () => {
		const jsonValue = fc.letrec((tie) => ({
			value: fc.oneof(
				fc.string(),
				fc.boolean(),
				fc.integer(),
				fc.constant(null),
				fc.array(tie("value"), { maxLength: 3 }),
				fc.dictionary(fc.string(), tie("value"), { maxKeys: 3 }),
			),
		})).value;
		const tools = fc
			.uniqueArray(
				fc.record({
					name: fc.string({ minLength: 1, maxLength: 24 }),
					description: fc.string({ maxLength: 80 }),
					parameters: jsonValue,
				}),
				{ minLength: 1, selector: (tool) => tool.name, maxLength: 8 },
			)
			.map((values) =>
				values.map(
					({ name, description, parameters }): ToolDefinition => ({
						function: { name, description, parameters },
					}),
				),
			);

		fc.assert(
			fc.property(tools, (toolDefinitions) => {
				const fingerprint = computeToolFingerprint(toolDefinitions);
				expect(fingerprint).toMatch(/^[a-f0-9]{16}$/);
				expect(computeToolFingerprint(toolDefinitions)).toBe(fingerprint);
				expect(computeToolFingerprint([...toolDefinitions].reverse())).toBe(fingerprint);
			}),
		);
	});

	it("preserves duplicate-name ordering and identity in the fingerprint", () => {
		const alpha: ToolDefinition = {
			function: { name: "duplicate", description: "", parameters: { type: "string" } },
		};
		const beta: ToolDefinition = {
			function: { name: "duplicate", description: "", parameters: { type: "number" } },
		};

		expect(computeToolFingerprint([alpha, beta])).not.toBe(computeToolFingerprint([beta, alpha]));
		expect(computeToolFingerprint([alpha])).not.toBe(computeToolFingerprint([alpha, alpha]));
	});

	it("changes when the tool set or canonical parameter schema changes", () => {
		const base: ToolDefinition[] = [
			{
				function: {
					name: "tool_a",
					description: "Tool A",
					parameters: { type: "object", properties: { x: { type: "string" } } },
				},
			},
		];
		const baseFingerprint = computeToolFingerprint(base);
		expect(
			computeToolFingerprint([
				...base,
				{ function: { name: "tool_b", description: "Tool B", parameters: { type: "object" } } },
			]),
		).not.toBe(baseFingerprint);
		expect(
			computeToolFingerprint([
				{
					function: {
						...base[0].function,
						parameters: { type: "object", properties: { y: { type: "number" } } },
					},
				},
			]),
		).not.toBe(baseFingerprint);
	});

	it("canonicalizes parameter object-key order without changing array order", () => {
		const sameSchemaDifferentInsertionOrder: ToolDefinition[] = [
			{
				function: {
					name: "tool_a",
					description: "ignored by the fingerprint",
					parameters: {
						properties: { b: { type: "number" }, a: { type: "string" } },
						type: "object",
					},
				},
			},
		];
		const schema: ToolDefinition[] = [
			{
				function: {
					name: "tool_a",
					description: "ignored by the fingerprint",
					parameters: {
						type: "object",
						properties: { a: { type: "string" }, b: { type: "number" } },
					},
				},
			},
		];
		expect(computeToolFingerprint(sameSchemaDifferentInsertionOrder)).toBe(
			computeToolFingerprint(schema),
		);

		const orderedEnum = [
			{ function: { name: "tool_a", description: "", parameters: { enum: ["a", "b"] } } },
		];
		const reversedEnum = [
			{ function: { name: "tool_a", description: "", parameters: { enum: ["b", "a"] } } },
		];
		expect(computeToolFingerprint(orderedEnum)).not.toBe(computeToolFingerprint(reversedEnum));
	});
});

describe("CachedTurnState interface", () => {
	it("is a valid type for storing cached state", () => {
		const state: CachedTurnState = {
			messages: [],
			systemPrompt: "You are a helpful assistant",
			cacheMessagePositions: [],
			fixedCacheIdx: -1,
			lastMessageCreatedAt: "2026-04-23T10:00:00Z",
			toolFingerprint: "abc123def456",
		};

		expect(state.messages).toEqual([]);
		expect(state.systemPrompt).toBe("You are a helpful assistant");
		expect(state.cacheMessagePositions).toEqual([]);
		expect(state.fixedCacheIdx).toBe(-1);
		expect(state.lastMessageCreatedAt).toBe("2026-04-23T10:00:00Z");
		expect(state.toolFingerprint).toBe("abc123def456");
	});
});

// ---------------------------------------------------------------------------
// Warm-path shared-reference aliasing (regression for thread 0ab688b2)
// ---------------------------------------------------------------------------
//
// The warm path in agent-loop.ts does:
//
//   const storedMessages = [...cached.messages];  // shallow copy of stored
//   storedMessages.push(...deltaMessages);        // append delta
//   // ...
//   this.setCachedTurnState({
//       ...cached,
//       messages: [...storedMessages],  // spread-copy into the cache
//       ...
//   });
//   llmMessages = storedMessages;       // caller keeps its own reference
//
// Then later (in the turn's tool_call persist path):
//
//   llmMessages.push({ role: "tool_call", content: toolCallBlocks });
//
// The previous version handed `storedMessages` to the store WITHOUT copying,
// so loop-body mutations leaked into cached state and the NEXT warm
// iteration saw a tail that already contained the assistant's tool_call.
// That duplication produced the observed Bedrock `tool_use_id_mismatch`
// (assistant msg 3 with doubled reasoning + tool_use blocks).
//
// These tests pin the pattern: when the caller spread-copies into the store,
// subsequent mutations of the caller's reference stay invisible to
// `store.get()`.

function mkMsg(role: LLMMessage["role"], content: string): LLMMessage {
	return { role, content };
}

describe("TurnStateStore isolation from caller mutation", () => {
	it("cached messages are unaffected when the caller mutates its own reference after spread-copying", () => {
		const store = new InMemoryTurnStateStore<CachedTurnState>();
		const threadId = "thread-parallel-tools";

		// Simulate the warm-path pattern in agent-loop.ts:
		const storedMessages: LLMMessage[] = [mkMsg("user", "hi"), mkMsg("assistant", "hello!")];

		// `setCachedTurnState({ ..., messages: [...storedMessages] })` — the
		// spread-copy is the fix for the aliasing bug.
		store.set(threadId, {
			messages: [...storedMessages],
			systemPrompt: "sys",
			cacheMessagePositions: [],
			fixedCacheIdx: -1,
			lastMessageCreatedAt: "2026-04-23T10:00:00Z",
			toolFingerprint: "fp",
		});

		// Then inside the loop body: `llmMessages = storedMessages;
		// llmMessages.push(tool_call)`.
		storedMessages.push(
			mkMsg("tool_call", JSON.stringify([{ type: "tool_use", id: "tu_A", name: "f", input: {} }])),
		);

		// On the next turn's warm path the loop fetches cached.messages — it
		// MUST NOT see the appended tool_call, because that block was already
		// written to the DB and will arrive via convertDeltaMessages on top of
		// the stored tail. Otherwise we get duplicated tool_use blocks in the
		// assistant message the driver builds.
		const retrieved = store.get(threadId);
		expect(retrieved).toBeDefined();
		expect(retrieved?.messages).toHaveLength(2);
		expect(retrieved?.messages.map((m) => m.role)).toEqual(["user", "assistant"]);
	});

	it("demonstrates why spread-copy matters: without it, caller mutations leak into the cache", () => {
		// Negative control: pins the ORIGINAL buggy behavior. If someone ever
		// reverts the spread-copy in agent-loop.ts, this test stays green but
		// the positive test above will fail — the pair together documents the
		// contract the call site must honor.
		const store = new InMemoryTurnStateStore<CachedTurnState>();
		const threadId = "thread-alias-demo";

		const storedMessages: LLMMessage[] = [mkMsg("user", "hi"), mkMsg("assistant", "hello!")];

		// Hand the array reference directly — no spread-copy.
		store.set(threadId, {
			messages: storedMessages,
			systemPrompt: "sys",
			cacheMessagePositions: [],
			fixedCacheIdx: -1,
			lastMessageCreatedAt: "2026-04-23T10:00:00Z",
			toolFingerprint: "fp",
		});

		storedMessages.push(
			mkMsg("tool_call", JSON.stringify([{ type: "tool_use", id: "tu_A", name: "f", input: {} }])),
		);

		// Caller's mutation leaked — this is exactly the bug condition.
		const retrieved = store.get(threadId);
		expect(retrieved?.messages).toHaveLength(3);
	});
});
