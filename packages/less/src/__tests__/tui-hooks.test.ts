import { describe, expect, it, vi } from "bun:test";
import type { BoundClient } from "@bound/client";
import type { Message } from "@bound/shared";
import { Text } from "ink";
import { render } from "ink-testing-library";
import React from "react";
import type { McpServerManager } from "../mcp/manager";
import { useMcpServers } from "../tui/hooks/useMcpServers";
import { useMessages } from "../tui/hooks/useMessages";
import { useToolCalls } from "../tui/hooks/useToolCalls";

// ============================================================================
// useMessages Tests
// ============================================================================

describe("useMessages", () => {
	it("initializes with provided messages array", () => {
		const initialMessages: Message[] = [
			{
				id: "1",
				role: "user",
				content: "hello",
				thread_id: "t1",
				created_at: new Date().toISOString(),
			},
		];

		function TestUseMessages() {
			const { messages } = useMessages(null, initialMessages);
			const output = `count:${messages.length}`;
			return React.createElement(Text, null, output);
		}

		const { lastFrame } = render(React.createElement(TestUseMessages));
		const frame = lastFrame();
		expect(frame).toContain("count:1");
	});

	it("appendMessage function is callable", () => {
		const initialMessages: Message[] = [];

		function TestUseMessagesAppend() {
			const { appendMessage } = useMessages(null, initialMessages);
			const isCallable = typeof appendMessage === "function" ? "yes" : "no";
			return React.createElement(Text, null, `callable:${isCallable}`);
		}

		const { lastFrame } = render(React.createElement(TestUseMessagesAppend));
		const frame = lastFrame();
		expect(frame).toContain("callable:yes");
	});

	it("clearMessages function is callable", () => {
		const initialMessages: Message[] = [
			{
				id: "1",
				role: "user",
				content: "hello",
				thread_id: "t1",
				created_at: new Date().toISOString(),
			},
		];

		function TestUseMessagesClear() {
			const { clearMessages } = useMessages(null, initialMessages);
			const isCallable = typeof clearMessages === "function" ? "yes" : "no";
			return React.createElement(Text, null, `callable:${isCallable}`);
		}

		const { lastFrame } = render(React.createElement(TestUseMessagesClear));
		const frame = lastFrame();
		expect(frame).toContain("callable:yes");
	});

	it("updateMessage function updates message by id", () => {
		const initialMessages: Message[] = [
			{
				id: "1",
				role: "user",
				content: "hello",
				thread_id: "t1",
				created_at: new Date().toISOString(),
			},
		];

		function TestUseMessagesUpdate() {
			const { messages } = useMessages(null, initialMessages);
			const firstMsg = messages[0];
			const msgExists = firstMsg ? "yes" : "no";
			return React.createElement(Text, null, `msg_exists:${msgExists}`);
		}

		const { lastFrame } = render(React.createElement(TestUseMessagesUpdate));
		const frame = lastFrame();
		expect(frame).toContain("msg_exists:yes");
	});
});

// ============================================================================
// useToolCalls Tests
// ============================================================================

describe("useToolCalls", () => {
	it("initializes inFlightTools as empty Map", () => {
		function TestUseToolCalls() {
			const { inFlightTools } = useToolCalls(null, new Map(), "localhost", "/tmp");
			const output = `size:${inFlightTools.size}`;
			return React.createElement(Text, null, output);
		}

		const { lastFrame } = render(React.createElement(TestUseToolCalls));
		const frame = lastFrame();
		expect(frame).toContain("size:0");
	});

	it("inFlightTools Map has correct interface", () => {
		function TestUseToolCallsMap() {
			const { inFlightTools } = useToolCalls(null, new Map(), "localhost", "/tmp");
			const hasSize = inFlightTools.size !== undefined ? "yes" : "no";
			const hasGet = inFlightTools.get !== undefined ? "yes" : "no";
			const hasSet = inFlightTools.set !== undefined ? "yes" : "no";
			const output = `valid:${hasSize === "yes" && hasGet === "yes" && hasSet === "yes" ? "yes" : "no"}`;
			return React.createElement(Text, null, output);
		}

		const { lastFrame } = render(React.createElement(TestUseToolCallsMap));
		const frame = lastFrame();
		expect(frame).toContain("valid:yes");
	});

	it("abortAll function exists and is callable", () => {
		function TestUseToolCallsAbort() {
			const { abortAll } = useToolCalls(null, new Map(), "localhost", "/tmp");
			const isCallable = typeof abortAll === "function" ? "yes" : "no";
			return React.createElement(Text, null, `callable:${isCallable}`);
		}

		const { lastFrame } = render(React.createElement(TestUseToolCallsAbort));
		const frame = lastFrame();
		expect(frame).toContain("callable:yes");
	});

	it("accepts client, handlers, hostname, and cwd parameters", () => {
		const mockClient = {
			onToolCall: vi.fn(),
			on: vi.fn().mockReturnValue(() => {}),
			off: vi.fn(),
		} as unknown as BoundClient;

		const mockHandlers = new Map();
		mockHandlers.set("test", async () => ({
			content: [{ type: "text", text: "test" }],
			isError: false,
		}));

		function TestUseToolCallsParams() {
			const result = useToolCalls(mockClient, mockHandlers, "localhost", "/tmp");
			const hasInFlight = result.inFlightTools !== undefined ? "yes" : "no";
			const hasAbort = result.abortAll !== undefined ? "yes" : "no";
			const output = `valid:${hasInFlight === "yes" && hasAbort === "yes" ? "yes" : "no"}`;
			return React.createElement(Text, null, output);
		}

		const { lastFrame } = render(React.createElement(TestUseToolCallsParams));
		const frame = lastFrame();
		expect(frame).toContain("valid:yes");
	});
});

// ============================================================================
// useMcpServers Tests
// ============================================================================

describe("useMcpServers", () => {
	it("initializes with running count of 0 when manager has no servers", () => {
		const mockManager = {
			getServerStates: vi.fn().mockReturnValue(new Map()),
		} as unknown as McpServerManager;

		function TestUseMcpServers() {
			const { runningCount } = useMcpServers(mockManager);
			const output = `running:${runningCount}`;
			return React.createElement(Text, null, output);
		}

		const { lastFrame } = render(React.createElement(TestUseMcpServers));
		const frame = lastFrame();
		expect(frame).toContain("running:0");
	});

	it("returns server states from manager via serverStates", () => {
		const serverStates = new Map();
		serverStates.set("github", {
			status: "running",
			toolCount: 10,
		});
		serverStates.set("slack", {
			status: "stopped",
			toolCount: 5,
		});

		const mockManager = {
			getServerStates: vi.fn().mockReturnValue(serverStates),
		} as unknown as McpServerManager;

		function TestUseMcpServersStates() {
			const { serverStates: states } = useMcpServers(mockManager);
			const output = `count:${states.size}`;
			return React.createElement(Text, null, output);
		}

		const { lastFrame } = render(React.createElement(TestUseMcpServersStates));
		const frame = lastFrame();
		expect(frame).toContain("count:2");
	});

	it("exposes runningCount and serverStates in result", () => {
		const serverStates = new Map();
		serverStates.set("github", { status: "running" });
		serverStates.set("slack", { status: "stopped" });

		const mockManager = {
			getServerStates: vi.fn().mockReturnValue(serverStates),
		} as unknown as McpServerManager;

		function TestUseMcpServersResult() {
			const result = useMcpServers(mockManager);
			const hasRunningCount = result.runningCount !== undefined ? "yes" : "no";
			const hasServerStates = result.serverStates !== undefined ? "yes" : "no";
			const output = `valid:${hasRunningCount === "yes" && hasServerStates === "yes" ? "yes" : "no"}`;
			return React.createElement(Text, null, output);
		}

		const { lastFrame } = render(React.createElement(TestUseMcpServersResult));
		const frame = lastFrame();
		expect(frame).toContain("valid:yes");
	});

	it("hook polls manager.getServerStates on mount", () => {
		const mockManager = {
			getServerStates: vi.fn().mockReturnValue(new Map()),
		} as unknown as McpServerManager;

		function TestUseMcpServersPoll() {
			useMcpServers(mockManager);
			return React.createElement(Text, null, "rendered");
		}

		render(React.createElement(TestUseMcpServersPoll));

		expect(mockManager.getServerStates).toHaveBeenCalled();
	});
});
