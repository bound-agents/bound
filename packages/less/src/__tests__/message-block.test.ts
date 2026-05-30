import { describe, expect, it } from "bun:test";
import { render } from "ink-testing-library";
import React from "react";
import { MessageBlock } from "../tui/components/MessageBlock";

/** Let React effects flush */
const tick = () => new Promise((resolve) => setTimeout(resolve, 50));

describe("MessageBlock", () => {
	describe("tool_call rendering", () => {
		it("formats multi-tool_use blocks with tool names, not raw JSON", async () => {
			const content = JSON.stringify([
				{
					type: "tool_use",
					id: "tooluse_aaa111",
					name: "boundless_write",
					input: { file_path: "/tmp/test.txt", content: "hello" },
				},
				{
					type: "tool_use",
					id: "tooluse_bbb222",
					name: "boundless_bash",
					input: { command: "echo hi" },
				},
			]);

			const { lastFrame } = render(
				React.createElement(MessageBlock, {
					message: {
						id: "msg-1",
						role: "tool_call",
						content,
						thread_id: "t-1",
						created_at: new Date().toISOString(),
					},
					terminalColumns: 120,
				}),
			);
			await tick();

			const frame = lastFrame();
			// Should show tool names with boundless_ prefix stripped
			expect(frame).toContain("write");
			expect(frame).toContain("bash");
			expect(frame).not.toContain("boundless_");
			// Should NOT dump raw JSON
			expect(frame).not.toContain('"type":"tool_use"');
			expect(frame).not.toContain("tool_use");
		});

		it("prefixes remote (non-boundless) tools with [remote]", async () => {
			const content = JSON.stringify([
				{
					type: "tool_use",
					id: "tooluse_ccc333",
					name: "bash",
					input: { command: "ls -la" },
				},
				{
					type: "tool_use",
					id: "tooluse_ddd444",
					name: "memorize",
					input: { key: "test", value: "hello" },
				},
			]);

			const { lastFrame } = render(
				React.createElement(MessageBlock, {
					message: {
						id: "msg-1",
						role: "tool_call",
						content,
						thread_id: "t-1",
						created_at: new Date().toISOString(),
					},
					terminalColumns: 120,
				}),
			);
			await tick();

			const frame = lastFrame();
			expect(frame).toContain("[remote] bash");
			expect(frame).toContain("[remote] memorize");
		});

		it("does not prefix boundless_ tools with [remote]", async () => {
			const content = JSON.stringify([
				{
					type: "tool_use",
					id: "tooluse_eee555",
					name: "boundless_bash",
					input: { command: "echo hi" },
				},
			]);

			const { lastFrame } = render(
				React.createElement(MessageBlock, {
					message: {
						id: "msg-1",
						role: "tool_call",
						content,
						thread_id: "t-1",
						created_at: new Date().toISOString(),
					},
					terminalColumns: 120,
				}),
			);
			await tick();

			const frame = lastFrame();
			// Should strip boundless_ prefix for local tools
			expect(frame).toContain("bash");
			expect(frame).not.toContain("boundless_");
			expect(frame).not.toContain("[remote]");
		});

		it("shows tool arguments in a readable format", async () => {
			const content = JSON.stringify([
				{
					type: "tool_use",
					id: "tooluse_aaa111",
					name: "boundless_bash",
					input: { command: "echo hello" },
				},
			]);

			const { lastFrame } = render(
				React.createElement(MessageBlock, {
					message: {
						id: "msg-1",
						role: "tool_call",
						content,
						thread_id: "t-1",
						created_at: new Date().toISOString(),
					},
					terminalColumns: 120,
				}),
			);
			await tick();

			const frame = lastFrame();
			// Should strip boundless_ prefix
			expect(frame).toContain("bash");
			expect(frame).not.toContain("boundless_");
			// Should show the command argument in some readable way
			expect(frame).toContain("echo hello");
		});
	});

	describe("alert rendering", () => {
		it("renders alert messages with error styling", async () => {
			const { lastFrame } = render(
				React.createElement(MessageBlock, {
					message: {
						id: "msg-1",
						role: "alert",
						content: "Error: Bedrock request failed: Expected toolResult blocks",
						thread_id: "t-1",
						created_at: new Date().toISOString(),
					},
					terminalColumns: 120,
				}),
			);
			await tick();

			const frame = lastFrame();
			// Should show the error message, not "[alert: ...]" fallback
			expect(frame).toContain("Bedrock request failed");
		});
	});

	describe("tool_result rendering", () => {
		it("does not render a collapsible header with tool name", async () => {
			const { lastFrame } = render(
				React.createElement(MessageBlock, {
					message: {
						id: "msg-no-header",
						role: "tool_result",
						content: "some output",
						tool_name: "boundless_bash",
						thread_id: "t-1",
						created_at: new Date().toISOString(),
					},
					terminalColumns: 120,
				}),
			);
			await tick();

			const frame = lastFrame();
			// Should NOT render a collapsible header like "▾ bash" or "▸ bash"
			expect(frame).not.toContain("▾");
			expect(frame).not.toContain("▸");
			// Should render the output directly
			expect(frame).toContain("some output");
		});

		it("shows a success indicator for non-error results", async () => {
			const { lastFrame } = render(
				React.createElement(MessageBlock, {
					message: {
						id: "msg-success",
						role: "tool_result",
						content: "file written",
						tool_name: "boundless_write",
						thread_id: "t-1",
						created_at: new Date().toISOString(),
					},
					terminalColumns: 120,
				}),
			);
			await tick();

			const frame = lastFrame();
			// Should show a success marker (checkmark)
			expect(frame).toContain("✓");
		});

		it("shows an error indicator for error results", async () => {
			const { lastFrame } = render(
				React.createElement(MessageBlock, {
					message: {
						id: "msg-err",
						role: "tool_result",
						content: "command not found",
						tool_name: "boundless_bash",
						exit_code: 1,
						thread_id: "t-1",
						created_at: new Date().toISOString(),
					},
					terminalColumns: 120,
				}),
			);
			await tick();

			const frame = lastFrame();
			// Should show an error marker (cross)
			expect(frame).toContain("✗");
		});

		it("truncates tool_result string content to 5 lines", async () => {
			const lines = Array.from({ length: 20 }, (_, i) => `line ${i + 1}`);
			const content = lines.join("\n");

			const { lastFrame } = render(
				React.createElement(MessageBlock, {
					message: {
						id: "msg-trunc-1",
						role: "tool_result",
						content,
						tool_name: "boundless_bash",
						thread_id: "t-1",
						created_at: new Date().toISOString(),
					},
					terminalColumns: 120,
				}),
			);
			await tick();

			const frame = lastFrame();
			// First line is the header label; body is the remainder, truncated to
			// the body cap (5 visual rows). 20 logical lines − 1 header = 19 body
			// lines; first 5 visible, 14 deferred to the "… more lines" tail.
			expect(frame).toContain("line 1");
			expect(frame).toContain("line 6");
			expect(frame).not.toContain("line 7");
			expect(frame).toContain("… 14 more lines");
		});

		it("truncates tool_result ContentBlock[] to 5 lines", async () => {
			const lines = Array.from({ length: 12 }, (_, i) => `output ${i + 1}`);
			const content = JSON.stringify([{ type: "text", text: lines.join("\n") }]);

			const { lastFrame } = render(
				React.createElement(MessageBlock, {
					message: {
						id: "msg-trunc-2",
						role: "tool_result",
						content,
						tool_name: "boundless_read",
						thread_id: "t-1",
						created_at: new Date().toISOString(),
					},
					terminalColumns: 120,
				}),
			);
			await tick();

			const frame = lastFrame();
			expect(frame).toContain("output 1");
			expect(frame).toContain("output 6");
			expect(frame).not.toContain("output 7");
			expect(frame).toContain("… 6 more lines");
		});

		it("does not truncate tool_result with 5 or fewer lines", async () => {
			const content = "line 1\nline 2\nline 3";

			const { lastFrame } = render(
				React.createElement(MessageBlock, {
					message: {
						id: "msg-trunc-3",
						role: "tool_result",
						content,
						tool_name: "boundless_bash",
						thread_id: "t-1",
						created_at: new Date().toISOString(),
					},
					terminalColumns: 120,
				}),
			);
			await tick();

			const frame = lastFrame();
			expect(frame).toContain("line 1");
			expect(frame).toContain("line 3");
			expect(frame).not.toContain("more lines");
		});

		it("strips leading/trailing blank lines before truncating", async () => {
			const lines = [
				"",
				"",
				"",
				...Array.from({ length: 10 }, (_, i) => `content ${i + 1}`),
				"",
				"",
			];
			const content = lines.join("\n");

			const { lastFrame } = render(
				React.createElement(MessageBlock, {
					message: {
						id: "msg-trunc-4",
						role: "tool_result",
						content,
						tool_name: "boundless_bash",
						thread_id: "t-1",
						created_at: new Date().toISOString(),
					},
					terminalColumns: 120,
				}),
			);
			await tick();

			const frame = lastFrame();
			// Should show first content line as header + 5 body lines, not blank
			// lines. 10 content lines − 1 header = 9 body lines; first 5 visible,
			// 4 deferred to the tail.
			expect(frame).toContain("content 1");
			expect(frame).toContain("content 6");
			expect(frame).not.toContain("content 7");
			expect(frame).toContain("… 4 more lines");
		});

		it("counts visual rows, not logical lines, when truncating long unbroken bodies", async () => {
			// Issues #74 + #75: a single 800-char body line previously counted as
			// one logical line and slipped past the line-count truncation, blowing
			// out the terminal at render time and dropping the left stripe on the
			// first wrapped continuation. After the fix, body lines are pre-wrapped
			// at the measured visual width (stripeWidth − 6 for terminalColumns=120
			// = 113), so an 800-char body produces ⌈800 / 113⌉ = 8 visual rows;
			// only TOOL_RESULT_MAX_LINES (5) are visible, the rest go to the tail.
			const longBody = "x".repeat(800);
			const content = `header line\n${longBody}`;

			const { lastFrame } = render(
				React.createElement(MessageBlock, {
					message: {
						id: "msg-trunc-wrap",
						role: "tool_result",
						content,
						tool_name: "boundless_bash",
						thread_id: "t-1",
						created_at: new Date().toISOString(),
					},
					terminalColumns: 120,
				}),
			);
			await tick();

			const frame = lastFrame() ?? "";
			expect(frame).toContain("header line");
			// 8 visual rows from the wrap, 5 visible, 3 deferred.
			expect(frame).toContain("… 3 more lines");
			// At least one wrapped chunk must appear in the body (the row is the
			// "x" run, which by construction never appears in the header).
			expect(frame.match(/x{50,}/g)?.length ?? 0).toBeGreaterThan(0);
		});

		it("renders tool_result with ContentBlock array without crashing", async () => {
			const content = JSON.stringify([
				{ type: "text", text: "boundless bash online: 2026-04-19T20:31:58Z on host" },
			]);

			const { lastFrame } = render(
				React.createElement(MessageBlock, {
					message: {
						id: "msg-1",
						role: "tool_result",
						content,
						tool_name: "boundless_bash",
						thread_id: "t-1",
						created_at: new Date().toISOString(),
					},
					terminalColumns: 120,
				}),
			);
			await tick();

			const frame = lastFrame();
			// Should render without Box-inside-Text crash; header strips prefix
			expect(frame).toContain("bash");
			expect(frame).not.toContain("boundless_bash");
			expect(frame).toContain("boundless bash online");
		});
	});

	describe("system message rendering", () => {
		it("renders system messages with dim styling", async () => {
			const { lastFrame } = render(
				React.createElement(MessageBlock, {
					message: {
						id: "msg-1",
						role: "system",
						content: "[Client tool call expired]",
						thread_id: "t-1",
						created_at: new Date().toISOString(),
					},
					terminalColumns: 120,
				}),
			);
			await tick();

			const frame = lastFrame();
			expect(frame).toContain("Client tool call expired");
		});
	});

	describe("stripe width constraint", () => {
		// Regression: long unbroken content used to soft-wrap at the terminal
		// edge (column 0), placing wrapped fragments OUTSIDE the colored
		// stripe. With an explicit `width` on the StripeBox, Ink wraps
		// content INSIDE the stripe, so every rendered row begins with the
		// stripe glyph for `borderStyle="single"`: U+2502 BOX DRAWINGS LIGHT
		// VERTICAL ("│").
		it("wraps long content inside the stripe at narrow terminal widths", async () => {
			const longLine = "abcdefghij".repeat(20); // 200 chars, no whitespace breaks
			const { lastFrame } = render(
				React.createElement(MessageBlock, {
					message: {
						id: "msg-wrap",
						role: "user",
						content: longLine,
						thread_id: "t-1",
						created_at: new Date().toISOString(),
					},
					terminalColumns: 40,
				}),
			);
			await tick();

			const frame = lastFrame() ?? "";
			const lines = frame.split("\n").filter((l) => l.trim().length > 0);
			// Sanity: long content must produce more than one rendered row.
			expect(lines.length).toBeGreaterThan(1);
			// Every non-empty rendered row must begin with the stripe glyph,
			// i.e. the wrap stays inside the stripe rather than escaping to
			// column 0.
			for (const line of lines) {
				expect(line.startsWith("│")).toBe(true);
			}
			// And no rendered row exceeds the configured width budget
			// (stripeWidth = max(20, 40 - 1) = 39).
			for (const line of lines) {
				expect(line.length).toBeLessThanOrEqual(39);
			}
		});

		it("floors stripe width at 20 columns for absurdly narrow terminals", async () => {
			const longLine = "x".repeat(200);
			const { lastFrame } = render(
				React.createElement(MessageBlock, {
					message: {
						id: "msg-floor",
						role: "assistant",
						content: longLine,
						thread_id: "t-1",
						created_at: new Date().toISOString(),
					},
					terminalColumns: 5,
				}),
			);
			await tick();

			const frame = lastFrame() ?? "";
			const lines = frame.split("\n").filter((l) => l.trim().length > 0);
			expect(lines.length).toBeGreaterThan(1);
			// Floor of 20 means rendered rows can be up to 20 cols wide
			// even though the terminal claims 5.
			for (const line of lines) {
				expect(line.startsWith("│")).toBe(true);
				expect(line.length).toBeLessThanOrEqual(20);
			}
		});
	});
});
