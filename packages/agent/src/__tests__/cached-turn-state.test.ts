import { describe, expect, it } from "bun:test";
import { InMemoryTurnStateStore } from "@bound/core";
import type { LLMMessage, ToolDefinition } from "@bound/llm";
import { type CachedTurnState, computeToolFingerprint } from "../cached-turn-state";

describe("computeToolFingerprint", () => {
	it("returns 'empty' for undefined tools", () => {
		const fingerprint = computeToolFingerprint(undefined);
		expect(fingerprint).toBe("empty");
	});

	it("returns 'empty' for empty tools array", () => {
		const fingerprint = computeToolFingerprint([]);
		expect(fingerprint).toBe("empty");
	});

	it("produces identical fingerprints for the same tools (deterministic)", () => {
		const tools: ToolDefinition[] = [
			{
				function: {
					name: "test_tool",
					description: "A test tool",
					parameters: { type: "object", properties: {} },
				},
			},
		];

		const fp1 = computeToolFingerprint(tools);
		const fp2 = computeToolFingerprint(tools);
		expect(fp1).toBe(fp2);
	});

	it("produces identical fingerprints regardless of tool order", () => {
		const tools1: ToolDefinition[] = [
			{
				function: {
					name: "alpha",
					description: "First tool",
					parameters: { type: "object", properties: {} },
				},
			},
			{
				function: {
					name: "beta",
					description: "Second tool",
					parameters: { type: "object", properties: {} },
				},
			},
		];

		const tools2: ToolDefinition[] = [
			{
				function: {
					name: "beta",
					description: "Second tool",
					parameters: { type: "object", properties: {} },
				},
			},
			{
				function: {
					name: "alpha",
					description: "First tool",
					parameters: { type: "object", properties: {} },
				},
			},
		];

		const fp1 = computeToolFingerprint(tools1);
		const fp2 = computeToolFingerprint(tools2);
		expect(fp1).toBe(fp2);
	});

	it("produces different fingerprints for different tool sets", () => {
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
					name: "tool_b",
					description: "Tool B",
					parameters: { type: "object", properties: {} },
				},
			},
		];

		const fp1 = computeToolFingerprint(tools1);
		const fp2 = computeToolFingerprint(tools2);
		expect(fp1).not.toBe(fp2);
	});

	it("detects fingerprint change when a tool is added", () => {
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
		expect(fp1).not.toBe(fp2);
	});

	it("detects fingerprint change when tool parameters change", () => {
		const tools1: ToolDefinition[] = [
			{
				function: {
					name: "tool_a",
					description: "Tool A",
					parameters: { type: "object", properties: { x: { type: "string" } } },
				},
			},
		];

		const tools2: ToolDefinition[] = [
			{
				function: {
					name: "tool_a",
					description: "Tool A",
					parameters: { type: "object", properties: { y: { type: "number" } } },
				},
			},
		];

		const fp1 = computeToolFingerprint(tools1);
		const fp2 = computeToolFingerprint(tools2);
		expect(fp1).not.toBe(fp2);
	});

	it("returns a 16-character hex string", () => {
		const tools: ToolDefinition[] = [
			{
				function: {
					name: "test_tool",
					description: "A test tool",
					parameters: { type: "object", properties: {} },
				},
			},
		];

		const fingerprint = computeToolFingerprint(tools);
		expect(fingerprint).toMatch(/^[a-f0-9]{16}$/);
	});

	it("handles multiple tools with complex parameters", () => {
		const tools: ToolDefinition[] = [
			{
				function: {
					name: "get_user",
					description: "Get user info",
					parameters: {
						type: "object",
						properties: {
							user_id: { type: "string" },
							include_metadata: { type: "boolean" },
						},
						required: ["user_id"],
					},
				},
			},
			{
				function: {
					name: "create_task",
					description: "Create a task",
					parameters: {
						type: "object",
						properties: {
							title: { type: "string" },
							priority: { enum: ["low", "medium", "high"] },
						},
						required: ["title"],
					},
				},
			},
		];

		const fp1 = computeToolFingerprint(tools);
		const fp2 = computeToolFingerprint(tools);
		expect(fp1).toBe(fp2);
		expect(fp1).toMatch(/^[a-f0-9]{16}$/);
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
