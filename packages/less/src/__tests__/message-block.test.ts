import { describe, expect, it } from "bun:test";
import { render } from "ink-testing-library";
import React from "react";
import { MessageBlock } from "../tui/components/MessageBlock";

/** Let React effects flush */
const tick = () => new Promise((resolve) => setTimeout(resolve, 50));

describe("MessageBlock", () => {
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
			// the body cap (5 visual rows) as a head+tail split — 2 head rows,
			// …-marker, 3 tail rows — so the verdict lines at the END of build/test
			// output survive. 20 logical lines − 1 header = 19 body lines; lines
			// 2–3 and 18–20 visible, 14 omitted at the marker.
			expect(frame).toContain("line 1");
			expect(frame).toContain("line 3");
			expect(frame).not.toContain("line 7");
			expect(frame).toContain("line 18");
			expect(frame).toContain("line 20");
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
			// Head+tail split: header output 1; body outputs 2–12 → head 2–3,
			// tail 10–12, 6 omitted at the marker.
			expect(frame).toContain("output 1");
			expect(frame).toContain("output 3");
			expect(frame).not.toContain("output 7");
			expect(frame).toContain("output 10");
			expect(frame).toContain("output 12");
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
			// Should show first content line as header + head/tail body rows, not
			// blank lines. 10 content lines − 1 header = 9 body lines; head
			// content 2–3, tail content 8–10, 4 omitted at the marker.
			expect(frame).toContain("content 1");
			expect(frame).toContain("content 3");
			expect(frame).not.toContain("content 6");
			expect(frame).toContain("content 8");
			expect(frame).toContain("content 10");
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
		// Pretty-printed body lines, not the raw single-line blob. The 6-row
		// pretty body truncates head+tail (2+3): `{` + title visible at the
		// head, comments/body/`}` at the tail, state omitted at the marker —
		// which also pins the singular "1 more line" form.
		expect(frame).toContain('"title"');
		expect(frame).toContain('"comments": 12');
		expect(frame).toContain("… 1 more line");
		expect(frame).not.toContain("1 more lines");
		expect(frame).not.toContain('"state"');
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

	it("renders a ±diff stat on edit results computed from hashline anchors", async () => {
		// start 12 → end 14 = 3 lines out; 2 content lines in. Plus a
		// single-line replacement: 1 out, 1 in. Total +3 −4.
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
		expect(frame).toContain("−4");
	});
});

describe("edit preview removal headers", () => {
	it("wears the minus and removed-line count so the ±stat has a visible source", async () => {
		// Kara's report: the preview showed ONLY green + lines while the
		// result stat claimed −7 — the minus had no visible source. The
		// anchor header now carries it: `− 7:f872 → 13:5ede · 7 lines`.
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
		expect(frame).toContain("− 7:f872 → 13:5ede · 7 lines");
		expect(frame).not.toContain("@ 7:f872");
	});
});
