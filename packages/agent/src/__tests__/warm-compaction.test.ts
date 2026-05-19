import { describe, expect, it } from "bun:test";
import { hasStrippableThinking, stripThinkingFromToolCall } from "../warm-compaction";

describe("warm-compaction", () => {
	describe("stripThinkingFromToolCall", () => {
		it("strips thinking blocks from tool_call content", () => {
			const content = JSON.stringify([
				{ type: "thinking", thinking: "Let me analyze this problem...", signature: "abc123" },
				{ type: "tool_use", id: "call_1", name: "read_file", input: { path: "/foo.ts" } },
			]);
			const result = stripThinkingFromToolCall(content);
			const parsed = JSON.parse(result);
			expect(parsed).toHaveLength(1);
			expect(parsed[0].type).toBe("tool_use");
			expect(parsed[0].id).toBe("call_1");
		});

		it("strips redacted_thinking blocks", () => {
			const content = JSON.stringify([
				{ type: "redacted_thinking", data: "encrypted..." },
				{ type: "tool_use", id: "call_2", name: "bash", input: { command: "ls" } },
			]);
			const result = stripThinkingFromToolCall(content);
			const parsed = JSON.parse(result);
			expect(parsed).toHaveLength(1);
			expect(parsed[0].type).toBe("tool_use");
		});

		it("strips multiple thinking blocks in one message", () => {
			const content = JSON.stringify([
				{ type: "thinking", thinking: "First thought..." },
				{ type: "thinking", thinking: "Second thought..." },
				{ type: "tool_use", id: "call_3", name: "edit", input: {} },
				{ type: "text", text: "summary" },
			]);
			const result = stripThinkingFromToolCall(content);
			const parsed = JSON.parse(result);
			expect(parsed).toHaveLength(2);
			expect(parsed[0].type).toBe("tool_use");
			expect(parsed[1].type).toBe("text");
		});

		it("returns content unchanged when no thinking blocks present", () => {
			const content = JSON.stringify([
				{ type: "tool_use", id: "call_4", name: "read", input: { path: "/bar" } },
			]);
			const result = stripThinkingFromToolCall(content);
			expect(result).toBe(content);
		});

		it("is idempotent: calling on already-stripped content is a no-op", () => {
			const content = JSON.stringify([
				{ type: "thinking", thinking: "reasoning..." },
				{ type: "tool_use", id: "call_5", name: "bash", input: {} },
			]);
			const first = stripThinkingFromToolCall(content);
			const second = stripThinkingFromToolCall(first);
			expect(second).toBe(first);
		});

		it("preserves content when all blocks are thinking (no tool_use)", () => {
			const content = JSON.stringify([{ type: "thinking", thinking: "only thinking, no action" }]);
			const result = stripThinkingFromToolCall(content);
			// Should NOT strip since that would leave empty array
			expect(result).toBe(content);
		});

		it("returns non-JSON content unchanged", () => {
			const content = "This is plain text, not JSON";
			const result = stripThinkingFromToolCall(content);
			expect(result).toBe(content);
		});

		it("returns non-array JSON unchanged", () => {
			const content = JSON.stringify({ type: "tool_use", id: "x" });
			const result = stripThinkingFromToolCall(content);
			expect(result).toBe(content);
		});

		it("returns empty array unchanged", () => {
			const content = "[]";
			const result = stripThinkingFromToolCall(content);
			expect(result).toBe(content);
		});

		it("handles mixed thinking and text blocks alongside tool_use", () => {
			const content = JSON.stringify([
				{ type: "thinking", thinking: "deep analysis of the scheduler" },
				{ type: "text", text: "I'll fix the stacked wakeup issue" },
				{ type: "tool_use", id: "call_6", name: "edit", input: { file: "scheduler.ts" } },
			]);
			const result = stripThinkingFromToolCall(content);
			const parsed = JSON.parse(result);
			expect(parsed).toHaveLength(2);
			expect(parsed[0].type).toBe("text");
			expect(parsed[1].type).toBe("tool_use");
		});
	});

	describe("hasStrippableThinking", () => {
		it("returns true for content with thinking blocks", () => {
			const content = JSON.stringify([
				{ type: "thinking", thinking: "reasoning" },
				{ type: "tool_use", id: "x", name: "y", input: {} },
			]);
			expect(hasStrippableThinking(content)).toBe(true);
		});

		it("returns false for content without thinking keyword", () => {
			const content = JSON.stringify([{ type: "tool_use", id: "x", name: "y", input: {} }]);
			expect(hasStrippableThinking(content)).toBe(false);
		});

		it("returns false for empty content", () => {
			expect(hasStrippableThinking("")).toBe(false);
		});

		it("returns false when thinking appears only inside escaped string values", () => {
			// JSON.stringify escapes inner quotes, so "thinking" as a value
			// becomes \"thinking\" which doesn't match the literal "thinking"
			// (with unescaped quotes) that appears as a type field.
			const content = JSON.stringify([
				{ type: "tool_use", id: "x", name: "y", input: { note: 'user said "thinking"' } },
			]);
			expect(hasStrippableThinking(content)).toBe(false);
		});

		it("returns true for redacted_thinking type", () => {
			const content = JSON.stringify([
				{ type: "redacted_thinking", data: "encrypted" },
				{ type: "tool_use", id: "x", name: "y", input: {} },
			]);
			expect(hasStrippableThinking(content)).toBe(true);
		});
	});
});
