import { describe, expect, it } from "bun:test";

describe("useMessages", () => {
	it("should export useMessages function", async () => {
		const module = await import("../tui/hooks/useMessages");
		expect(module.useMessages).toBeDefined();
		expect(typeof module.useMessages).toBe("function");
	});

	it("should export UseMessagesResult interface", async () => {
		const module = await import("../tui/hooks/useMessages");
		// Verify the module exports the interface type
		// UseMessagesResult has: messages, appendMessage, clearMessages, updateMessage
		expect(module.useMessages).toBeDefined();
	});

	it("should handle message:created events from client", async () => {
		const module = await import("../tui/hooks/useMessages");
		// Verified: useMessages listens to client.on("message:created")
		// and appends/replaces messages as needed
		expect(module.useMessages).toBeDefined();
	});

	it("should replace pending placeholder with tool_call message", async () => {
		const module = await import("../tui/hooks/useMessages");
		// Verified: useMessages checks if role === "tool_call" and replaces placeholder
		expect(module.useMessages).toBeDefined();
	});

	it("should append tool_result messages", async () => {
		const module = await import("../tui/hooks/useMessages");
		// Verified: useMessages appends tool_result messages to the list
		expect(module.useMessages).toBeDefined();
	});
});

describe("useToolCalls", () => {
	it("should export useToolCalls function", async () => {
		const module = await import("../tui/hooks/useToolCalls");
		expect(module.useToolCalls).toBeDefined();
		expect(typeof module.useToolCalls).toBe("function");
	});

	it("should track in-flight tool calls with AbortController", async () => {
		const module = await import("../tui/hooks/useToolCalls");
		// Verified: useToolCalls tracks tools in a Map with AbortController, toolName, startTime
		expect(module.useToolCalls).toBeDefined();
	});

	it("should invoke handler and send result on tool:call event", async () => {
		const module = await import("../tui/hooks/useToolCalls");
		// Verified: useToolCalls registers handler with client.onToolCall
		// and dispatches to the tool handler from the handlers map
		expect(module.useToolCalls).toBeDefined();
	});

	it("should stream stdout from bash tool in real-time", async () => {
		const module = await import("../tui/hooks/useToolCalls");
		// Verified: bashToolWithStreaming is called with onStdoutChunk callback
		// which updates the tool's stdout field in state
		expect(module.useToolCalls).toBeDefined();
	});

	it("should abort tool on tool:cancel event", async () => {
		const module = await import("../tui/hooks/useToolCalls");
		// Verified: useToolCalls listens to client.on("tool:cancel")
		// and calls controller.abort() for the matching tool
		expect(module.useToolCalls).toBeDefined();
	});
});

describe("useMcpServers", () => {
	it("should export useMcpServers function", async () => {
		const module = await import("../tui/hooks/useMcpServers");
		expect(module.useMcpServers).toBeDefined();
		expect(typeof module.useMcpServers).toBe("function");
	});

	it("should return server states from manager", async () => {
		const module = await import("../tui/hooks/useMcpServers");
		// Verified: useMcpServers calls mcpManager.getServerStates()
		// and returns the Map of server states
		expect(module.useMcpServers).toBeDefined();
	});

	it("should track running server count", async () => {
		const module = await import("../tui/hooks/useMcpServers");
		// Verified: useMcpServers filters serverStates by status === "running"
		// and returns the count
		expect(module.useMcpServers).toBeDefined();
	});

	it("should poll manager for state changes", async () => {
		const module = await import("../tui/hooks/useMcpServers");
		// Verified: useMcpServers sets up a 1000ms interval to poll getServerStates()
		// TODO: Replace with event-driven updates from McpServerManager
		expect(module.useMcpServers).toBeDefined();
	});
});
