/**
 * Unit tests for the tool-cycle folding compressor.
 *
 * Tests property contracts (F1-F6) and edge cases enumerated in the module docs.
 */

import { describe, expect, it } from "bun:test";
import type { LLMMessage } from "@bound/llm";
import { MAX_FOLDED_LINE_CHARS, foldMessages } from "../tool-cycle-fold.ts";

// ---------------------------------------------------------------------------
// Property F1: Coverage
// Every message in the input range is accounted for in the sum of sourceCount
// across all returned FoldedLines (excluding filtered developer/system which
// produce no output lines but still consume source messages internally).
// ---------------------------------------------------------------------------

describe("foldMessages — F1: Coverage", () => {
	it("accounts for all user + assistant messages in sourceCount sum", () => {
		const messages: LLMMessage[] = [
			{ role: "user", content: "Hello" },
			{ role: "assistant", content: "Hi there" },
			{ role: "user", content: "How are you?" },
		];

		const result = foldMessages(messages, 0, messages.length);

		expect(result).toHaveLength(3);
		const totalSourceCount = result.reduce((sum, line) => sum + line.sourceCount, 0);
		expect(totalSourceCount).toBe(3);
	});

	it("accounts for tool_call + tool_result pair in sourceCount", () => {
		const messages: LLMMessage[] = [
			{
				role: "tool_call",
				content: [
					{
						type: "tool_use",
						id: "toolu_01",
						name: "bash",
						input: { command: "git status" },
					},
				],
			},
			{
				role: "tool_result",
				tool_use_id: "toolu_01",
				content: "Exit code: 0\nstdout:\nOn branch main",
			},
		];

		const result = foldMessages(messages, 0, messages.length);

		expect(result).toHaveLength(1);
		expect(result[0].sourceCount).toBe(2); // tool_call + tool_result
	});

	it("skips developer messages — they produce no output lines", () => {
		const messages: LLMMessage[] = [
			{ role: "user", content: "Hello" },
			{ role: "developer", content: "internal context" },
			{ role: "assistant", content: "Hi" },
		];

		const result = foldMessages(messages, 0, messages.length);

		// Developer message is filtered out. Only user + assistant produce lines.
		expect(result).toHaveLength(2);
		// sourceCount accounts for user(1) and assistant(1); developer is skipped entirely.
		const totalSourceCount = result.reduce((sum, line) => sum + line.sourceCount, 0);
		expect(totalSourceCount).toBe(2);
	});

	it("skips system and cache messages similarly to developer", () => {
		const messages: LLMMessage[] = [
			{ role: "system", content: "system prompt" },
			{ role: "user", content: "Hello" },
			{ role: "cache", content: "" },
			{ role: "assistant", content: "Hi" },
		];

		const result = foldMessages(messages, 0, messages.length);

		// Only user + assistant produce visible lines.
		expect(result).toHaveLength(2);
		const totalSourceCount = result.reduce((sum, line) => sum + line.sourceCount, 0);
		expect(totalSourceCount).toBe(2);
	});
});

// ---------------------------------------------------------------------------
// Property F2: Tool-pair grouping
// A tool_call at index i followed by tool_result at i+1 produces a single
// folded line with sourceCount covering both. Multi-tool turns produce
// multiple lines but the first line holds the sourceCount for the group.
// ---------------------------------------------------------------------------

describe("foldMessages — F2: Tool-pair grouping", () => {
	it("groups tool_call with single tool_result into one line", () => {
		const messages: LLMMessage[] = [
			{
				role: "tool_call",
				content: [
					{
						type: "tool_use",
						id: "toolu_01",
						name: "bash",
						input: { command: "ls" },
					},
				],
			},
			{ role: "tool_result", tool_use_id: "toolu_01", content: "file1.txt\nfile2.txt" },
		];

		const result = foldMessages(messages, 0, messages.length);

		expect(result).toHaveLength(1);
		expect(result[0].text).toMatch(/\[tool\] bash/);
		expect(result[0].sourceCount).toBe(2);
	});

	it("groups tool_call with multiple tool_results into multiple lines", () => {
		const messages: LLMMessage[] = [
			{
				role: "tool_call",
				content: [
					{
						type: "tool_use",
						id: "toolu_01",
						name: "bash",
						input: { command: "ls" },
					},
					{
						type: "tool_use",
						id: "toolu_02",
						name: "read",
						input: { file_path: "/foo/bar.txt" },
					},
				],
			},
			{ role: "tool_result", tool_use_id: "toolu_01", content: "file1.txt" },
			{ role: "tool_result", tool_use_id: "toolu_02", content: "Hello world" },
		];

		const result = foldMessages(messages, 0, messages.length);

		expect(result).toHaveLength(2);
		// First line holds the group sourceCount.
		expect(result[0].sourceCount).toBe(3); // tool_call + 2 tool_results
		expect(result[1].sourceCount).toBe(0);
	});

	it("handles tool_call with thinking block + tool_use block", () => {
		const messages: LLMMessage[] = [
			{
				role: "tool_call",
				content: [
					{ type: "thinking", thinking: "Let me check the status" },
					{
						type: "tool_use",
						id: "toolu_01",
						name: "bash",
						input: { command: "git status" },
					},
				],
			},
			{ role: "tool_result", tool_use_id: "toolu_01", content: "Exit code: 0" },
		];

		const result = foldMessages(messages, 0, messages.length);

		expect(result).toHaveLength(1);
		expect(result[0].text).toMatch(/\[tool\] bash/);
		expect(result[0].sourceCount).toBe(2);
	});

	it("pairs tool_uses with tool_results in order when counts match", () => {
		const messages: LLMMessage[] = [
			{
				role: "tool_call",
				content: [
					{
						type: "tool_use",
						id: "toolu_01",
						name: "bash",
						input: { command: "pwd" },
					},
					{
						type: "tool_use",
						id: "toolu_02",
						name: "read",
						input: { file_path: "/tmp/test.txt" },
					},
				],
			},
			{ role: "tool_result", tool_use_id: "toolu_01", content: "/home/user" },
			{ role: "tool_result", tool_use_id: "toolu_02", content: "test content" },
		];

		const result = foldMessages(messages, 0, messages.length);

		expect(result).toHaveLength(2);
		expect(result[0].text).toMatch(/bash\(pwd\)/);
		expect(result[1].text).toMatch(/read\(/);
	});
});

// ---------------------------------------------------------------------------
// Property F3: User message preservation
// User message text appears in the folded output line (prefixed with [user]).
// ---------------------------------------------------------------------------

describe("foldMessages — F3: User message preservation", () => {
	it("preserves user message text verbatim (when under limit)", () => {
		const messages: LLMMessage[] = [{ role: "user", content: "What is the weather today?" }];

		const result = foldMessages(messages, 0, messages.length);

		expect(result).toHaveLength(1);
		expect(result[0].text).toBe("[user] What is the weather today?");
	});

	it("clamps very long user message to MAX_FOLDED_LINE_CHARS", () => {
		const longContent = "a".repeat(400);
		const messages: LLMMessage[] = [{ role: "user", content: longContent }];

		const result = foldMessages(messages, 0, messages.length);

		expect(result).toHaveLength(1);
		expect(result[0].text.length).toBeLessThanOrEqual(MAX_FOLDED_LINE_CHARS);
		expect(result[0].text).toMatch(/^\[user\] a+\.\.\.$/);
	});

	it("preserves user message with ContentBlock[] containing text", () => {
		const messages: LLMMessage[] = [
			{
				role: "user",
				content: [{ type: "text", text: "Can you help me with this?" }],
			},
		];

		const result = foldMessages(messages, 0, messages.length);

		expect(result).toHaveLength(1);
		expect(result[0].text).toBe("[user] Can you help me with this?");
	});

	it("handles user message with mixed ContentBlock[] (text + image)", () => {
		const messages: LLMMessage[] = [
			{
				role: "user",
				content: [
					{ type: "text", text: "Check this screenshot:" },
					{ type: "image", source: { type: "base64", media_type: "image/png", data: "..." } },
				],
			},
		];

		const result = foldMessages(messages, 0, messages.length);

		expect(result).toHaveLength(1);
		expect(result[0].text).toBe("[user] Check this screenshot:");
	});
});

// ---------------------------------------------------------------------------
// Property F4: Line length bound
// No returned FoldedLine.text exceeds MAX_FOLDED_LINE_CHARS (300).
// ---------------------------------------------------------------------------

describe("foldMessages — F4: Line length bound", () => {
	it("clamps user message at 300 chars", () => {
		const longContent = "x".repeat(500);
		const messages: LLMMessage[] = [{ role: "user", content: longContent }];

		const result = foldMessages(messages, 0, messages.length);

		expect(result[0].text.length).toBeLessThanOrEqual(MAX_FOLDED_LINE_CHARS);
	});

	it("clamps assistant message at 300 chars", () => {
		const longContent = "y".repeat(500);
		const messages: LLMMessage[] = [{ role: "assistant", content: longContent }];

		const result = foldMessages(messages, 0, messages.length);

		expect(result[0].text.length).toBeLessThanOrEqual(MAX_FOLDED_LINE_CHARS);
	});

	it("clamps tool result summary at 300 chars", () => {
		const longResult = "z".repeat(500);
		const messages: LLMMessage[] = [
			{
				role: "tool_call",
				content: [
					{
						type: "tool_use",
						id: "toolu_01",
						name: "bash",
						input: { command: "cat /dev/urandom" },
					},
				],
			},
			{ role: "tool_result", tool_use_id: "toolu_01", content: longResult },
		];

		const result = foldMessages(messages, 0, messages.length);

		expect(result[0].text.length).toBeLessThanOrEqual(MAX_FOLDED_LINE_CHARS);
	});

	it("ensures all lines in multi-tool turn respect limit", () => {
		const longResult1 = "a".repeat(400);
		const longResult2 = "b".repeat(400);
		const messages: LLMMessage[] = [
			{
				role: "tool_call",
				content: [
					{
						type: "tool_use",
						id: "toolu_01",
						name: "bash",
						input: { command: "cmd1" },
					},
					{
						type: "tool_use",
						id: "toolu_02",
						name: "bash",
						input: { command: "cmd2" },
					},
				],
			},
			{ role: "tool_result", tool_use_id: "toolu_01", content: longResult1 },
			{ role: "tool_result", tool_use_id: "toolu_02", content: longResult2 },
		];

		const result = foldMessages(messages, 0, messages.length);

		for (const line of result) {
			expect(line.text.length).toBeLessThanOrEqual(MAX_FOLDED_LINE_CHARS);
		}
	});
});

// ---------------------------------------------------------------------------
// Property F5: Determinism
// Same input always produces same output.
// ---------------------------------------------------------------------------

describe("foldMessages — F5: Determinism", () => {
	it("produces identical output for repeated calls", () => {
		const messages: LLMMessage[] = [
			{ role: "user", content: "Hello" },
			{
				role: "tool_call",
				content: [
					{
						type: "tool_use",
						id: "toolu_01",
						name: "bash",
						input: { command: "echo test" },
					},
				],
			},
			{ role: "tool_result", tool_use_id: "toolu_01", content: "Exit code: 0\ntest" },
			{ role: "assistant", content: "Done" },
		];

		const result1 = foldMessages(messages, 0, messages.length);
		const result2 = foldMessages(messages, 0, messages.length);
		const result3 = foldMessages(messages, 0, messages.length);

		expect(result1).toEqual(result2);
		expect(result2).toEqual(result3);
	});
});

// ---------------------------------------------------------------------------
// Property F6: Graceful empty
// Empty range (startIndex >= endIndex, or empty messages array) returns empty array.
// ---------------------------------------------------------------------------

describe("foldMessages — F6: Graceful empty", () => {
	it("returns empty array for empty messages array", () => {
		const result = foldMessages([], 0, 0);
		expect(result).toEqual([]);
	});

	it("returns empty array when startIndex >= endIndex", () => {
		const messages: LLMMessage[] = [{ role: "user", content: "Hello" }];

		const result = foldMessages(messages, 0, 0);
		expect(result).toEqual([]);
	});

	it("returns empty array when startIndex > endIndex", () => {
		const messages: LLMMessage[] = [{ role: "user", content: "Hello" }];

		const result = foldMessages(messages, 5, 3);
		expect(result).toEqual([]);
	});

	it("returns empty array when startIndex >= messages.length", () => {
		const messages: LLMMessage[] = [{ role: "user", content: "Hello" }];

		const result = foldMessages(messages, 10, 20);
		expect(result).toEqual([]);
	});

	it("handles endIndex beyond messages.length gracefully", () => {
		const messages: LLMMessage[] = [{ role: "user", content: "Hello" }];

		const result = foldMessages(messages, 0, 100);
		expect(result).toHaveLength(1);
		expect(result[0].text).toBe("[user] Hello");
	});
});

// ---------------------------------------------------------------------------
// Edge Cases
// ---------------------------------------------------------------------------

describe("foldMessages — Edge Cases", () => {
	it("handles orphan tool_call (no subsequent tool_result)", () => {
		const messages: LLMMessage[] = [
			{
				role: "tool_call",
				content: [
					{
						type: "tool_use",
						id: "toolu_01",
						name: "bash",
						input: { command: "ls" },
					},
				],
			},
			{ role: "user", content: "Never mind" },
		];

		const result = foldMessages(messages, 0, messages.length);

		expect(result).toHaveLength(2);
		expect(result[0].text).toMatch(/bash\(ls\) → \(no result\)/);
		expect(result[0].sourceCount).toBe(1); // Only the tool_call
	});

	it("handles orphan tool_result (no preceding tool_call in range)", () => {
		const messages: LLMMessage[] = [
			{ role: "user", content: "Hello" },
			{ role: "tool_result", tool_use_id: "toolu_01", content: "Exit code: 0" },
		];

		const result = foldMessages(messages, 0, messages.length);

		expect(result).toHaveLength(2);
		expect(result[1].text).toMatch(/\[tool result\] exit 0/);
		expect(result[1].sourceCount).toBe(1);
	});

	it("handles multi-tool-use turn (one tool_call, multiple tool_results)", () => {
		const messages: LLMMessage[] = [
			{
				role: "tool_call",
				content: [
					{
						type: "tool_use",
						id: "toolu_01",
						name: "bash",
						input: { command: "pwd" },
					},
					{
						type: "tool_use",
						id: "toolu_02",
						name: "bash",
						input: { command: "whoami" },
					},
				],
			},
			{ role: "tool_result", tool_use_id: "toolu_01", content: "/home/user" },
			{ role: "tool_result", tool_use_id: "toolu_02", content: "user" },
		];

		const result = foldMessages(messages, 0, messages.length);

		expect(result).toHaveLength(2);
		expect(result[0].sourceCount).toBe(3); // tool_call + 2 results
		expect(result[1].sourceCount).toBe(0);
	});

	it("handles assistant message with ContentBlock[] containing text + thinking", () => {
		const messages: LLMMessage[] = [
			{
				role: "assistant",
				content: [
					{ type: "thinking", thinking: "Let me consider this carefully" },
					{ type: "text", text: "Here is my answer" },
				],
			},
		];

		const result = foldMessages(messages, 0, messages.length);

		expect(result).toHaveLength(1);
		expect(result[0].text).toBe("[assistant] Here is my answer");
	});

	it("handles tool result starting with Stage 1.7 stub marker", () => {
		const messages: LLMMessage[] = [
			{
				role: "tool_call",
				content: [
					{
						type: "tool_use",
						id: "toolu_01",
						name: "bash",
						input: { command: "cat large.log" },
					},
				],
			},
			{
				role: "tool_result",
				tool_use_id: "toolu_01",
				content:
					"[Tool result truncated for inline display; original content: 4096 bytes; run: query SELECT content FROM messages WHERE id='abc123']\nFirst line of log\nSecond line of log",
			},
		];

		const result = foldMessages(messages, 0, messages.length);

		expect(result).toHaveLength(1);
		expect(result[0].text).toMatch(/First line of log/);
		expect(result[0].text).not.toMatch(/\[Tool result truncated/);
	});

	it("handles tool result containing 'Exit code: 0' pattern", () => {
		const messages: LLMMessage[] = [
			{
				role: "tool_call",
				content: [
					{
						type: "tool_use",
						id: "toolu_01",
						name: "bash",
						input: { command: "echo hello" },
					},
				],
			},
			{
				role: "tool_result",
				tool_use_id: "toolu_01",
				content: "Exit code: 0\nstdout:\nhello",
			},
		];

		const result = foldMessages(messages, 0, messages.length);

		expect(result).toHaveLength(1);
		expect(result[0].text).toMatch(/exit 0/);
	});

	it("handles tool result containing 'Edited' success marker", () => {
		const messages: LLMMessage[] = [
			{
				role: "tool_call",
				content: [
					{
						type: "tool_use",
						id: "toolu_01",
						name: "edit",
						input: { file_path: "/foo.txt", old_string: "a", new_string: "b" },
					},
				],
			},
			{
				role: "tool_result",
				tool_use_id: "toolu_01",
				content: "Edited /foo.txt",
			},
		];

		const result = foldMessages(messages, 0, messages.length);

		expect(result).toHaveLength(1);
		expect(result[0].text).toMatch(/→ success/);
	});

	it("handles tool result containing 'Wrote' success marker", () => {
		const messages: LLMMessage[] = [
			{
				role: "tool_call",
				content: [
					{
						type: "tool_use",
						id: "toolu_01",
						name: "write",
						input: { file_path: "/bar.txt", content: "hello" },
					},
				],
			},
			{
				role: "tool_result",
				tool_use_id: "toolu_01",
				content: "Wrote /bar.txt",
			},
		];

		const result = foldMessages(messages, 0, messages.length);

		expect(result).toHaveLength(1);
		expect(result[0].text).toMatch(/→ success/);
	});

	it("handles tool_call with string content (legacy or serialized)", () => {
		const messages: LLMMessage[] = [
			{
				role: "tool_call",
				content: "tool_use: bash(git status)",
			},
			{ role: "tool_result", tool_use_id: "toolu_01", content: "Exit code: 0" },
		];

		const result = foldMessages(messages, 0, messages.length);

		expect(result).toHaveLength(1);
		expect(result[0].text).toMatch(/bash/);
	});

	it("handles tool_call with malformed content (unparseable)", () => {
		const messages: LLMMessage[] = [
			{
				role: "tool_call",
				content: "invalid content",
			},
			{ role: "tool_result", tool_use_id: "toolu_01", content: "result" },
		];

		const result = foldMessages(messages, 0, messages.length);

		expect(result).toHaveLength(1);
		// Heuristic extraction falls back to "unknown" tool name
		expect(result[0].text).toMatch(/\[tool\] unknown/);
		expect(result[0].sourceCount).toBe(2);
	});

	it("handles tool_call with more tool_uses than tool_results", () => {
		const messages: LLMMessage[] = [
			{
				role: "tool_call",
				content: [
					{
						type: "tool_use",
						id: "toolu_01",
						name: "bash",
						input: { command: "ls" },
					},
					{
						type: "tool_use",
						id: "toolu_02",
						name: "bash",
						input: { command: "pwd" },
					},
					{
						type: "tool_use",
						id: "toolu_03",
						name: "bash",
						input: { command: "whoami" },
					},
				],
			},
			{ role: "tool_result", tool_use_id: "toolu_01", content: "file.txt" },
		];

		const result = foldMessages(messages, 0, messages.length);

		expect(result).toHaveLength(3);
		expect(result[0].text).toMatch(/bash\(ls\)/);
		expect(result[1].text).toMatch(/bash\(pwd\) → \(no result\)/);
		expect(result[2].text).toMatch(/bash\(whoami\) → \(no result\)/);
		expect(result[0].sourceCount).toBe(2); // tool_call + 1 result
	});

	it("handles tool_call with fewer tool_uses than tool_results", () => {
		const messages: LLMMessage[] = [
			{
				role: "tool_call",
				content: [
					{
						type: "tool_use",
						id: "toolu_01",
						name: "bash",
						input: { command: "ls" },
					},
				],
			},
			{ role: "tool_result", tool_use_id: "toolu_01", content: "file1.txt" },
			{ role: "tool_result", tool_use_id: "toolu_02", content: "file2.txt" },
			{ role: "tool_result", tool_use_id: "toolu_03", content: "file3.txt" },
		];

		const result = foldMessages(messages, 0, messages.length);

		expect(result).toHaveLength(3);
		expect(result[0].text).toMatch(/bash\(ls\)/);
		expect(result[1].text).toMatch(/\?\(…\) → file2/);
		expect(result[2].text).toMatch(/\?\(…\) → file3/);
		expect(result[0].sourceCount).toBe(4); // tool_call + 3 results
	});

	it("handles partial range selection (middle slice)", () => {
		const messages: LLMMessage[] = [
			{ role: "user", content: "First" },
			{ role: "assistant", content: "Second" },
			{ role: "user", content: "Third" },
			{ role: "assistant", content: "Fourth" },
		];

		const result = foldMessages(messages, 1, 3);

		expect(result).toHaveLength(2);
		expect(result[0].text).toBe("[assistant] Second");
		expect(result[1].text).toBe("[user] Third");
	});

	it("estimates tokens correctly (chars / 4 heuristic)", () => {
		const messages: LLMMessage[] = [{ role: "user", content: "abcd" }];

		const result = foldMessages(messages, 0, messages.length);

		expect(result).toHaveLength(1);
		// "[user] abcd" = 11 chars → ceil(11/4) = 3 tokens
		expect(result[0].tokens).toBe(3);
	});

	it("handles tool_result with ContentBlock[] containing text", () => {
		const messages: LLMMessage[] = [
			{
				role: "tool_call",
				content: [
					{
						type: "tool_use",
						id: "toolu_01",
						name: "bash",
						input: { command: "echo hi" },
					},
				],
			},
			{
				role: "tool_result",
				tool_use_id: "toolu_01",
				content: [{ type: "text", text: "Exit code: 0\nhi" }],
			},
		];

		const result = foldMessages(messages, 0, messages.length);

		expect(result).toHaveLength(1);
		expect(result[0].text).toMatch(/exit 0/);
	});

	it("handles assistant message with non-text ContentBlock[] (e.g., only thinking)", () => {
		const messages: LLMMessage[] = [
			{
				role: "assistant",
				content: [{ type: "thinking", thinking: "Internal reasoning" }],
			},
		];

		const result = foldMessages(messages, 0, messages.length);

		expect(result).toHaveLength(1);
		expect(result[0].text).toBe("[assistant] [non-text content]");
	});

	it("handles tool input with multiple parameters (shows key=value)", () => {
		const messages: LLMMessage[] = [
			{
				role: "tool_call",
				content: [
					{
						type: "tool_use",
						id: "toolu_01",
						name: "edit",
						input: { file_path: "/foo.txt", old_string: "a", new_string: "b" },
					},
				],
			},
			{ role: "tool_result", tool_use_id: "toolu_01", content: "success" },
		];

		const result = foldMessages(messages, 0, messages.length);

		expect(result).toHaveLength(1);
		expect(result[0].text).toMatch(/edit\(file_path=/);
	});

	it("handles tool input with single parameter (shows value only)", () => {
		const messages: LLMMessage[] = [
			{
				role: "tool_call",
				content: [
					{
						type: "tool_use",
						id: "toolu_01",
						name: "bash",
						input: { command: "ls -la" },
					},
				],
			},
			{ role: "tool_result", tool_use_id: "toolu_01", content: "success" },
		];

		const result = foldMessages(messages, 0, messages.length);

		expect(result).toHaveLength(1);
		expect(result[0].text).toMatch(/bash\(ls -la\)/);
	});
});
