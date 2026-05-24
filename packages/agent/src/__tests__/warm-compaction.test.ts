import { describe, expect, it } from "bun:test";
import type { LLMMessage } from "@bound/llm";
import {
	compactStoredMessagesInPlace,
	hasStrippableThinking,
	stripThinkingFromToolCall,
} from "../warm-compaction";

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

	// Warm-path in-place equivalent of cold-path Stage 1.7 compaction. When
	// the warm-path budget gate fires, we compact the cached storedMessages
	// instead of clearing the cache and cold-rebuilding from scratch. This
	// preserves the byte-prefix the provider has cached, so the next turn
	// can hit cache_read at the LLM layer instead of paying for a fresh
	// cache_write.
	//
	// Cold-path Stage 1.7 operates on Message[] (DB rows with .id); the
	// warm path stores LLMMessage[] which has no .id. The stub references
	// the tool_use_id (which IS on LLMMessage) so the agent can still
	// retrieve full content via `query` against the messages table.
	describe("compactStoredMessagesInPlace", () => {
		const COLD_COMPACTION_THRESHOLD = 500;

		function makeToolResult(toolUseId: string, contentLen: number): LLMMessage {
			return {
				role: "tool_result",
				tool_use_id: toolUseId,
				content: "x".repeat(contentLen),
			};
		}

		it("truncates tool_result content older than the recent window when it exceeds the threshold", () => {
			const messages: LLMMessage[] = [
				makeToolResult("call_old", 5000),
				{ role: "user", content: "newer" },
				{ role: "assistant", content: "more" },
				{ role: "user", content: "now" },
				{ role: "assistant", content: "now" },
				{ role: "user", content: "now" },
				{ role: "assistant", content: "now" },
				{ role: "user", content: "now" },
				{ role: "assistant", content: "now" },
				{ role: "user", content: "now" },
				{ role: "assistant", content: "now" },
			];

			const result = compactStoredMessagesInPlace(messages, {
				recentWindow: 4,
				contextWindow: 200_000,
				effectiveTruncationRatio: 0.85,
			});

			expect(result.compacted).toBe(true);
			// Original tool_result mutated in place
			expect(messages[0].content.length).toBeLessThan(5000);
			// Stub MUST mention the tool_use_id so the agent can retrieve
			// full content via `query SELECT content FROM messages WHERE
			// tool_name = ?` against the messages table.
			expect(messages[0].content as string).toContain("call_old");
		});

		it("preserves tool_result after the last user message even when over threshold", () => {
			// In-flight tool_result (after the most recent user message) must NEVER
			// be stubbed in-place — that would mutate the prefix that the LLM is
			// actively reasoning over. The compaction boundary anchors to the last
			// user message index; everything past it is preserved.
			const messages: LLMMessage[] = [
				{ role: "user", content: "old" },
				{ role: "user", content: "now" },
				makeToolResult("call_recent", 5000),
			];

			compactStoredMessagesInPlace(messages, {
				recentWindow: 2,
				contextWindow: 200_000,
				effectiveTruncationRatio: 0.85,
			});

			// In-flight tool_result kept intact.
			expect(messages[2].content.length).toBe(5000);
		});

		it("does not touch tool_results below the threshold", () => {
			const messages: LLMMessage[] = [
				makeToolResult("call_small", COLD_COMPACTION_THRESHOLD - 10),
				{ role: "user", content: "x" },
				{ role: "assistant", content: "x" },
				{ role: "user", content: "x" },
				{ role: "assistant", content: "x" },
				{ role: "user", content: "x" },
			];
			const before = messages[0].content;

			compactStoredMessagesInPlace(messages, {
				recentWindow: 4,
				contextWindow: 200_000,
				effectiveTruncationRatio: 0.85,
			});

			expect(messages[0].content).toBe(before);
		});

		it("is idempotent: calling twice produces identical content (provider-cache stable)", () => {
			// The whole point of warm-path in-place compaction is that the
			// resulting byte-prefix is byte-equal to whatever the provider
			// has cached. If a second call would mutate further, we'd
			// invalidate cache on every warm turn.
			const messages: LLMMessage[] = [
				makeToolResult("call_a", 5000),
				makeToolResult("call_b", 5000),
				{ role: "user", content: "x" },
				{ role: "assistant", content: "x" },
				{ role: "user", content: "x" },
				{ role: "assistant", content: "x" },
				{ role: "user", content: "x" },
				{ role: "assistant", content: "x" },
			];

			compactStoredMessagesInPlace(messages, {
				recentWindow: 4,
				contextWindow: 200_000,
				effectiveTruncationRatio: 0.85,
			});
			const snapshot = messages.map((m) => m.content);

			compactStoredMessagesInPlace(messages, {
				recentWindow: 4,
				contextWindow: 200_000,
				effectiveTruncationRatio: 0.85,
			});

			for (let i = 0; i < messages.length; i++) {
				expect(messages[i].content).toBe(snapshot[i]);
			}
		});

		it("strips thinking from tool_call only when the post-compaction estimate exceeds the threshold", () => {
			// Same budget-driven gating as cold-path Stage 1.7. Below
			// threshold, thinking blocks are preserved (model reasoning
			// chain is informative to the agent).
			const thinkingContent = JSON.stringify([
				{ type: "thinking", thinking: "deep reasoning" },
				{ type: "tool_use", id: "call_x", name: "bash", input: {} },
			]);

			const smallMessages: LLMMessage[] = [
				{ role: "tool_call", content: thinkingContent },
				{ role: "user", content: "now" },
				{ role: "assistant", content: "now" },
				{ role: "user", content: "now" },
				{ role: "assistant", content: "now" },
			];
			compactStoredMessagesInPlace(smallMessages, {
				recentWindow: 4,
				// Massive headroom: post-compaction estimate << threshold,
				// so thinking blocks should NOT be stripped.
				contextWindow: 1_000_000,
				effectiveTruncationRatio: 0.85,
			});
			expect(hasStrippableThinking(smallMessages[0].content as string)).toBe(true);
		});

		it("strips thinking from tool_call when over budget (cold-path parity)", () => {
			// Build content large enough that the post-compaction estimate
			// is over the thinking threshold, forcing the strip.
			const thinkingPayload = "deep reasoning ".repeat(2000);
			const thinkingContent = JSON.stringify([
				{ type: "thinking", thinking: thinkingPayload },
				{ type: "tool_use", id: "call_x", name: "bash", input: {} },
			]);

			const messages: LLMMessage[] = [
				{ role: "tool_call", content: thinkingContent },
				{ role: "user", content: "now" },
				{ role: "assistant", content: "now" },
				{ role: "user", content: "now" },
				{ role: "assistant", content: "now" },
			];
			compactStoredMessagesInPlace(messages, {
				recentWindow: 4,
				// Tiny window: any thinking content trips the threshold.
				contextWindow: 1000,
				effectiveTruncationRatio: 0.5,
			});
			expect(hasStrippableThinking(messages[0].content as string)).toBe(false);
		});

		it("returns compacted=false when nothing was changed", () => {
			const messages: LLMMessage[] = [
				{ role: "user", content: "small" },
				{ role: "assistant", content: "small" },
				{ role: "user", content: "small" },
			];
			const result = compactStoredMessagesInPlace(messages, {
				recentWindow: 4,
				contextWindow: 200_000,
				effectiveTruncationRatio: 0.85,
			});
			expect(result.compacted).toBe(false);
		});

		it("does not compact tool_result without a tool_use_id (no recovery path)", () => {
			// The stub references tool_use_id so the agent can recover full
			// content. Without an id we cannot produce a useful pointer, so
			// we leave the message intact rather than creating a stub the
			// agent cannot dereference.
			const messages: LLMMessage[] = [
				{ role: "tool_result", content: "x".repeat(5000) }, // no tool_use_id
				{ role: "user", content: "x" },
				{ role: "assistant", content: "x" },
				{ role: "user", content: "x" },
				{ role: "assistant", content: "x" },
			];

			compactStoredMessagesInPlace(messages, {
				recentWindow: 4,
				contextWindow: 200_000,
				effectiveTruncationRatio: 0.85,
			});

			expect((messages[0].content as string).length).toBe(5000);
		});

		it("preserves prefix byte-stability across multiple turns within a single user message (regression: compactionBoundary used to slide forward by 2 per turn, busting prefix cache)", () => {
			// Setup: a tool-call cycle following one current user message, with an
			// older completed user/tool sequence in front. recentWindow=2 so without
			// the fix the boundary lands well past the most recent user message.
			//
			// Indices:    0           1         2          3 (LARGE)         4 (recent)        5         6          7 (LARGE)        8         9          10 (LARGE)
			// Roles:      user_old    asst      tool_call  tool_result_old   user_recent       asst      tool_call  tool_result_1    asst      tool_call  tool_result_2
			//
			// Bug: turn 1 boundary = 11 - 2 = 9. Stubs at 0..8. tool_result_old (3)
			//      and tool_result_1 (7) stubbed. tool_result_2 (10) preserved.
			//      Turn 2 appends 3 new messages (length=14). Boundary = 12.
			//      tool_result_2 (10) is NOW eligible and gets newly stubbed —
			//      byte change at index 10 → cache bust on the next API call.
			//
			// Fix: anchor compactionBoundary to lastUserIdx = 4. Stubs only at 0..3.
			//      Indices 5..10 stay intact across both calls. Bytes 0..10 remain
			//      identical between turn 1 and turn 2 → cache prefix stable.
			const initial: LLMMessage[] = [
				{ role: "user", content: "older user message" },
				{ role: "assistant", content: "older assistant" },
				{
					role: "tool_call",
					content: JSON.stringify([{ type: "tool_use", id: "tu_old", name: "foo", input: {} }]),
					tool_use_id: "tu_old",
				},
				{ role: "tool_result", content: "old".repeat(2000), tool_use_id: "tu_old" },
				{ role: "user", content: "current user message" },
				{ role: "assistant", content: "responding" },
				{
					role: "tool_call",
					content: JSON.stringify([{ type: "tool_use", id: "tu_1", name: "foo", input: {} }]),
					tool_use_id: "tu_1",
				},
				{ role: "tool_result", content: "x".repeat(2000), tool_use_id: "tu_1" },
				{ role: "assistant", content: "another step" },
				{
					role: "tool_call",
					content: JSON.stringify([{ type: "tool_use", id: "tu_2", name: "foo", input: {} }]),
					tool_use_id: "tu_2",
				},
				{ role: "tool_result", content: "y".repeat(2000), tool_use_id: "tu_2" },
			];

			const messages: LLMMessage[] = initial.map((m) => ({ ...m }));

			compactStoredMessagesInPlace(messages, {
				recentWindow: 2,
				contextWindow: 200_000,
				effectiveTruncationRatio: 0.85,
			});

			const turn1Snapshot = messages.map((m) => m.content);
			const preAppendLength = messages.length;

			// Simulate next LLM round: assistant reasons, calls a new tool, gets a
			// large tool_result. This is the typical 2-3 message append per warm turn.
			messages.push({ role: "assistant", content: "next step" });
			messages.push({
				role: "tool_call",
				content: JSON.stringify([{ type: "tool_use", id: "tu_3", name: "foo", input: {} }]),
				tool_use_id: "tu_3",
			});
			messages.push({ role: "tool_result", content: "z".repeat(2000), tool_use_id: "tu_3" });

			compactStoredMessagesInPlace(messages, {
				recentWindow: 2,
				contextWindow: 200_000,
				effectiveTruncationRatio: 0.85,
			});

			// CORE INVARIANT: every message that existed before the append must
			// have byte-identical content after the second compaction pass.
			// If this fails, the provider's prefix cache will miss on every turn.
			for (let i = 0; i < preAppendLength; i++) {
				expect(messages[i].content).toBe(turn1Snapshot[i]);
			}
		});
	});
});
