import { describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { formatWithHashes } from "@bound/shared";
import { render } from "ink-testing-library";
import React from "react";
import { MessageBlock } from "../tui/components/MessageBlock";

/** Let React effects flush */
const tick = () => new Promise((resolve) => setTimeout(resolve, 50));

describe("MessageBlock", () => {
	it("renders cache read/write usage on assistant cards and omits empty usage", () => {
		const baseMessage = {
			id: "assistant-cache",
			thread_id: "t-1",
			role: "assistant" as const,
			content: "Done.",
			model_id: "test-model",
			tool_name: null,
			created_at: new Date().toISOString(),
			modified_at: null,
			host_origin: "test",
			deleted: 0,
			exit_code: null,
			metadata: JSON.stringify({ cache_usage: { read: 12_300, write: 400 } }),
		};
		const withCache =
			render(
				React.createElement(MessageBlock, {
					message: baseMessage,
					terminalColumns: 120,
				}),
			).lastFrame() ?? "";
		const withoutCache =
			render(
				React.createElement(MessageBlock, {
					message: { ...baseMessage, id: "assistant-no-cache", metadata: null },
					terminalColumns: 120,
				}),
			).lastFrame() ?? "";

		expect(withCache).toContain("cache 12.3k r / 0.4k w");
		expect(withoutCache).not.toContain("cache");
	});
	it("renders aux tool results as clipped markdown with closed fences", () => {
		const sourceLines = [
			"# Aux report",
			"",
			"- first",
			"- second",
			"",
			"```ts",
			...Array.from({ length: 40 }, (_, i) => `const value${i} = ${i};`),
		];
		const message = {
			id: "aux-result",
			thread_id: "t-1",
			role: "tool_result" as const,
			content: sourceLines.join("\n"),
			tool_name: "aux-1",
			created_at: new Date().toISOString(),
		};
		const frame =
			render(
				React.createElement(MessageBlock, { message, toolName: "aux", terminalColumns: 120 }),
			).lastFrame() ?? "";
		expect(frame).toContain("Aux report");
		expect(frame).toContain("• first");
		expect(frame).toContain("… 14 more lines");
		expect(frame).not.toContain("```ts");
		expect(frame).not.toContain("```\n");
	});

	it("keeps non-aux tool result rendering unchanged", () => {
		const message = {
			id: "bash-result",
			thread_id: "t-1",
			role: "tool_result" as const,
			content: "# literal heading\n- literal bullet",
			tool_name: "bash-1",
			created_at: new Date().toISOString(),
		};
		const frame =
			render(
				React.createElement(MessageBlock, {
					message,
					toolName: "boundless_bash",
					terminalColumns: 120,
				}),
			).lastFrame() ?? "";
		expect(frame).toContain("- literal bullet");
		expect(frame).not.toContain("• literal bullet");
	});
	it("keeps syntax colors on edit content while coloring the diff gutter", async () => {
		const dir = mkdtempSync(join(tmpdir(), "bound-edit-highlight-"));
		const filePath = join(dir, "sample.ts");
		const before = "const oldValue = 1;";
		writeFileSync(filePath, before);
		const anchor = formatWithHashes(before).split("|")[0];
		const edits = [{ start: anchor, end: anchor, content: "const newValue = 2;" }];
		const message = {
			id: "call-highlight",
			role: "tool_call" as const,
			content: JSON.stringify([
				{
					type: "tool_use",
					id: "edit-highlight",
					name: "boundless_edit",
					input: { file_path: filePath, edits },
				},
			]),
			thread_id: "t-1",
			created_at: new Date().toISOString(),
		};
		try {
			const frame =
				render(React.createElement(MessageBlock, { message, terminalColumns: 120 })).lastFrame() ??
				"";
			expect(frame).toContain("+ const newValue = 2;");
			const source = await Bun.file("packages/less/src/tui/components/MessageBlock.tsx").text();
			expect(source).toContain(
				'<Text color={line.kind === "added" ? tokens.diffAdded : tokens.diffRemoved}>',
			);
			expect(source).not.toMatch(/<HighlightedLine[\s\S]{0,160}color=\{line\.kind/);
			expect(source).not.toContain('lang={lang} color="green"');
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
	it("measures hashline edit stats from the real diff and renders removed text", () => {
		const dir = mkdtempSync(join(tmpdir(), "bound-edit-diff-"));
		const filePath = join(dir, "sample.ts");
		const before = ["const keep = 1;", "const same = 2;", "const old = 3;", "const tail = 4;"].join(
			"\n",
		);
		writeFileSync(filePath, before);
		const lines = formatWithHashes(before).split("\n");
		const edits = [
			{
				start: lines[0].split("|")[0],
				end: lines[2].split("|")[0],
				content: ["const keep = 1;", "const same = 2;", "const fresh = 3;"].join("\n"),
			},
		];
		const call = {
			id: "call-edit",
			role: "tool_call" as const,
			content: JSON.stringify([
				{
					type: "tool_use",
					id: "edit-1",
					name: "boundless_edit",
					input: { file_path: filePath, edits },
				},
			]),
			thread_id: "t-1",
			created_at: new Date().toISOString(),
		};
		const result = {
			...call,
			id: "result-edit",
			role: "tool_result" as const,
			content: "Edited",
			tool_name: "edit-1",
		};
		try {
			const callFrame =
				render(
					React.createElement(MessageBlock, { message: call, terminalColumns: 120 }),
				).lastFrame() ?? "";
			expect(callFrame).toContain("const old = 3;");
			const resultFrame =
				render(
					React.createElement(MessageBlock, {
						message: result,
						toolName: "boundless_edit",
						toolInput: { file_path: filePath, edits },
						filePath,
						terminalColumns: 120,
					}),
				).lastFrame() ?? "";
			expect(resultFrame).toContain("+1");
			expect(resultFrame).toContain("−1");
			expect(resultFrame).not.toContain("+3");
			expect(resultFrame).not.toContain("−3");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("marks unreadable hashline removal counts as estimates", () => {
		const edits = [{ start: "4:aaaa", end: "6:bbbb", content: "replacement" }];
		const message = {
			id: "result-remote-edit",
			thread_id: "t-1",
			role: "tool_result" as const,
			content: "Edited",
			tool_name: "edit-1",
			created_at: new Date().toISOString(),
		};
		const frame =
			render(
				React.createElement(MessageBlock, {
					message,
					toolName: "bms_edit",
					toolInput: { path: "/missing.ts", edits },
					terminalColumns: 120,
				}),
			).lastFrame() ?? "";
		expect(frame).toContain("−~3");
	});

	describe("tool_call rendering", () => {
		it("formats tool_use blocks with tool names, not raw JSON", async () => {
			const content = JSON.stringify([
				{
					type: "tool_use",
					id: "tooluse_aaa111",
					name: "boundless_write",
					input: { file_path: "/tmp/test.txt", content: "hello" },
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
			expect(frame).not.toContain("boundless_");
			// Should NOT dump raw JSON
			expect(frame).not.toContain('"type":"tool_use"');
			expect(frame).not.toContain("tool_use");
		});

		it("suppresses parallel multi-tool_use call rows — requests render on their results", async () => {
			// <Static> commits the call row before any result exists, so pairing
			// request with result is only possible by re-rendering the ⏵ row on
			// each result (MessageBlock's showRequest prop). The call itself
			// commits nothing.
			const content = JSON.stringify([
				{
					type: "tool_use",
					id: "tooluse_aaa111",
					name: "boundless_bash",
					input: { command: "echo one" },
				},
				{
					type: "tool_use",
					id: "tooluse_bbb222",
					name: "boundless_bash",
					input: { command: "echo two" },
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

			expect((lastFrame() ?? "").trim()).toBe("");
		});

		it("suppresses a lone yard call row — the execution card carries the program", async () => {
			// The Yard execution card replaces BOTH the request and result rows:
			// it renders the program (highlighted), input, graph, and result
			// itself, so a separate request card above it showed the same
			// payload twice (thread 2b372dca).
			const content = JSON.stringify([
				{
					type: "tool_use",
					id: "tooluse_yard1",
					name: "yard",
					input: { program: "function* main() { return 1; }", budget: { timeout_seconds: 60 } },
				},
			]);

			const { lastFrame } = render(
				React.createElement(MessageBlock, {
					message: {
						id: "msg-yard",
						role: "tool_call",
						content,
						thread_id: "t-1",
						created_at: new Date().toISOString(),
					},
					terminalColumns: 120,
				}),
			);
			await tick();

			expect((lastFrame() ?? "").trim()).toBe("");
		});

		it("prefixes remote (non-boundless) tools with [remote]", async () => {
			// Single-use calls: multi-use (parallel) calls are suppressed — their
			// ⏵ rows render on the results — so formatting is pinned per-use here.
			const renderCall = (id: string, name: string, input: Record<string, unknown>) =>
				render(
					React.createElement(MessageBlock, {
						message: {
							id: "msg-1",
							role: "tool_call",
							content: JSON.stringify([{ type: "tool_use", id, name, input }]),
							thread_id: "t-1",
							created_at: new Date().toISOString(),
						},
						terminalColumns: 120,
					}),
				);

			const bash = renderCall("tooluse_ccc333", "bash", { command: "ls -la" });
			const memorize = renderCall("tooluse_ddd444", "memorize", { key: "test", value: "hello" });
			await tick();

			expect(bash.lastFrame()).toContain("[remote] bash");
			expect(memorize.lastFrame()).toContain("[remote] memorize");
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

		it("strips the bms_ prefix but keeps the [remote] tag for VFS tools", async () => {
			const content = JSON.stringify([
				{
					type: "tool_use",
					id: "tooluse_fff666",
					name: "bms_bash",
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
			// Main Station (VFS) tool: prefix stripped for display, but still tagged
			// [remote] because it executes server-side, not in the local cwd.
			expect(frame).toContain("[remote] bash");
			expect(frame).not.toContain("bms_");
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

		it("summarizes non-bash shell commands (pwsh/cmd) as a bare command line", async () => {
			// resolveShell mints boundless_pwsh / boundless_cmd for PowerShell and
			// cmd.exe; the summary must render the command line directly, not fall
			// through to the generic `command=...` key=value branch. Rendered as
			// single-use calls — multi-use (parallel) calls are suppressed and
			// their ⏵ rows ride the results instead.
			const renderShellCall = (id: string, name: string, command: string) =>
				render(
					React.createElement(MessageBlock, {
						message: {
							id: "msg-1",
							role: "tool_call",
							content: JSON.stringify([{ type: "tool_use", id, name, input: { command } }]),
							thread_id: "t-1",
							created_at: new Date().toISOString(),
						},
						terminalColumns: 120,
					}),
				);

			const pwsh = renderShellCall("tooluse_pwsh01", "boundless_pwsh", "Get-ChildItem -Recurse");
			const cmd = renderShellCall("tooluse_cmd001", "boundless_cmd", "dir /s");
			await tick();

			expect(pwsh.lastFrame()).toContain("Get-ChildItem -Recurse");
			expect(cmd.lastFrame()).toContain("dir /s");
			// Not the generic key=value fallback.
			expect(pwsh.lastFrame()).not.toContain("command=");
			expect(cmd.lastFrame()).not.toContain("command=");
		});
	});

	describe("alert rendering", () => {
		it("renders alert messages with a red stripe and header", async () => {
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
			// Striped like a normal turn (#139): "alert" header + stripe glyph.
			expect(frame).toContain("alert");
			expect(frame).toContain("│");
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

		it("shows a terminal-sized excerpt of tool_result string content", async () => {
			const lines = Array.from({ length: 50 }, (_, i) => `line ${i + 1}`);
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
			// The first line is the header. The remaining 49 body rows retain a
			// 16-row head and 16-row tail; 17 rows sit behind the elision marker.
			expect(frame).toContain("line 1");
			expect(frame).toContain("line 17");
			expect(frame).not.toContain("line 18");
			expect(frame).toContain("line 35");
			expect(frame).toContain("line 50");
			expect(frame).toContain("… 17 more lines");
		});

		it("shows ordinary bounded shell output without elision", async () => {
			// This mirrors commands such as `tail -25`: one header row and up to
			// 32 result rows must remain inspectable directly in the transcript.
			const content = Array.from({ length: 33 }, (_, i) => `line ${i + 1}`).join("\n");
			const { lastFrame } = render(
				React.createElement(MessageBlock, {
					message: {
						id: "msg-preview-fit",
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
			expect(frame).toContain("line 33");
			expect(frame).not.toContain("more lines");
		});

		it("truncates ContentBlock[] results using the same 16-row head/tail split", async () => {
			const lines = Array.from({ length: 50 }, (_, i) => `output ${i + 1}`);
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
			expect(frame).toContain("output 17");
			expect(frame).not.toContain("output 18");
			expect(frame).toContain("output 35");
			expect(frame).toContain("output 50");
			expect(frame).toContain("… 17 more lines");
		});

		it("strips leading/trailing blank lines before truncating", async () => {
			const lines = ["", "", ...Array.from({ length: 50 }, (_, i) => `content ${i + 1}`), "", ""];
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
			expect(frame).toContain("content 1");
			expect(frame).toContain("content 17");
			expect(frame).not.toContain("content 18");
			expect(frame).toContain("content 35");
			expect(frame).toContain("content 50");
			expect(frame).toContain("… 17 more lines");
		});

		it("counts visual rows, not logical lines, when truncating long unbroken bodies", async () => {
			// Issues #74 + #75: a single long body line must be pre-wrapped before
			// the row budget is applied. At 120 columns, 4,000 chars make 36 visual
			// rows; the 32-row preview therefore defers four rows.
			const longBody = "x".repeat(4000);
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
			expect(frame).toContain("… 4 more lines");
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
		it("renders system messages with a yellow stripe and header", async () => {
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
			// Striped like a normal turn (#139): "system" header + stripe glyph.
			expect(frame).toContain("system");
			expect(frame).toContain("│");
		});

		it("renders developer messages (system notifications) with a yellow stripe and header", async () => {
			const { lastFrame } = render(
				React.createElement(MessageBlock, {
					message: {
						id: "msg-dev",
						role: "developer",
						content: "New PR opened: #140",
						thread_id: "t-1",
						created_at: new Date().toISOString(),
					},
					terminalColumns: 120,
				}),
			);
			await tick();

			const frame = lastFrame();
			// Per invariant #19, injected system context lands as role:"developer";
			// it should render with the system stripe + header, not the
			// "[developer: …]" raw fallback (#139).
			expect(frame).toContain("New PR opened: #140");
			expect(frame).toContain("system");
			expect(frame).toContain("│");
			expect(frame).not.toContain("[developer:");
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

	describe("optimistic pending user message (#88)", () => {
		it("renders the pending placeholder with a sending cue", async () => {
			const { lastFrame } = render(
				React.createElement(MessageBlock, {
					message: {
						id: "__pending_user__",
						role: "user",
						content: "deploy the thing",
						thread_id: "t-1",
						created_at: new Date().toISOString(),
					},
					terminalColumns: 80,
				}),
			);
			await tick();

			const frame = lastFrame() ?? "";
			expect(frame).toContain("you");
			expect(frame).toContain("sending");
			expect(frame).toContain("deploy the thing");
		});

		it("renders a committed user message without the sending cue", async () => {
			const { lastFrame } = render(
				React.createElement(MessageBlock, {
					message: {
						id: "real-1",
						role: "user",
						content: "deploy the thing",
						thread_id: "t-1",
						created_at: new Date().toISOString(),
					},
					terminalColumns: 80,
				}),
			);
			await tick();

			const frame = lastFrame() ?? "";
			expect(frame).toContain("you");
			expect(frame).not.toContain("sending");
			expect(frame).toContain("deploy the thing");
		});
	});
});

describe("JSON-shaped tool_result rendering", () => {
	it("summarizes a JSON object result in the header and pretty-prints the body", async () => {
		// MCP/remote tools usually return one JSON blob on a single line;
		// raw it soft-wraps across rows and becomes its own header label.
		const content = JSON.stringify({
			title: "Mixed-thread conversation state projection",
			state: "open",
			comments: 12,
			body: "Long body text",
		});
		const { lastFrame } = render(
			React.createElement(MessageBlock, {
				message: {
					id: "msg-json-1",
					role: "tool_result",
					content,
					tool_name: "tooluse_gh1",
					thread_id: "t-1",
					created_at: new Date().toISOString(),
				},
				toolName: "github",
				terminalColumns: 120,
			}),
		);
		await tick();

		const frame = lastFrame() ?? "";
		expect(frame).toContain("JSON object · 4 keys");
		// The entire small object stays visible: JSON is pretty-printed first, then
		// consumes the same 32-row result budget as ordinary tool output.
		expect(frame).toContain('"title"');
		expect(frame).toContain('"state": "open"');
		expect(frame).toContain('"comments": 12');
		expect(frame).not.toContain("more lines");
	});

	it("leaves non-JSON results alone", async () => {
		const { lastFrame } = render(
			React.createElement(MessageBlock, {
				message: {
					id: "msg-json-2",
					role: "tool_result",
					content: "{not json at all",
					tool_name: "tooluse_x",
					thread_id: "t-1",
					created_at: new Date().toISOString(),
				},
				terminalColumns: 120,
			}),
		);
		await tick();
		expect(lastFrame() ?? "").toContain("{not json at all");
	});
});

describe("offloaded tool_result rendering", () => {
	it("keeps the operator facts (size, path) and drops agent coaching", async () => {
		const content =
			'[Tool result offloaded: 145445 characters from "boundless_bash"]\n' +
			"The full output was too large for the context window and has been saved to: /var/folders/xx/bound-tool-results/abc.txt\n" +
			"Use bash to read or filter it, e.g.:\n" +
			"  cat /var/folders/xx/bound-tool-results/abc.txt | head -100";
		const { lastFrame } = render(
			React.createElement(MessageBlock, {
				message: {
					id: "msg-off-1",
					role: "tool_result",
					content,
					tool_name: "tooluse_b1",
					thread_id: "t-1",
					created_at: new Date().toISOString(),
				},
				toolName: "boundless_bash",
				terminalColumns: 120,
			}),
		);
		await tick();

		const frame = lastFrame() ?? "";
		expect(frame).toContain("output offloaded · 145,445 chars");
		expect(frame).toContain("→ /var/folders/xx/bound-tool-results/abc.txt");
		expect(frame).not.toContain("Use bash");
		expect(frame).not.toContain("too large for the context window");
	});
});

describe("outcome fact fragments (creative round)", () => {
	it("translates conventional exit codes on error results", async () => {
		const { lastFrame } = render(
			React.createElement(MessageBlock, {
				message: {
					id: "msg-exit-hint",
					role: "tool_result",
					content: "sh: nope: command not found",
					tool_name: "tu1",
					exit_code: 127,
					thread_id: "t-1",
					created_at: new Date().toISOString(),
				},
				toolName: "boundless_bash",
				terminalColumns: 120,
			}),
		);
		await tick();
		expect(lastFrame() ?? "").toContain("exit 127 (not found)");
	});

	it("marks anchor-derived edit result stats as estimates", async () => {
		// The target is unreadable, so the line-hint arithmetic is explicitly
		// approximate rather than presented as a measured diff.
		const { lastFrame } = render(
			React.createElement(MessageBlock, {
				message: {
					id: "msg-diffstat",
					role: "tool_result",
					content: "Edited /x/y.ts: applied 2 edits",
					tool_name: "tu1",
					exit_code: 0,
					thread_id: "t-1",
					created_at: new Date().toISOString(),
				},
				toolName: "boundless_edit",
				filePath: "/x/y.ts",
				toolInput: {
					file_path: "/x/y.ts",
					edits: [
						{ start: "12:aaaa", end: "14:bbbb", content: "line one\nline two" },
						{ start: "40:cccc", end: "40:cccc", content: "single" },
					],
				},
				terminalColumns: 120,
			}),
		);
		await tick();
		const frame = lastFrame() ?? "";
		expect(frame).toContain("+3");
		expect(frame).toContain("−~4");
	});
});

describe("edit preview removal headers", () => {
	it("marks the removal header count as estimated when source text is unavailable", async () => {
		// Anchor line numbers are hints and may drift; without the pre-edit file,
		// the header must not present their arithmetic as a measured count.
		const content = JSON.stringify([
			{
				type: "tool_use",
				id: "tu-1",
				name: "boundless_edit",
				input: {
					file_path: "/x/y.ts",
					edits: [{ start: "7:f872", end: "13:5ede", content: "a\nb" }],
				},
			},
		]);
		const { lastFrame } = render(
			React.createElement(MessageBlock, {
				message: {
					id: "msg-edit-minus",
					role: "tool_call",
					content,
					thread_id: "t-1",
					created_at: new Date().toISOString(),
				},
				terminalColumns: 120,
			}),
		);
		await tick();
		const frame = lastFrame() ?? "";
		expect(frame).toContain("− 7:f872 → 13:5ede · ~7 lines");
		expect(frame).not.toContain("@ 7:f872");
	});
});

describe("full-length tool arguments (no truncation)", () => {
	it("renders a long command in full, wrapped inside the stripe", async () => {
		// Kara's report: truncated args hide exactly the part that
		// distinguishes this call from the last one — heredoc commits all
		// rendered as `git add -A && git commit --author="pol...`.
		const longCmd = `git add -A packages/less && git commit -F - <<'MSG'\nfeat(less): a very long commit message body that continues well past any old eighty character cap\nMSG`;
		const { lastFrame } = render(
			React.createElement(MessageBlock, {
				message: {
					id: "msg-long-cmd",
					role: "tool_call",
					content: JSON.stringify([
						{ type: "tool_use", id: "tu-lc", name: "boundless_bash", input: { command: longCmd } },
					]),
					thread_id: "t-1",
					created_at: new Date().toISOString(),
				},
				terminalColumns: 60,
			}),
		);
		await tick();
		const frame = lastFrame() ?? "";
		// The distinguishing tail must be visible, and no ellipsis marker.
		expect(frame).toContain("eighty character cap");
		expect(frame).not.toContain("...");
		// Wrapped rows stay inside the stripe.
		const lines = frame.split("\n").filter((l) => l.trim().length > 0);
		for (const line of lines) {
			expect(line.startsWith("│")).toBe(true);
		}
	});

	it("renders MCP key=value args in full", async () => {
		const bigValue = "x".repeat(120);
		const { lastFrame } = render(
			React.createElement(MessageBlock, {
				message: {
					id: "msg-mcp-args",
					role: "tool_call",
					content: JSON.stringify([
						{
							type: "tool_use",
							id: "tu-mcp",
							name: "github",
							input: {
								subcommand: "issue_read",
								owner: "bound-agents",
								repo: "bound",
								body: bigValue,
							},
						},
					]),
					thread_id: "t-1",
					created_at: new Date().toISOString(),
				},
				terminalColumns: 200,
			}),
		);
		await tick();
		const frame = lastFrame() ?? "";
		expect(frame).toContain(`body=${"x".repeat(120)}`);
		expect(frame).not.toContain("...");
		// All four args render (old code capped at 3 entries).
		expect(frame).toContain("subcommand=issue_read");
		expect(frame).toContain("owner=bound-agents");
	});

	it("summarizes bms_edit as its file, not an edits JSON dump", async () => {
		const { lastFrame } = render(
			React.createElement(MessageBlock, {
				message: {
					id: "msg-bms-edit",
					role: "tool_call",
					content: JSON.stringify([
						{
							type: "tool_use",
							id: "tu-be",
							name: "bms_edit",
							input: {
								path: "/home/user/notes.md",
								edits: [{ start: "1:aaaa", end: "1:aaaa", content: "hello" }],
							},
						},
					]),
					thread_id: "t-1",
					created_at: new Date().toISOString(),
				},
				terminalColumns: 120,
			}),
		);
		await tick();
		const frame = lastFrame() ?? "";
		expect(frame).toContain("/home/user/notes.md");
		expect(frame).not.toContain("edits=");
	});
});

describe("clickable file paths (OSC 8)", () => {
	const ESC = "\u001B";
	const BEL = "\u0007";

	it("renders a read target as an OSC 8 file:// hyperlink, resolving relative paths against cwd", async () => {
		const { lastFrame } = render(
			React.createElement(MessageBlock, {
				message: {
					id: "msg-osc8-read",
					role: "tool_result",
					content: "1:aaaa|line 0\n2:bbbb|line 1",
					tool_name: "tu1",
					exit_code: 0,
					thread_id: "t-1",
					created_at: new Date().toISOString(),
				},
				toolName: "boundless_read",
				toolInput: { file_path: "packages/less/src/x.ts" },
				filePath: "packages/less/src/x.ts",
				terminalColumns: 120,
				cwd: "/repo",
			}),
		);
		await tick();
		const frame = lastFrame() ?? "";
		// Open envelope carries the resolved absolute file URI; label is the
		// (relative) display path; ` · N lines` stays outside the link.
		expect(frame).toContain(`${ESC}]8;;file:///repo/packages/less/src/x.ts${BEL}`);
		expect(frame).toContain("packages/less/src/x.ts");
		expect(frame).toContain("· 2 lines");
	});

	it("degrades to plain text when no cwd anchors a relative path", async () => {
		const { lastFrame } = render(
			React.createElement(MessageBlock, {
				message: {
					id: "msg-osc8-nocwd",
					role: "tool_result",
					content: "1:aaaa|x",
					tool_name: "tu1",
					exit_code: 0,
					thread_id: "t-1",
					created_at: new Date().toISOString(),
				},
				toolName: "boundless_read",
				toolInput: { file_path: "rel/x.ts" },
				filePath: "rel/x.ts",
				terminalColumns: 120,
			}),
		);
		await tick();
		const frame = lastFrame() ?? "";
		expect(frame).not.toContain(`${ESC}]8;;`);
		expect(frame).toContain("rel/x.ts");
	});
});

describe("image content blocks", () => {
	const createMessage = (overrides: { role: string; content: string }) =>
		({
			id: "msg-img",
			thread_id: "t-1",
			created_at: new Date().toISOString(),
			...overrides,
		}) as never;

	it("renders a cached half-block preview for a pasted image", async () => {
		const { storeImagePreview, clearImagePreviews } = await import("../tui/util/image-preview");
		clearImagePreviews();
		// Two fake preview rows — real ones are SGR-colored ▀ runs, but the
		// renderer treats them as opaque text lines either way.
		storeImagePreview("deadbeef", ["▀▀▀", "▀▀▀"]);
		const message = createMessage({
			role: "user",
			content: JSON.stringify([
				{ type: "text", text: "what do you see here?" },
				{
					type: "image",
					source: { type: "file_ref", file_id: "f1", media_type: "image/png" },
					description: "pasted image 640×480 · pv:deadbeef",
				},
			]),
		});
		const { lastFrame } = render(
			React.createElement(MessageBlock, { message, terminalColumns: 80 }),
		);
		const frame = lastFrame() ?? "";
		expect(frame).toContain("what do you see here?");
		expect(frame).toContain("▀▀▀");
		// Caption keeps the human-readable label, sheds the pv: key.
		expect(frame).toContain("[pasted image 640×480]");
		expect(frame).not.toContain("pv:deadbeef");
		clearImagePreviews();
	});

	it("renders a dim placeholder for a foreign image (no cached preview)", async () => {
		const { clearImagePreviews } = await import("../tui/util/image-preview");
		clearImagePreviews();
		const message = createMessage({
			role: "user",
			content: JSON.stringify([
				{
					type: "image",
					source: { type: "file_ref", file_id: "f2", media_type: "image/png" },
					description: "a discord attachment",
				},
			]),
		});
		const { lastFrame } = render(
			React.createElement(MessageBlock, { message, terminalColumns: 80 }),
		);
		const frame = lastFrame() ?? "";
		expect(frame).toContain("[a discord attachment]");
		expect(frame).not.toContain("▀");
	});

	it("renders an undescribed image block as a generic [image] marker", () => {
		const message = createMessage({
			role: "user",
			content: JSON.stringify([{ type: "image", source: { type: "file_ref", file_id: "f3" } }]),
		});
		const { lastFrame } = render(
			React.createElement(MessageBlock, { message, terminalColumns: 80 }),
		);
		expect(lastFrame() ?? "").toContain("[image]");
	});

	it("prefers the graphics escape over half-blocks when a payload is cached", async () => {
		const { storeImagePreview, storeImageGraphics, clearImagePreviews } = await import(
			"../tui/util/image-preview"
		);
		clearImagePreviews();
		// Both representations cached for the same hash: half-block lines AND a
		// graphics escape. Graphics must win.
		storeImagePreview("beef1234", ["HALFBLOCK-ROW"]);
		const sentinel = "<<KITTY-ESCAPE-SENTINEL>>";
		storeImageGraphics("beef1234", { escape: sentinel, rows: 4, cols: 20 });
		const message = createMessage({
			role: "user",
			content: JSON.stringify([
				{
					type: "image",
					source: { type: "file_ref", file_id: "f4", media_type: "image/png" },
					description: "pasted image 800×600 · pv:beef1234",
				},
			]),
		});
		const { lastFrame } = render(
			React.createElement(MessageBlock, { message, terminalColumns: 80 }),
		);
		const frame = lastFrame() ?? "";
		// Graphics escape present; half-block row suppressed.
		expect(frame).toContain(sentinel);
		expect(frame).not.toContain("HALFBLOCK-ROW");
		// Caption still rides underneath.
		expect(frame).toContain("[pasted image 800×600]");
		clearImagePreviews();
	});
});

describe("remote tag on collapsed one-line results (#215)", () => {
	const renderResult = (
		toolName: string,
		content: string,
		toolInput: Record<string, unknown>,
		filePath?: string,
	) =>
		render(
			React.createElement(MessageBlock, {
				message: {
					id: "msg-215",
					role: "tool_result",
					content,
					tool_name: "tu1",
					exit_code: 0,
					thread_id: "t-1",
					created_at: new Date().toISOString(),
				},
				toolName,
				toolInput,
				filePath,
				terminalColumns: 120,
			}),
		);

	it("tags a compact bms_read result line with [remote]", async () => {
		// Compact tools suppress the ⏵ call row, so this one line is the
		// invocation's whole committed footprint — without the tag here, a
		// remote read is indistinguishable from a local one (Kara's report).
		const { lastFrame } = renderResult(
			"bms_read",
			"1:aaaa|line one\n2:bbbb|line two",
			{ path: "/home/user/notes.md" },
			"/home/user/notes.md",
		);
		await tick();
		expect(lastFrame()).toContain("[remote] read");
	});

	it("tags a compact bms_search result line with [remote]", async () => {
		const { lastFrame } = renderResult(
			"bms_search",
			"src/x.ts:1:aaaa:match\n1 match in 1 file (10 files searched)",
			{ pattern: "dispatch" },
		);
		await tick();
		expect(lastFrame()).toContain("[remote] search");
	});

	it("tags a compact query result line with [remote]", async () => {
		const { lastFrame } = renderResult("query", "id\trole\n1\tuser", { sql: "SELECT 1" });
		await tick();
		expect(lastFrame()).toContain("[remote] query");
	});

	it("does not tag a compact boundless_read result line", async () => {
		const { lastFrame } = renderResult(
			"boundless_read",
			"1:aaaa|x",
			{ file_path: "/x/y.ts" },
			"/x/y.ts",
		);
		await tick();
		expect(lastFrame()).not.toContain("[remote]");
	});

	it("tags a collapsed bms_edit result line with [remote]", async () => {
		const { lastFrame } = renderResult(
			"bms_edit",
			"Edited /x/y.ts: applied 1 edit",
			{
				file_path: "/x/y.ts",
				edits: [{ start: "1:aaaa", end: "1:aaaa", content: "z" }],
			},
			"/x/y.ts",
		);
		await tick();
		expect(lastFrame()).toContain("[remote] edit");
	});

	it("does not tag a collapsed boundless_write result line", async () => {
		const { lastFrame } = renderResult(
			"boundless_write",
			"Wrote 1 line",
			{ file_path: "/x/y.ts", content: "z" },
			"/x/y.ts",
		);
		await tick();
		expect(lastFrame()).not.toContain("[remote]");
	});
});
