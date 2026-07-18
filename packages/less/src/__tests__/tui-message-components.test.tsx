import { describe, expect, it } from "bun:test";
import type { Message } from "@bound/shared";
import { render } from "ink-testing-library";
import { MessageBlock } from "../tui/components/MessageBlock";
import { StatusBar } from "../tui/components/StatusBar";
import { ToolCallCard } from "../tui/components/ToolCallCard";

describe("Message rendering components", () => {
	describe("MessageBlock", () => {
		it("AC9.1: renders user messages with role header", async () => {
			const message: Message = {
				id: "msg-1",
				thread_id: "thread-1",
				user_id: "user-1",
				role: "user",
				content: "Hello there",
				tool_name: null,
				created_at: "2024-01-01T00:00:00Z",
			};

			const { lastFrame } = render(<MessageBlock message={message} terminalColumns={120} />);
			const output = lastFrame();
			expect(output).toContain("you");
			expect(output).toContain("Hello there");
		});

		it("AC9.1: renders assistant messages with role header", async () => {
			const message: Message = {
				id: "msg-2",
				thread_id: "thread-1",
				user_id: "user-1",
				role: "assistant",
				content: "I can help",
				tool_name: null,
				created_at: "2024-01-01T00:00:00Z",
			};

			const { lastFrame } = render(<MessageBlock message={message} terminalColumns={120} />);
			const output = lastFrame();
			expect(output).toContain("agent");
			expect(output).toContain("I can help");
		});

		it("AC9.1: renders tool_call messages with ⏵ glyph and tool name", async () => {
			const message: Message = {
				id: "msg-3",
				thread_id: "thread-1",
				user_id: "user-1",
				role: "tool_call",
				content: '{"path": "/etc/passwd"}',
				tool_name: "read",
				created_at: "2024-01-01T00:00:00Z",
			};

			const { lastFrame } = render(<MessageBlock message={message} terminalColumns={120} />);
			const output = lastFrame();
			// Tool calls render as "⏵ <tool>: <content>" under the assistant stripe
			expect(output).toContain("⏵");
			expect(output).toContain("read");
		});

		it("AC9.1: renders tool_result with success indicator and content", async () => {
			const message: Message = {
				id: "msg-4",
				thread_id: "thread-1",
				user_id: "user-1",
				role: "tool_result",
				content: "file contents here",
				tool_name: "read",
				created_at: "2024-01-01T00:00:00Z",
			};

			const { lastFrame } = render(<MessageBlock message={message} terminalColumns={120} />);
			const output = lastFrame();
			// Tool results render as indented output with ✓/✗ indicator
			expect(output).toContain("✓");
			expect(output).toContain("file contents here");
		});

		it("AC9.1: handles string content", async () => {
			const message: Message = {
				id: "msg-5",
				thread_id: "thread-1",
				user_id: "user-1",
				role: "assistant",
				content: "simple string",
				tool_name: null,
				created_at: "2024-01-01T00:00:00Z",
			};

			const { lastFrame } = render(<MessageBlock message={message} terminalColumns={120} />);
			const output = lastFrame();
			expect(output).toContain("simple string");
		});

		it("AC9.1: handles ContentBlock[] content", async () => {
			const message: Message = {
				id: "msg-6",
				thread_id: "thread-1",
				user_id: "user-1",
				role: "assistant",
				content: JSON.stringify([{ type: "text", text: "block content" }]),
				tool_name: null,
				created_at: "2024-01-01T00:00:00Z",
			};

			const { lastFrame } = render(<MessageBlock message={message} terminalColumns={120} />);
			const output = lastFrame();
			expect(output).toContain("block content");
		});
	});

	describe("ToolCallCard", () => {
		it("AC9.2: renders spinner with elapsed time", async () => {
			const now = Date.now();
			const { lastFrame } = render(
				<ToolCallCard toolName="read" startTime={now - 2000} terminalColumns={80} />,
			);
			const output = lastFrame();
			expect(output).toContain("read");
			// Should show elapsed time in seconds
			expect(output).toMatch(/\ds\b/);
		});

		it("renders the args summary so parallel invocations are distinguishable", async () => {
			// With parallel call rows suppressed in the committed transcript, the
			// in-flight card is the only surface saying WHAT a running invocation
			// is working on — without it, three parallel reads are three
			// identical anonymous spinners.
			const { lastFrame } = render(
				<ToolCallCard
					toolName="boundless_read"
					startTime={Date.now()}
					argsSummary="~/x/ChatView.tsx"
					terminalColumns={80}
				/>,
			);
			const output = lastFrame();
			expect(output).toContain("read");
			expect(output).toContain("~/x/ChatView.tsx");
		});

		it("AC9.2: renders badge with running status", async () => {
			const now = Date.now();
			const { lastFrame } = render(
				<ToolCallCard toolName="bash" startTime={now} terminalColumns={80} />,
			);
			const output = lastFrame();
			expect(output).toContain("bash");
			// While running, a spinner glyph appears alongside elapsed time (e.g. "⠋ 0s bash").
			// The Badge component renders "running" as a green ● with no text label.
			expect(output).toMatch(/[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/);
		});

		it("AC9.3: renders stdout in collapsible when provided", async () => {
			const now = Date.now();
			const { lastFrame } = render(
				<ToolCallCard
					toolName="bash"
					startTime={now}
					stdout="$ echo hello\nhello"
					terminalColumns={80}
				/>,
			);
			const output = lastFrame();
			expect(output).toContain("Output");
			expect(output).toContain("hello");
		});

		it("AC9.3: auto-expands stdout collapsible", async () => {
			const now = Date.now();
			const { lastFrame } = render(
				<ToolCallCard
					toolName="bash"
					startTime={now}
					stdout="command output"
					terminalColumns={80}
				/>,
			);
			const output = lastFrame();
			// Auto-expanded means stdout content should be visible
			expect(output).toContain("command output");
		});
	});

	describe("StatusBar", () => {
		it("renders the full thread ID without truncation so operators can copy it", async () => {
			const fullId = "thread-12345678-very-long-id";
			const { lastFrame } = render(
				<StatusBar
					threadId={fullId}
					model="claude-opus"
					connectionState="connected"
					mcpServerCount={2}
					cwd="/tmp/work"
				/>,
			);
			const output = lastFrame() ?? "";
			expect(output).toContain(fullId);
			// The old truncation used "…" or "...". Neither should follow the id now.
			expect(output).not.toContain(`${fullId.slice(0, 12)}...`);
			expect(output).not.toMatch(/thread-12345678\s*\.{3}/);
		});

		it("AC9.4: renders model name", async () => {
			const { lastFrame } = render(
				<StatusBar
					threadId="thread-123"
					model="claude-opus"
					connectionState="connected"
					mcpServerCount={2}
					cwd="/tmp/work"
				/>,
			);
			const output = lastFrame();
			expect(output).toContain("claude-opus");
		});

		it("AC9.4: renders connection status badge", async () => {
			const { lastFrame } = render(
				<StatusBar
					threadId="thread-123"
					model="claude-opus"
					connectionState="connected"
					mcpServerCount={2}
					cwd="/tmp/work"
				/>,
			);
			const output = lastFrame();
			// StatusBar delegates to <Badge status="connected"/>, which renders a colored ●
			// glyph only — no text label. Presence of the glyph is the badge rendering.
			expect(output).toContain("●");
		});

		it("AC9.4: renders MCP server count", async () => {
			const { lastFrame } = render(
				<StatusBar
					threadId="thread-123"
					model="claude-opus"
					connectionState="connected"
					mcpServerCount={3}
					cwd="/tmp/work"
				/>,
			);
			const output = lastFrame();
			expect(output).toContain("3");
		});

		it("renders a short cwd label on the right", async () => {
			const { lastFrame } = render(
				<StatusBar
					threadId="thread-123"
					model="claude-opus"
					connectionState="connected"
					mcpServerCount={0}
					cwd="/Users/operator/Documents/GitHub/bound/packages/less"
				/>,
			);
			const output = lastFrame() ?? "";
			// Deep subdir collapses to last two segments — repo-leaf alone would be
			// ambiguous across repos, so "packages/less" is the high-signal form.
			expect(output).toContain("packages/less");
		});

		it("accepts and renders all three ConnectionState values", async () => {
			// Smoke test for the wire-through: prior to plumbing real ConnectionState,
			// only "connected" / "disconnected" were valid. "connecting" would have
			// been collapsed at the App boundary. We can't assert on the badge color
			// here because ink-testing-library's stdout isn't a TTY and chalk strips
			// ANSI codes — every state would render the same "●" glyph in plain text.
			// The visual mapping is covered by Badge's STATUS_COLORS table; the
			// transition behavior is covered by BoundClient's state-machine tests.
			const baseProps = {
				threadId: "thread-123",
				model: "claude-opus",
				mcpServerCount: 0,
				cwd: "/tmp/work",
			} as const;
			for (const state of ["connected", "connecting", "disconnected"] as const) {
				const { lastFrame } = render(<StatusBar {...baseProps} connectionState={state} />);
				const frame = lastFrame() ?? "";
				expect(frame).toContain("●");
				expect(frame).toContain("thread-123");
			}
		});
	});
});

describe("Session HUD", () => {
	describe("StatusBar hud segments", () => {
		const hud = {
			contextTokens: 87_000,
			contextWindow: 200_000,
			contextPct: 0.435,
			todayCostUsd: 12.34,
			sessionCostUsd: 1.05,
		};

		it("renders the context gauge and spend when the hud carries data", async () => {
			const { lastFrame } = render(
				<StatusBar
					threadId="t1"
					model="opus"
					connectionState="connected"
					mcpServerCount={0}
					cwd="/tmp/work"
					hud={hud}
				/>,
			);
			const frame = lastFrame() ?? "";
			expect(frame).toContain("ctx 44%");
			expect(frame).toContain("(87k/200k)");
			expect(frame).toContain("$1.05");
			expect(frame).toContain("$12.34 today");
		});

		it("hides HUD segments entirely when absent — no zeros pretending to be data", async () => {
			const { lastFrame } = render(
				<StatusBar
					threadId="t1"
					model="opus"
					connectionState="connected"
					mcpServerCount={0}
					cwd="/tmp/work"
				/>,
			);
			const frame = lastFrame() ?? "";
			expect(frame).not.toContain("ctx ");
			expect(frame).not.toContain("today");
		});

		it("hides the cost segment until BOTH windows have resolved", async () => {
			const { lastFrame } = render(
				<StatusBar
					threadId="t1"
					model="opus"
					connectionState="connected"
					mcpServerCount={0}
					cwd="/tmp/work"
					hud={{ ...hud, todayCostUsd: null }}
				/>,
			);
			const frame = lastFrame() ?? "";
			expect(frame).toContain("ctx 44%");
			expect(frame).not.toContain("today");
		});
	});
});
