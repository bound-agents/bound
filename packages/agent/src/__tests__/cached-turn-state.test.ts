import { describe, expect, it } from "bun:test";
import type { ToolDefinition } from "@bound/llm";
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
