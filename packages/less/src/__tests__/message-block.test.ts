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
				}),
			);
			await tick();

			const frame = lastFrame();
			expect(frame).toContain("line 1");
			expect(frame).toContain("line 5");
			expect(frame).not.toContain("line 6");
			expect(frame).toContain("... 15 more lines");
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
				}),
			);
			await tick();

			const frame = lastFrame();
			expect(frame).toContain("output 1");
			expect(frame).toContain("output 5");
			expect(frame).not.toContain("output 6");
			expect(frame).toContain("... 7 more lines");
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
				}),
			);
			await tick();

			const frame = lastFrame();
			// Should show first 5 content lines, not blank lines
			expect(frame).toContain("content 1");
			expect(frame).toContain("content 5");
			expect(frame).not.toContain("content 6");
			expect(frame).toContain("... 5 more lines");
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
				}),
			);
			await tick();

			const frame = lastFrame();
			expect(frame).toContain("Client tool call expired");
		});
	});
});
