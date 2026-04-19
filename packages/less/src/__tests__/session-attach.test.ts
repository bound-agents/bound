import { beforeEach, describe, expect, it, vi } from "bun:test";
import type { BoundClient } from "@bound/client";
import type { Message } from "@bound/shared";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import type { McpServerConfig } from "../config";
import type { AppLogger } from "../logging";
import type { McpServerManager } from "../mcp/manager";
import { type AttachParams, performAttach } from "../session/attach";

/**
 * Test AC7.1 (ordered attach) and AC7.2 (pending tool calls).
 */
describe("performAttach", () => {
	let mockClient: BoundClient;
	let mockMcpManager: McpServerManager;
	let mockLogger: AppLogger;
	let callOrder: string[];

	beforeEach(() => {
		callOrder = [];

		// Mock BoundClient
		mockClient = {
			listMessages: vi.fn(async () => {
				callOrder.push("listMessages");
				return [
					{
						id: "msg1",
						thread_id: "thread1",
						role: "user",
						content: "hello",
						model_id: null,
						tool_name: null,
						created_at: "2026-04-18T00:00:00Z",
						modified_at: null,
						host_origin: "local",
					} as Message,
					{
						id: "msg2",
						thread_id: "thread1",
						role: "tool_call",
						content: "{}",
						model_id: null,
						tool_name: "call1",
						created_at: "2026-04-18T00:00:01Z",
						modified_at: null,
						host_origin: "local",
					} as Message,
					// Missing tool_result for call1 - this should be pending
					{
						id: "msg3",
						thread_id: "thread1",
						role: "tool_call",
						content: "{}",
						model_id: null,
						tool_name: "call2",
						created_at: "2026-04-18T00:00:02Z",
						modified_at: null,
						host_origin: "local",
					} as Message,
					{
						id: "msg4",
						thread_id: "thread1",
						role: "tool_result",
						content: "result2",
						model_id: null,
						tool_name: "call2",
						created_at: "2026-04-18T00:00:03Z",
						modified_at: null,
						host_origin: "local",
					} as Message,
				];
			}),
			subscribe: vi.fn(() => {
				callOrder.push("subscribe");
			}),
			configureTools: vi.fn(() => {
				callOrder.push("configureTools");
			}),
		} as unknown as BoundClient;

		// Mock McpServerManager
		mockMcpManager = {
			ensureAllEnabled: vi.fn(async () => {
				callOrder.push("ensureAllEnabled");
			}),
			getServerStates: vi.fn(() => {
				return new Map([
					[
						"server1",
						{
							config: { name: "server1", transport: "stdio" },
							status: "running",
							client: null,
							tools: [],
							error: null,
							transport: null,
						},
					],
					[
						"server2",
						{
							config: { name: "server2", transport: "stdio" },
							status: "failed",
							client: null,
							tools: [],
							error: "Connection failed",
							transport: null,
						},
					],
				]);
			}),
			getRunningTools: vi.fn(() => {
				return new Map([
					[
						"server1",
						{
							tools: [{ name: "tool1", description: "desc1" } as Tool],
							config: { name: "server1", transport: "stdio" } as McpServerConfig,
						},
					],
				]);
			}),
		} as unknown as McpServerManager;

		// Mock AppLogger
		mockLogger = {
			info: vi.fn(),
			error: vi.fn(),
		} as unknown as AppLogger;
	});

	it("AC7.1: executes attach steps in order", async () => {
		// Mock buildToolSet and buildSystemPromptAddition
		vi.mock("../tools/registry", () => ({
			buildToolSet: vi.fn(() => ({
				tools: [
					{
						type: "function",
						function: { name: "boundless_read", description: "read" },
					},
				],
				handlers: new Map(),
				toolNameMapping: new Map(),
			})),
			buildSystemPromptAddition: vi.fn(() => "System prompt addition"),
		}));

		const params: AttachParams = {
			client: mockClient,
			threadId: "thread1",
			mcpManager: mockMcpManager,
			mcpConfigs: [
				{ name: "server1", transport: "stdio" } as McpServerConfig,
				{ name: "server2", transport: "stdio" } as McpServerConfig,
			],
			cwd: "/home/test",
			hostname: "test-host",
			logger: mockLogger,
		};

		await performAttach(params);

		// Verify call order: listMessages -> subscribe -> ensureAllEnabled -> configureTools
		expect(callOrder).toEqual(["listMessages", "subscribe", "ensureAllEnabled", "configureTools"]);
	});

	it("AC7.2: identifies unpaired tool calls as pending", async () => {
		vi.mock("../tools/registry", () => ({
			buildToolSet: vi.fn(() => ({
				tools: [],
				handlers: new Map(),
				toolNameMapping: new Map(),
			})),
			buildSystemPromptAddition: vi.fn(() => ""),
		}));

		const params: AttachParams = {
			client: mockClient,
			threadId: "thread1",
			mcpManager: mockMcpManager,
			mcpConfigs: [],
			cwd: "/home/test",
			hostname: "test-host",
			logger: mockLogger,
		};

		const result = await performAttach(params);

		// call1 is unpaired (no tool_result), call2 has a result
		expect(result.pendingToolCallIds).toContain("call1");
		expect(result.pendingToolCallIds.length).toBe(1);
	});

	it("collects MCP failures as non-fatal", async () => {
		vi.mock("../tools/registry", () => ({
			buildToolSet: vi.fn(() => ({
				tools: [],
				handlers: new Map(),
				toolNameMapping: new Map(),
			})),
			buildSystemPromptAddition: vi.fn(() => ""),
		}));

		const params: AttachParams = {
			client: mockClient,
			threadId: "thread1",
			mcpManager: mockMcpManager,
			mcpConfigs: [
				{ name: "server1", transport: "stdio" } as McpServerConfig,
				{ name: "server2", transport: "stdio" } as McpServerConfig,
			],
			cwd: "/home/test",
			hostname: "test-host",
			logger: mockLogger,
		};

		const result = await performAttach(params);

		// server2 failed but should not throw
		expect(result.mcpFailures).toEqual([{ serverName: "server2", error: "Connection failed" }]);
	});

	it("returns messages and tool call IDs", async () => {
		vi.mock("../tools/registry", () => ({
			buildToolSet: vi.fn(() => ({
				tools: [],
				handlers: new Map(),
				toolNameMapping: new Map(),
			})),
			buildSystemPromptAddition: vi.fn(() => ""),
		}));

		const params: AttachParams = {
			client: mockClient,
			threadId: "thread1",
			mcpManager: mockMcpManager,
			mcpConfigs: [],
			cwd: "/home/test",
			hostname: "test-host",
			logger: mockLogger,
		};

		const result = await performAttach(params);

		expect(result.messages.length).toBeGreaterThan(0);
		expect(result.messages[0].role).toBe("user");
	});
});
