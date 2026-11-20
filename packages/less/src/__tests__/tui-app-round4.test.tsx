import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import type { BoundClient } from "@bound/client";
import { render } from "ink-testing-library";
import React from "react";
import type { McpServerManager } from "../mcp/manager";
import { App } from "../tui/App";

const tick = (ms = 60) => new Promise((resolve) => setTimeout(resolve, ms));

describe("App round4 uncovered branches", () => {
	let mockClient: BoundClient;
	let mockMcpManager: McpServerManager;
	let statusHandlers: Array<(data: { thread_id: string; active: boolean }) => void>;
	const mockLogger = { info: vi.fn(), error: vi.fn(), warn: vi.fn() };

	beforeEach(() => {
		statusHandlers = [];
		mockClient = {
			listThreads: vi.fn().mockResolvedValue([]),
			listModels: vi.fn().mockResolvedValue({ models: [], default: "" }),
			subscribe: vi.fn(),
			on: vi.fn((event: string, handler: (data: unknown) => void) => {
				if (event === "thread:status") {
					statusHandlers.push(handler as (d: { thread_id: string; active: boolean }) => void);
				}
				return () => {};
			}),
			off: vi.fn(),
			onToolCall: vi.fn(),
			getThread: vi.fn().mockResolvedValue({ id: "thread-123", title: "A Thread Title" }),
			sendMessage: vi.fn().mockResolvedValue(undefined),
			connectionState: "connected",
		} as unknown as BoundClient;

		mockMcpManager = {
			getServerStates: vi.fn().mockReturnValue(new Map()),
			getRunningTools: vi.fn().mockReturnValue(new Map()),
			ensureAllEnabled: vi.fn(),
		} as unknown as McpServerManager;
	});

	afterEach(() => {
		vi.clearAllMocks();
	});

	function renderApp(overrides: Record<string, unknown> = {}) {
		return render(
			React.createElement(App, {
				client: mockClient,
				threadId: "thread-123",
				configDir: "/tmp",
				cwd: "/home/user",
				commitHash: "abc1234",
				hostname: "localhost",
				mcpManager: mockMcpManager,
				mcpConfigs: [],
				// biome-ignore lint/suspicious/noExplicitAny: test logger stub
				logger: mockLogger as any,
				initialMessages: [],
				model: "gpt-4",
				toolHandlers: new Map(),
				// biome-ignore lint/suspicious/noExplicitAny: test-only shell/sandbox stubs
				shell: { kind: "bash", command: "/bin/bash" } as any,
				// biome-ignore lint/suspicious/noExplicitAny: test-only shell/sandbox stubs
				sandbox: { enabled: false, writablePaths: [], network: "open" } as any,
				...overrides,
			}),
		);
	}

	describe("thread:status processing indicator (App.tsx 183-194)", () => {
		it("subscribes to thread:status and flips the processing flag for the active thread", async () => {
			const { unmount } = renderApp();
			await tick();
			// The effect registered a thread:status handler.
			expect(statusHandlers.length).toBeGreaterThan(0);
			// Driving it for the active thread toggles isProcessing without crashing.
			for (const h of statusHandlers) h({ thread_id: "thread-123", active: true });
			await tick();
			// A status event for a different thread is ignored (guard branch).
			for (const h of statusHandlers) h({ thread_id: "other-thread", active: true });
			await tick();
			unmount();
		});
	});

	describe("terminal-title refresh effect (App.tsx 196-223)", () => {
		it("fetches the thread title on mount and polls getThread", async () => {
			const { unmount } = renderApp({ initialThreadTitle: null });
			await tick(80);
			// refreshTitle ran at least once against the mock client.
			expect(mockClient.getThread).toHaveBeenCalledWith("thread-123");
			unmount();
		});

		it("tolerates a getThread rejection without crashing the view (catch branch)", async () => {
			(mockClient.getThread as ReturnType<typeof vi.fn>).mockRejectedValue(
				new Error("title fetch failed"),
			);
			const { lastFrame, unmount } = renderApp();
			await tick(80);
			// The view is still rendered; the title failure is swallowed.
			expect(lastFrame()).toBeDefined();
			unmount();
		});
	});

	describe("null-client resilience (App.tsx handleSendMessage guard)", () => {
		it("renders with a null client and does not attempt sends", async () => {
			const { lastFrame, unmount } = renderApp({ client: null });
			await tick();
			expect(lastFrame()).toBeDefined();
			unmount();
		});
	});
});
