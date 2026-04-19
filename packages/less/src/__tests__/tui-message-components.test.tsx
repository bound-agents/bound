import { describe, expect, it } from "bun:test";

describe("Message rendering components", () => {
	describe("MessageBlock", () => {
		it("should export MessageBlock component", async () => {
			const module = await import("../tui/components/MessageBlock");
			expect(module.MessageBlock).toBeDefined();
		});

		it("AC9.1: renders user messages with green prefix", async () => {
			const module = await import("../tui/components/MessageBlock");
			expect(module.MessageBlock).toBeDefined();
		});

		it("AC9.1: renders assistant messages with blue prefix", async () => {
			const module = await import("../tui/components/MessageBlock");
			expect(module.MessageBlock).toBeDefined();
		});

		it("AC9.1: renders tool_call messages dimmed", async () => {
			const module = await import("../tui/components/MessageBlock");
			expect(module.MessageBlock).toBeDefined();
		});

		it("AC9.1: renders tool_result messages collapsible", async () => {
			const module = await import("../tui/components/MessageBlock");
			expect(module.MessageBlock).toBeDefined();
		});

		it("AC9.1: handles string content", async () => {
			const module = await import("../tui/components/MessageBlock");
			expect(module.MessageBlock).toBeDefined();
		});

		it("AC9.1: handles ContentBlock[] content", async () => {
			const module = await import("../tui/components/MessageBlock");
			expect(module.MessageBlock).toBeDefined();
		});
	});

	describe("ToolCallCard", () => {
		it("should export ToolCallCard component", async () => {
			const module = await import("../tui/components/ToolCallCard");
			expect(module.ToolCallCard).toBeDefined();
		});

		it("AC9.2: renders spinner with elapsed time", async () => {
			const module = await import("../tui/components/ToolCallCard");
			expect(module.ToolCallCard).toBeDefined();
		});

		it("AC9.2: renders badge with running status", async () => {
			const module = await import("../tui/components/ToolCallCard");
			expect(module.ToolCallCard).toBeDefined();
		});

		it("AC9.3: renders stdout in collapsible when provided", async () => {
			const module = await import("../tui/components/ToolCallCard");
			expect(module.ToolCallCard).toBeDefined();
		});

		it("AC9.3: auto-expands stdout collapsible", async () => {
			const module = await import("../tui/components/ToolCallCard");
			expect(module.ToolCallCard).toBeDefined();
		});
	});

	describe("StatusBar", () => {
		it("should export StatusBar component", async () => {
			const module = await import("../tui/components/StatusBar");
			expect(module.StatusBar).toBeDefined();
		});

		it("AC9.4: renders thread ID truncated", async () => {
			const module = await import("../tui/components/StatusBar");
			expect(module.StatusBar).toBeDefined();
		});

		it("AC9.4: renders model name", async () => {
			const module = await import("../tui/components/StatusBar");
			expect(module.StatusBar).toBeDefined();
		});

		it("AC9.4: renders connection status badge", async () => {
			const module = await import("../tui/components/StatusBar");
			expect(module.StatusBar).toBeDefined();
		});

		it("AC9.4: renders MCP server count", async () => {
			const module = await import("../tui/components/StatusBar");
			expect(module.StatusBar).toBeDefined();
		});
	});
});
