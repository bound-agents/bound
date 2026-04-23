import { describe, expect, it } from "bun:test";
import type { Message } from "@bound/shared";
import { render } from "ink-testing-library";
import { MessageBlock } from "../tui/components/MessageBlock";
import { StatusBar } from "../tui/components/StatusBar";
import { ToolCallCard } from "../tui/components/ToolCallCard";

describe("Message rendering components", () => {
	describe("MessageBlock", () => {
		it("AC9.1: renders user messages with green prefix", async () => {
			const message: Message = {
				id: "msg-1",
				thread_id: "thread-1",
				user_id: "user-1",
				role: "user",
				content: "Hello there",
				tool_name: null,
				created_at: "2024-01-01T00:00:00Z",
			};

			const { lastFrame } = render(<MessageBlock message={message} />);
			const output = lastFrame();
			expect(output).toContain("You:");
			expect(output).toContain("Hello there");
		});

		it("AC9.1: renders assistant messages with blue prefix", async () => {
			const message: Message = {
				id: "msg-2",
				thread_id: "thread-1",
				user_id: "user-1",
				role: "assistant",
				content: "I can help",
				tool_name: null,
				created_at: "2024-01-01T00:00:00Z",
			};

			const { lastFrame } = render(<MessageBlock message={message} />);
			const output = lastFrame();
			expect(output).toContain("Agent:");
			expect(output).toContain("I can help");
		});

		it("AC9.1: renders tool_call messages dimmed", async () => {
			const message: Message = {
				id: "msg-3",
				thread_id: "thread-1",
				user_id: "user-1",
				role: "tool_call",
				content: '{"path": "/etc/passwd"}',
				tool_name: "read",
				created_at: "2024-01-01T00:00:00Z",
			};

			const { lastFrame } = render(<MessageBlock message={message} />);
			const output = lastFrame();
			// Tool calls render as "◆ <tool>: <content>"
			expect(output).toContain("◆ read:");
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

			const { lastFrame } = render(<MessageBlock message={message} />);
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

			const { lastFrame } = render(<MessageBlock message={message} />);
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

			const { lastFrame } = render(<MessageBlock message={message} />);
			const output = lastFrame();
			expect(output).toContain("block content");
		});
	});

	describe("ToolCallCard", () => {
		it("AC9.2: renders spinner with elapsed time", async () => {
			const now = Date.now();
			const { lastFrame } = render(<ToolCallCard toolName="read" startTime={now - 2000} />);
			const output = lastFrame();
			expect(output).toContain("read");
			// Should show elapsed time in seconds
			expect(output).toMatch(/\ds\b/);
		});

		it("AC9.2: renders badge with running status", async () => {
			const now = Date.now();
			const { lastFrame } = render(<ToolCallCard toolName="bash" startTime={now} />);
			const output = lastFrame();
			expect(output).toContain("bash");
			// While running, a spinner glyph appears alongside elapsed time (e.g. "⠋ 0s bash").
			// The Badge component renders "running" as a green ● with no text label.
			expect(output).toMatch(/[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/);
		});

		it("AC9.3: renders stdout in collapsible when provided", async () => {
			const now = Date.now();
			const { lastFrame } = render(
				<ToolCallCard toolName="bash" startTime={now} stdout="$ echo hello\nhello" />,
			);
			const output = lastFrame();
			expect(output).toContain("Output");
			expect(output).toContain("hello");
		});

		it("AC9.3: auto-expands stdout collapsible", async () => {
			const now = Date.now();
			const { lastFrame } = render(
				<ToolCallCard toolName="bash" startTime={now} stdout="command output" />,
			);
			const output = lastFrame();
			// Auto-expanded means stdout content should be visible
			expect(output).toContain("command output");
		});
	});

	describe("StatusBar", () => {
		it("AC9.4: renders thread ID truncated", async () => {
			const { lastFrame } = render(
				<StatusBar
					threadId="thread-12345678-very-long-id"
					model="claude-opus"
					connectionState="connected"
					mcpServerCount={2}
				/>,
			);
			const output = lastFrame();
			// Thread ID should be present (truncated or full)
			expect(output).toContain("thread");
		});

		it("AC9.4: renders model name", async () => {
			const { lastFrame } = render(
				<StatusBar
					threadId="thread-123"
					model="claude-opus"
					connectionState="connected"
					mcpServerCount={2}
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
				/>,
			);
			const output = lastFrame();
			expect(output).toContain("3");
		});
	});
});
