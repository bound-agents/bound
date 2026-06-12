import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import type { BoundClient } from "@bound/client";
import type { AppLogger } from "../logging";
import type { McpServerManager } from "../mcp/manager";
import type { TransitionDeps } from "../session/transition";
import { transitionThread } from "../session/transition";

type TransitionParams = Parameters<typeof transitionThread>[0];

/**
 * Test AC7.3 (/attach), AC7.4 (/clear), AC7.5 (rollback), AC7.6 (degraded mode).
 *
 * Uses dependency injection (TransitionParams.deps) instead of mock.module()
 * to avoid process-wide module cache pollution that leaks into registry.test.ts
 * and lockfile.test.ts on Linux CI.
 */
describe("transitionThread", () => {
	let mockClient: BoundClient;
	let mockMcpManager: McpServerManager;
	let mockLogger: AppLogger;
	let mockDeps: TransitionDeps;

	afterEach(() => {
		vi.restoreAllMocks();
	});

	beforeEach(() => {
		// Mock BoundClient
		mockClient = {
			unsubscribe: vi.fn(),
			subscribe: vi.fn(),
			createThread: vi.fn(async () => ({ id: "new-thread-id" })),
			getThread: vi.fn(async () => ({})),
			configureTools: vi.fn(),
			listMessages: vi.fn(async () => []),
		} as unknown as BoundClient;

		// Mock McpServerManager
		mockMcpManager = {
			ensureAllEnabled: vi.fn(),
			getServerStates: vi.fn(() => new Map()),
			getRunningTools: vi.fn(() => new Map()),
		} as unknown as McpServerManager;

		// Mock AppLogger
		mockLogger = {
			info: vi.fn(),
			error: vi.fn(),
		} as unknown as AppLogger;

		// Injectable deps — no mock.module needed
		mockDeps = {
			acquireLock: vi.fn(),
			releaseLock: vi.fn(),
			performAttach: vi.fn(async () => ({
				messages: [],
				pendingToolCallIds: [],
				mcpFailures: [],
			})),
		};
	});

	it("AC7.3: executes transition sequence for /attach", async () => {
		const params: TransitionParams = {
			client: mockClient,
			oldThreadId: "old-thread",
			newThreadId: "new-thread",
			configDir: "/config",
			cwd: "/home/user",
			hostname: "test-host",
			mcpManager: mockMcpManager,
			mcpConfigs: [],
			logger: mockLogger,
			inFlightTools: new Map(),
			sandbox: { enabled: false, writablePaths: [], network: "open", onUnavailable: "passthrough" },
			shell: {
				command: "sh",
				execFlag: "-c",
				toolName: "boundless_bash",
				label: "POSIX shell (sh)",
			},
			deps: mockDeps,
		};

		const result = await transitionThread(params);

		if (result.ok) {
			expect(result.threadId).toBe("new-thread");
		}

		// Verify sequence: unsubscribe -> release old -> acquire new -> getThread -> attach
		expect(mockClient.unsubscribe).toHaveBeenCalledWith("old-thread");
		expect(mockClient.getThread).toHaveBeenCalledWith("new-thread");
		expect(mockDeps.releaseLock).toHaveBeenCalledWith("/config", "old-thread");
		expect(mockDeps.acquireLock).toHaveBeenCalledWith("/config", "new-thread", "/home/user");
	});

	it("AC7.4: creates new thread for /clear", async () => {
		const params: TransitionParams = {
			client: mockClient,
			oldThreadId: "old-thread",
			newThreadId: null, // /clear action
			configDir: "/config",
			cwd: "/home/user",
			hostname: "test-host",
			mcpManager: mockMcpManager,
			mcpConfigs: [],
			logger: mockLogger,
			inFlightTools: new Map(),
			model: "claude-opus", // preserved
			sandbox: { enabled: false, writablePaths: [], network: "open", onUnavailable: "passthrough" },
			shell: {
				command: "sh",
				execFlag: "-c",
				toolName: "boundless_bash",
				label: "POSIX shell (sh)",
			},
			deps: mockDeps,
		};

		const result = await transitionThread(params);

		if (result.ok) {
			expect(result.threadId).toBe("new-thread-id");
		}

		expect(mockClient.createThread).toHaveBeenCalled();
	});

	it("AC7.5: drains in-flight tools before transition", async () => {
		const controller1 = new AbortController();
		const controller2 = new AbortController();

		vi.spyOn(controller1, "abort");
		vi.spyOn(controller2, "abort");

		const params: TransitionParams = {
			client: mockClient,
			oldThreadId: "old-thread",
			newThreadId: "new-thread",
			configDir: "/config",
			cwd: "/home/user",
			hostname: "test-host",
			mcpManager: mockMcpManager,
			mcpConfigs: [],
			logger: mockLogger,
			inFlightTools: new Map([
				["tool1", controller1],
				["tool2", controller2],
			]),
			sandbox: { enabled: false, writablePaths: [], network: "open", onUnavailable: "passthrough" },
			shell: {
				command: "sh",
				execFlag: "-c",
				toolName: "boundless_bash",
				label: "POSIX shell (sh)",
			},
			deps: mockDeps,
		};

		await transitionThread(params);

		expect(controller1.abort).toHaveBeenCalled();
		expect(controller2.abort).toHaveBeenCalled();
	});

	it("AC7.6: returns degraded=true when rollback fails", async () => {
		// acquireLock: succeeds for new thread, fails for old (degraded)
		(mockDeps.acquireLock as ReturnType<typeof vi.fn>).mockImplementation(
			(_configDir: string, threadId: string) => {
				if (threadId === "new-thread") {
					return;
				}
				throw new Error("EEXIST");
			},
		);

		// Make getThread fail to trigger rollback
		mockClient.getThread = vi.fn(async () => {
			throw new Error("Thread not found");
		});

		const params: TransitionParams = {
			client: mockClient,
			oldThreadId: "old-thread",
			newThreadId: "new-thread",
			configDir: "/config",
			cwd: "/home/user",
			hostname: "test-host",
			mcpManager: mockMcpManager,
			mcpConfigs: [],
			logger: mockLogger,
			inFlightTools: new Map(),
			sandbox: { enabled: false, writablePaths: [], network: "open", onUnavailable: "passthrough" },
			shell: {
				command: "sh",
				execFlag: "-c",
				toolName: "boundless_bash",
				label: "POSIX shell (sh)",
			},
			deps: mockDeps,
		};

		const result = await transitionThread(params);

		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.degraded).toBe(true);
			expect(result.error).toContain("degraded mode");
		}
	});

	it("returns degraded=false when rollback succeeds", async () => {
		// Make getThread fail to trigger rollback (which should succeed)
		mockClient.getThread = vi.fn(async () => {
			throw new Error("Thread not found");
		});

		const params: TransitionParams = {
			client: mockClient,
			oldThreadId: "old-thread",
			newThreadId: "new-thread",
			configDir: "/config",
			cwd: "/home/user",
			hostname: "test-host",
			mcpManager: mockMcpManager,
			mcpConfigs: [],
			logger: mockLogger,
			inFlightTools: new Map(),
			sandbox: { enabled: false, writablePaths: [], network: "open", onUnavailable: "passthrough" },
			shell: {
				command: "sh",
				execFlag: "-c",
				toolName: "boundless_bash",
				label: "POSIX shell (sh)",
			},
			deps: mockDeps,
		};

		const result = await transitionThread(params);

		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.degraded).toBe(false);
		}
	});
});
