import { beforeEach, describe, expect, it, vi } from "bun:test";
import type { BoundClient } from "@bound/client";
import { render } from "ink-testing-library";
import React from "react";
import type { McpServerManager } from "../mcp/manager";
import { App } from "../tui/App";

describe("App Component", () => {
	let mockClient: BoundClient;
	let mockMcpManager: McpServerManager;
	const mockLogger = {
		info: vi.fn(),
		error: vi.fn(),
	};

	beforeEach(() => {
		mockClient = {
			listThreads: vi.fn().mockResolvedValue([]),
			listModels: vi.fn().mockResolvedValue([]),
			subscribe: vi.fn(),
			on: vi.fn().mockReturnValue(() => {}),
			off: vi.fn(),
			onToolCall: vi.fn(),
			sendMessage: vi.fn().mockResolvedValue(undefined),
		} as unknown as BoundClient;

		mockMcpManager = {
			getServerStates: vi.fn().mockReturnValue(new Map()),
			getRunningTools: vi.fn().mockReturnValue(new Map()),
			ensureAllEnabled: vi.fn(),
		} as unknown as McpServerManager;
	});

	it("should render with initial state", () => {
		const { lastFrame } = render(
			React.createElement(App, {
				client: mockClient,
				threadId: "thread-123",
				configDir: "/tmp",
				cwd: "/home/user",
				hostname: "localhost",
				mcpManager: mockMcpManager,
				mcpConfigs: [],
				// biome-ignore lint/suspicious/noExplicitAny: test setup pattern
				logger: mockLogger as any,
				initialMessages: [],
				model: "gpt-4",
				toolHandlers: new Map(),
			}),
		);

		const output = lastFrame();
		expect(output).toBeDefined();
	});

	it("should render ChatView by default", () => {
		const { lastFrame } = render(
			React.createElement(App, {
				client: mockClient,
				threadId: "thread-123",
				configDir: "/tmp",
				cwd: "/home/user",
				hostname: "localhost",
				mcpManager: mockMcpManager,
				mcpConfigs: [],
				// biome-ignore lint/suspicious/noExplicitAny: test setup pattern
				logger: mockLogger as any,
				initialMessages: [],
				model: "gpt-4",
				toolHandlers: new Map(),
			}),
		);

		const output = lastFrame();
		// ChatView should be rendered (contains status bar with thread/model info)
		expect(output).toContain("Thread");
		expect(output).toContain("gpt-4");
	});

	it("should render with multiple MCP servers configured", () => {
		const { lastFrame } = render(
			React.createElement(App, {
				client: mockClient,
				threadId: "thread-123",
				configDir: "/tmp",
				cwd: "/home/user",
				hostname: "localhost",
				mcpManager: mockMcpManager,
				mcpConfigs: [
					{ name: "github", transport: "stdio", command: "python", args: [] },
					{ name: "slack", transport: "stdio", command: "node", args: [] },
				],
				// biome-ignore lint/suspicious/noExplicitAny: test setup pattern
				logger: mockLogger as any,
				initialMessages: [],
				model: "claude-opus",
				toolHandlers: new Map(),
			}),
		);

		const output = lastFrame();
		expect(output).toBeDefined();
	});

	it("should render with initial messages", () => {
		const { lastFrame } = render(
			React.createElement(App, {
				client: mockClient,
				threadId: "thread-123",
				configDir: "/tmp",
				cwd: "/home/user",
				hostname: "localhost",
				mcpManager: mockMcpManager,
				mcpConfigs: [],
				// biome-ignore lint/suspicious/noExplicitAny: test setup pattern
				logger: mockLogger as any,
				initialMessages: [
					{
						id: "msg-1",
						role: "user",
						content: "Hello",
						threadId: "thread-123",
						createdAt: new Date(),
					},
					{
						id: "msg-2",
						role: "assistant",
						content: "Hi there",
						threadId: "thread-123",
						createdAt: new Date(),
					},
				],
				model: "gpt-4",
				toolHandlers: new Map(),
			}),
		);

		const output = lastFrame();
		expect(output).toContain("You:");
		expect(output).toContain("Hello");
		expect(output).toContain("Agent:");
		expect(output).toContain("Hi there");
	});

	it("should handle null client gracefully", () => {
		const { lastFrame } = render(
			React.createElement(App, {
				client: null,
				threadId: "thread-123",
				configDir: "/tmp",
				cwd: "/home/user",
				hostname: "localhost",
				mcpManager: mockMcpManager,
				mcpConfigs: [],
				// biome-ignore lint/suspicious/noExplicitAny: test setup pattern
				logger: mockLogger as any,
				initialMessages: [],
				model: null,
				toolHandlers: new Map(),
			}),
		);

		const output = lastFrame();
		// Should still render (disconnected state)
		expect(output).toBeDefined();
	});

	it("should render with model and thread info", () => {
		const { lastFrame } = render(
			React.createElement(App, {
				client: mockClient,
				threadId: "abc-def-ghi",
				configDir: "/tmp",
				cwd: "/home/user",
				hostname: "localhost",
				mcpManager: mockMcpManager,
				mcpConfigs: [],
				// biome-ignore lint/suspicious/noExplicitAny: test setup pattern
				logger: mockLogger as any,
				initialMessages: [],
				model: "claude-opus-v1",
				toolHandlers: new Map(),
			}),
		);

		const output = lastFrame();
		// Status bar should show model and thread
		expect(output).toContain("claude-opus");
		expect(output).toContain("Thread");
	});
});
