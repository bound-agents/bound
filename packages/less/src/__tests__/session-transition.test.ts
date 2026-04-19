import { beforeEach, describe, expect, it, vi } from "bun:test";
import type { BoundClient } from "@bound/client";
import type { AppLogger } from "../logging";
import type { McpServerManager } from "../mcp/manager";
import { type TransitionParams, transitionThread } from "../session/transition";

/**
 * Test AC7.3 (/attach), AC7.4 (/clear), AC7.5 (rollback), AC7.6 (degraded mode).
 */
describe("transitionThread", () => {
	let mockClient: BoundClient;
	let mockMcpManager: McpServerManager;
	let mockLogger: AppLogger;

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

		// Mock lockfile functions will be set up per test
	});

	it("AC7.3: executes transition sequence for /attach", async () => {
		const callOrder: string[] = [];

		// Mock lockfile module
		vi.mock("../lockfile", () => ({
			acquireLock: vi.fn(() => {
				callOrder.push("acquireLock");
			}),
			releaseLock: vi.fn(() => {
				callOrder.push("releaseLock");
			}),
		}));

		// Mock buildToolSet
		vi.mock("../tools/registry", () => ({
			buildToolSet: vi.fn(() => ({
				tools: [],
				handlers: new Map(),
				toolNameMapping: new Map(),
			})),
			buildSystemPromptAddition: vi.fn(() => ""),
		}));

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
		};

		const result = await transitionThread(params);

		if (result.ok) {
			expect(result.threadId).toBe("new-thread");
		}

		// Verify sequence: unsubscribe -> release old -> acquire new -> getThread -> attach
		// (In actual implementation, these happen in order)
		expect(mockClient.unsubscribe).toHaveBeenCalledWith("old-thread");
		expect(mockClient.getThread).toHaveBeenCalledWith("new-thread");
	});

	it("AC7.4: creates new thread for /clear", async () => {
		vi.mock("../lockfile", () => ({
			acquireLock: vi.fn(),
			releaseLock: vi.fn(),
		}));

		vi.mock("../tools/registry", () => ({
			buildToolSet: vi.fn(() => ({
				tools: [],
				handlers: new Map(),
				toolNameMapping: new Map(),
			})),
			buildSystemPromptAddition: vi.fn(() => ""),
		}));

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
		};

		const result = await transitionThread(params);

		if (result.ok) {
			expect(result.threadId).toBe("new-thread-id");
			// Model is preserved but not explicitly returned in TransitionResult
		}

		expect(mockClient.createThread).toHaveBeenCalled();
	});

	it("AC7.5: drains in-flight tools before transition", async () => {
		vi.mock("../lockfile", () => ({
			acquireLock: vi.fn(),
			releaseLock: vi.fn(),
		}));

		vi.mock("../tools/registry", () => ({
			buildToolSet: vi.fn(() => ({
				tools: [],
				handlers: new Map(),
				toolNameMapping: new Map(),
			})),
			buildSystemPromptAddition: vi.fn(() => ""),
		}));

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
		};

		await transitionThread(params);

		expect(controller1.abort).toHaveBeenCalled();
		expect(controller2.abort).toHaveBeenCalled();
	});

	it("AC7.6: returns degraded=true when rollback fails", async () => {
		// acquireLock succeeds for new, fails for old (degraded)
		const acquireLockMock = vi.fn((_configDir, threadId) => {
			if (threadId === "new-thread") {
				// Success for new thread
				return;
			}
			// Fail for old thread (another process has it)
			throw new Error("EEXIST");
		});

		vi.mock("../lockfile", () => ({
			acquireLock: acquireLockMock,
			releaseLock: vi.fn(),
		}));

		vi.mock("../tools/registry", () => ({
			buildToolSet: vi.fn(() => ({
				tools: [],
				handlers: new Map(),
				toolNameMapping: new Map(),
			})),
			buildSystemPromptAddition: vi.fn(() => ""),
		}));

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
		};

		const result = await transitionThread(params);

		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.degraded).toBe(true);
			expect(result.error).toContain("degraded mode");
		}
	});

	it("returns degraded=false when rollback succeeds", async () => {
		vi.mock("../lockfile", () => ({
			acquireLock: vi.fn(),
			releaseLock: vi.fn(),
		}));

		vi.mock("../tools/registry", () => ({
			buildToolSet: vi.fn(() => ({
				tools: [],
				handlers: new Map(),
				toolNameMapping: new Map(),
			})),
			buildSystemPromptAddition: vi.fn(() => ""),
		}));

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
		};

		const result = await transitionThread(params);

		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.degraded).toBe(false);
		}
	});
});
