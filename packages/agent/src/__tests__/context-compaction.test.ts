import { describe, expect, it } from "bun:test";
import type { LLMMessage } from "@bound/llm";
import { compactMessages } from "../context-compaction";

/**
 * Helper to build a minimal message sequence: user → tool_call → tool_result → assistant.
 * Content is padded to the given length to simulate large tool results.
 */
function buildTurnMessages(
	turnIndex: number,
	toolResultLength: number,
): Array<LLMMessage & { _messageId?: string }> {
	const toolId = `tool_${turnIndex}`;
	return [
		{ role: "user", content: `User message ${turnIndex}` },
		{
			role: "tool_call",
			content: JSON.stringify([
				{ type: "tool_use", id: toolId, name: "bash", input: { command: "echo hi" } },
			]),
		},
		{
			role: "tool_result",
			content: "x".repeat(toolResultLength),
			tool_use_id: toolId,
			_messageId: `msg-result-${turnIndex}`,
		},
		{ role: "assistant", content: `Assistant response ${turnIndex}` },
	];
}

describe("Context Compaction", () => {
	describe("compactMessages", () => {
		it("keeps all messages when total count is within recent window", () => {
			const messages = buildTurnMessages(1, 100);
			const result = compactMessages(messages, null, 20);
			// All 4 messages kept as-is
			expect(result.length).toBe(4);
			expect(result[2].content).toBe("x".repeat(100));
		});

		it("replaces old tool results with DB retrieval pointers", () => {
			// Build 5 turns of messages (20 msgs total)
			const messages = [
				...buildTurnMessages(1, 5000),
				...buildTurnMessages(2, 5000),
				...buildTurnMessages(3, 5000),
				...buildTurnMessages(4, 100),
				...buildTurnMessages(5, 100),
			];

			// Keep last 8 messages (2 turns), compact the rest
			const result = compactMessages(messages, null, 8);

			// Old tool results (turns 1-3) should be compacted
			const oldToolResult1 = result[2]; // turn 1 tool_result
			expect(oldToolResult1.content).toContain("[Result truncated");
			expect(oldToolResult1.content).toContain("msg-result-1");
			expect((oldToolResult1.content as string).length).toBeLessThan(1000);

			// Recent tool results (turns 4-5) should be intact
			const recentToolResult4 = result[14]; // turn 4 tool_result
			expect(recentToolResult4.content).toBe("x".repeat(100));
		});

		it("injects thread summary as system message when provided", () => {
			const messages = [
				...buildTurnMessages(1, 5000),
				...buildTurnMessages(2, 5000),
				...buildTurnMessages(3, 100),
			];

			const summary = "We discussed TypeScript patterns and debugging strategies.";
			const result = compactMessages(messages, summary, 4);

			// First message should be the summary injection
			expect(result[0].role).toBe("system");
			expect(result[0].content).toContain(summary);
			expect(result[0].content).toContain("compacted");
		});

		it("does not inject summary when null", () => {
			const messages = [
				...buildTurnMessages(1, 5000),
				...buildTurnMessages(2, 100),
			];

			const result = compactMessages(messages, null, 4);

			// No system summary injected
			expect(result[0].role).toBe("user");
		});

		it("preserves tool_use_id on compacted tool results", () => {
			const messages = [
				...buildTurnMessages(1, 10000),
				...buildTurnMessages(2, 100),
			];

			const result = compactMessages(messages, null, 4);

			const compactedResult = result[2]; // turn 1 tool_result
			expect(compactedResult.tool_use_id).toBe("tool_1");
		});

		it("only compacts tool results above the size threshold", () => {
			const messages = [
				{ role: "user" as const, content: "hi" },
				{
					role: "tool_call" as const,
					content: JSON.stringify([{ type: "tool_use", id: "t1", name: "query", input: {} }]),
				},
				{
					role: "tool_result" as const,
					content: "short result",
					tool_use_id: "t1",
					_messageId: "msg-short",
				},
				{ role: "assistant" as const, content: "ok" },
				...buildTurnMessages(2, 100),
			];

			const result = compactMessages(messages, null, 4);

			// Short tool result should NOT be compacted even though it's old
			expect(result[2].content).toBe("short result");
		});

		it("includes a content preview in the compaction marker", () => {
			const longContent = "GitHub Actions workflow status report: " + "data".repeat(2000);
			const messages: Array<LLMMessage & { _messageId?: string }> = [
				{ role: "user", content: "check workflows" },
				{
					role: "tool_call",
					content: JSON.stringify([
						{ type: "tool_use", id: "t1", name: "bash", input: {} },
					]),
				},
				{
					role: "tool_result",
					content: longContent,
					tool_use_id: "t1",
					_messageId: "msg-workflow",
				},
				{ role: "assistant", content: "done" },
				...buildTurnMessages(2, 100),
			];

			const result = compactMessages(messages, null, 4);

			const compacted = result[2].content as string;
			expect(compacted).toContain("GitHub Actions workflow");
			expect(compacted).toContain("msg-workflow");
		});
	});
});
