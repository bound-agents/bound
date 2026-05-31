import type { Database } from "bun:sqlite";
import DatabaseModule from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { randomBytes } from "node:crypto";
import { applySchema, insertRow } from "@bound/core";
import type { TypedEventEmitter } from "@bound/shared";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { z } from "zod";

import type { PlatformRegisteredTool } from "../mcp-registry";
import { PlatformMcpRegistry } from "../mcp-registry";

// Simple mock logger
const mockLogger = {
	debug: () => {},
	info: () => {},
	warn: () => {},
	error: () => {},
};

// Simple event bus for testing
class SimpleEventBus {
	private listeners = new Map<string, Set<(payload: unknown) => void>>();

	on<K extends string>(event: K, handler: (payload: unknown) => void): void {
		if (!this.listeners.has(event)) {
			this.listeners.set(event, new Set());
		}
		this.listeners.get(event)?.add(handler);
	}

	emit<K extends string>(event: K, payload: unknown): void {
		const handlers = this.listeners.get(event);
		if (handlers) {
			for (const handler of handlers) {
				handler(payload);
			}
		}
	}

	off<K extends string>(event: K, handler: (payload: unknown) => void): void {
		const handlers = this.listeners.get(event);
		if (handlers) {
			handlers.delete(handler);
		}
	}
}

/**
 * Creates a mock MCP server for testing tool discovery and execution.
 */
async function createMockMcpServer(
	tools: {
		name: string;
		description: string;
		inputSchema?: Record<string, unknown>;
		annotations?: {
			readOnlyHint?: boolean;
			destructiveHint?: boolean;
			idempotentHint?: boolean;
			openWorldHint?: boolean;
		};
	}[],
	instructions?: string,
): Promise<Server> {
	const server = new Server(
		{
			name: "test-server",
			version: "1.0.0",
		},
		instructions ? { instructions } : undefined,
	);

	// Define request schema for tools/list
	const listToolsSchema = z.object({
		method: z.literal("tools/list"),
	});

	// Define request schema for tools/call - using proper MCP schema structure
	const callToolSchema = z.object({
		method: z.literal("tools/call"),
		params: z.object({
			name: z.string(),
			arguments: z.record(z.string(), z.unknown()).optional(),
		}),
	});

	// Manually set capabilities after server creation
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	(server as any)._capabilities = {
		tools: {},
	};

	// Add handler for tools/list
	await server.setRequestHandler(listToolsSchema, async () => ({
		tools: tools.map((t) => ({
			name: t.name,
			description: t.description,
			inputSchema: t.inputSchema ?? { type: "object", properties: {} },
			annotations: t.annotations,
		})),
	}));

	// Add handler for tools/call
	await server.setRequestHandler(callToolSchema, async (_request) => ({
		content: [{ type: "text", text: "Called tool" }],
		isError: false,
	}));

	return server;
}

describe("Tool Scoping Integration", () => {
	let db: Database.Database;
	let registry: PlatformMcpRegistry;
	let siteId: string;
	let eventBus: SimpleEventBus;

	beforeEach(() => {
		const dbPath = ":memory:";
		db = new DatabaseModule(dbPath);
		applySchema(db);

		siteId = `test-site-${randomBytes(4).toString("hex")}`;
		eventBus = new SimpleEventBus();

		registry = new PlatformMcpRegistry({
			db,
			siteId,
			eventBus: eventBus as unknown as TypedEventEmitter,
			logger: mockLogger,
		});
	});

	afterEach(() => {
		db.close();
	});

	it("AC2.6: discovers tools and executes via proxy closure", async () => {
		// Create mock server with tools
		const mockServer = await createMockMcpServer([
			{ name: "send_message", description: "Send a message" },
			{ name: "delete_message", description: "Delete a message" },
		]);

		// Register server and discover tools
		const entry = await registry.registerServer("discord", mockServer);
		expect(entry.name).toBe("discord");

		// Verify tools were discovered
		const tools = registry.getToolsForServer("discord");
		expect(tools.size).toBe(2);
		expect(tools.has("send_message")).toBe(true);
		expect(tools.has("delete_message")).toBe(true);

		// Verify tool definition structure
		const sendTool = tools.get("send_message");
		expect(sendTool?.kind).toBe("platform");
		expect(sendTool?.toolDefinition.type).toBe("function");
		expect(sendTool?.toolDefinition.function.name).toBe("send_message");

		// Verify execute closure exists (proxy functionality)
		expect(sendTool?.execute).toBeDefined();
		expect(typeof sendTool?.execute).toBe("function");

		// Verify the tool is callable (testing proxy exists without full MCP exchange)
		const result = await sendTool?.execute?.({ channel_id: "123", content: "hello" });
		expect(result).toBe("Called tool");
	});

	it("AC3.1: event task thread receives tools only from its bound connector", async () => {
		// Create two mock servers
		const discordServer = await createMockMcpServer([
			{ name: "discord_send", description: "Send to Discord" },
		]);
		const slackServer = await createMockMcpServer([
			{ name: "slack_send", description: "Send to Slack" },
		]);

		await registry.registerServer("discord", discordServer);
		await registry.registerServer("slack", slackServer);

		// Create thread with event task
		const threadId = "thread-1";
		const taskId = "task-1";
		insertRow(
			db,
			"tasks",
			{
				id: taskId,
				type: "event",
				thread_id: threadId,
				status: "running",
				created_at: new Date().toISOString(),
				modified_at: new Date().toISOString(),
				deleted: 0,
				trigger_spec: "",
				payload: null,
				last_run_at: null,
				next_run_at: null,
				consecutive_failures: 0,
				alert_threshold: 3,
			},
			siteId,
		);

		// Create thread
		insertRow(
			db,
			"threads",
			{
				id: threadId,
				user_id: "user-1",
				host_origin: siteId,
				title: "test",
				created_at: new Date().toISOString(),
				modified_at: new Date().toISOString(),
				last_message_at: new Date().toISOString(),
				deleted: 0,
				interface: "web",
				summary: null,
			},
			siteId,
		);

		// Create connector handle for Discord only
		const handleId = "handle-1";
		insertRow(
			db,
			"connector_handles",
			{
				id: handleId,
				task_id: taskId,
				server_name: "discord",
				event_name: "message",
				event_args: "{}",
				delivery_mode: "poll",
				created_at: new Date().toISOString(),
				modified_at: new Date().toISOString(),
				deleted: 0,
				cursor: null,
			},
			siteId,
		);

		// Query tools for thread
		const tools = registry.getToolsForThread(threadId);

		// Should only get Discord tools
		expect(tools.size).toBe(1);
		expect(tools.has("discord_send")).toBe(true);
		expect(tools.has("slack_send")).toBe(false);
	});

	it("AC3.3: thread with no event task receives no tools", async () => {
		// Create a thread with no event task
		const threadId = "orphan-thread";
		insertRow(
			db,
			"threads",
			{
				id: threadId,
				user_id: "user-1",
				host_origin: siteId,
				title: "orphan",
				created_at: new Date().toISOString(),
				modified_at: new Date().toISOString(),
				last_message_at: new Date().toISOString(),
				deleted: 0,
				interface: "web",
				summary: null,
			},
			siteId,
		);

		// Query tools for thread
		const tools = registry.getToolsForThread(threadId);

		// Should return empty
		expect(tools.size).toBe(0);
	});

	it("AC3.3: event task thread with no connector handle receives no tools", async () => {
		// Create event task with no connector handle
		const threadId = "thread-2";
		const taskId = "task-2";
		insertRow(
			db,
			"tasks",
			{
				id: taskId,
				type: "event",
				thread_id: threadId,
				status: "running",
				created_at: new Date().toISOString(),
				modified_at: new Date().toISOString(),
				deleted: 0,
				trigger_spec: "",
				payload: null,
				last_run_at: null,
				next_run_at: null,
				consecutive_failures: 0,
				alert_threshold: 3,
			},
			siteId,
		);

		// Create thread
		insertRow(
			db,
			"threads",
			{
				id: threadId,
				user_id: "user-1",
				host_origin: siteId,
				title: "test",
				created_at: new Date().toISOString(),
				modified_at: new Date().toISOString(),
				last_message_at: new Date().toISOString(),
				deleted: 0,
				interface: "web",
				summary: null,
			},
			siteId,
		);

		// Query tools for thread (no connector handle)
		const tools = registry.getToolsForThread(threadId);

		// Should return empty
		expect(tools.size).toBe(0);
	});

	it("AC3.4: resolves through thread → task → handle → server chain", async () => {
		// Create mock server
		const mockServer = await createMockMcpServer([
			{ name: "channel_list", description: "List channels" },
		]);
		await registry.registerServer("discord", mockServer);

		// Full chain setup
		const threadId = "thread-3";
		const taskId = "task-3";
		const handleId = "handle-3";

		// Create thread
		insertRow(
			db,
			"threads",
			{
				id: threadId,
				user_id: "user-1",
				host_origin: siteId,
				title: "test",
				created_at: new Date().toISOString(),
				modified_at: new Date().toISOString(),
				last_message_at: new Date().toISOString(),
				deleted: 0,
				interface: "web",
				summary: null,
			},
			siteId,
		);

		// Create event task
		insertRow(
			db,
			"tasks",
			{
				id: taskId,
				type: "event",
				thread_id: threadId,
				status: "running",
				created_at: new Date().toISOString(),
				modified_at: new Date().toISOString(),
				deleted: 0,
				trigger_spec: "",
				payload: null,
				last_run_at: null,
				next_run_at: null,
				consecutive_failures: 0,
				alert_threshold: 3,
			},
			siteId,
		);

		// Create connector handle (final link in chain)
		insertRow(
			db,
			"connector_handles",
			{
				id: handleId,
				task_id: taskId,
				server_name: "discord",
				event_name: "message",
				event_args: "{}",
				delivery_mode: "poll",
				created_at: new Date().toISOString(),
				modified_at: new Date().toISOString(),
				deleted: 0,
				cursor: null,
			},
			siteId,
		);

		// Resolve through chain
		const tools = registry.getToolsForThread(threadId);

		// Should resolve correctly
		expect(tools.size).toBe(1);
		expect(tools.has("channel_list")).toBe(true);
	});

	it("AC3.4: user-facing thread receives read-only tools + connector tool", async () => {
		// Create mock server with read-only and write tools
		const mockServer = await createMockMcpServer([
			{
				name: "discord_list_channels",
				description: "List channels (read-only)",
				annotations: { readOnlyHint: true },
			},
			{
				name: "discord_send_message",
				description: "Send message (write)",
				annotations: undefined,
			},
		]);
		await registry.registerServer("discord", mockServer);

		// Create a user-facing thread (no connector handle)
		const threadId = "user-thread-1";
		insertRow(
			db,
			"threads",
			{
				id: threadId,
				user_id: "user-1",
				host_origin: siteId,
				title: "user chat",
				created_at: new Date().toISOString(),
				modified_at: new Date().toISOString(),
				last_message_at: new Date().toISOString(),
				deleted: 0,
				interface: "web",
				summary: null,
			},
			siteId,
		);

		// Create a mock connector tool (adapted to PlatformRegisteredTool)
		const mockConnectorTool: PlatformRegisteredTool = {
			kind: "platform" as const,
			toolDefinition: {
				type: "function" as const,
				function: {
					name: "connector",
					description: "Unified connector tool",
					parameters: {
						type: "object" as const,
						properties: {},
					},
				},
			},
			execute: async () => "mock connector response",
		};

		// Construct the resolver logic (mirrors scheduler.ts platformToolResolver)
		function resolverUnderTest(testThreadId: string): PlatformRegisteredTool[] {
			const scopedTools = registry.getToolsForThread(testThreadId);
			if (scopedTools.size > 0) {
				return Array.from(scopedTools.values());
			}
			const readOnlyTools = Array.from(registry.getReadOnlyPlatformTools().values());
			if (mockConnectorTool) {
				return [...readOnlyTools, mockConnectorTool];
			}
			return readOnlyTools;
		}

		// Call resolver with user-facing thread ID
		const resolvedTools = resolverUnderTest(threadId);

		// Verify read-only tools are present
		expect(resolvedTools.length).toBeGreaterThan(0);
		expect(
			resolvedTools.some((t) => t.toolDefinition.function.name === "discord_list_channels"),
		).toBe(true);

		// Verify write tools are NOT in resolved set
		expect(
			resolvedTools.some((t) => t.toolDefinition.function.name === "discord_send_message"),
		).toBe(false);

		// Verify connector tool IS present
		expect(resolvedTools.some((t) => t.toolDefinition.function.name === "connector")).toBe(true);
	});

	it("AC3.5: user-facing thread does NOT receive write tools", async () => {
		// Create mock server with mixed tools
		const mockServer = await createMockMcpServer([
			{
				name: "discord_list_channels",
				description: "List channels",
				annotations: { readOnlyHint: true },
			},
			{
				name: "discord_send_message",
				description: "Send message",
				annotations: undefined,
			},
			{
				name: "discord_respond_interaction",
				description: "Respond to interaction",
				annotations: undefined,
			},
		]);
		await registry.registerServer("discord", mockServer);

		// User-facing thread receives read-only tools only
		const readOnlyTools = Array.from(registry.getReadOnlyPlatformTools().values());

		// Verify NO write tools in read-only set
		expect(
			readOnlyTools.some((t) => t.toolDefinition.function.name === "discord_send_message"),
		).toBe(false);
		expect(
			readOnlyTools.some((t) => t.toolDefinition.function.name === "discord_respond_interaction"),
		).toBe(false);

		// Only read-only should be present
		expect(
			readOnlyTools.some((t) => t.toolDefinition.function.name === "discord_list_channels"),
		).toBe(true);
	});

	it("AC4.1: event task thread receives ALL tools from its bound server", async () => {
		// Create mock server with both read-only and write tools
		const mockServer = await createMockMcpServer([
			{
				name: "discord_list_channels",
				description: "List channels",
				annotations: { readOnlyHint: true },
			},
			{
				name: "discord_send_message",
				description: "Send message",
				annotations: undefined,
			},
		]);
		await registry.registerServer("discord", mockServer);

		// Create event task thread with connector handle
		const threadId = "event-thread-1";
		const taskId = "event-task-1";
		const handleId = "handle-event-1";

		insertRow(
			db,
			"threads",
			{
				id: threadId,
				user_id: "user-1",
				host_origin: siteId,
				title: "event",
				created_at: new Date().toISOString(),
				modified_at: new Date().toISOString(),
				last_message_at: new Date().toISOString(),
				deleted: 0,
				interface: "web",
				summary: null,
			},
			siteId,
		);

		insertRow(
			db,
			"tasks",
			{
				id: taskId,
				type: "event",
				thread_id: threadId,
				status: "running",
				created_at: new Date().toISOString(),
				modified_at: new Date().toISOString(),
				deleted: 0,
				trigger_spec: "",
				payload: null,
				last_run_at: null,
				next_run_at: null,
				consecutive_failures: 0,
				alert_threshold: 3,
			},
			siteId,
		);

		insertRow(
			db,
			"connector_handles",
			{
				id: handleId,
				task_id: taskId,
				server_name: "discord",
				event_name: "message",
				event_args: "{}",
				delivery_mode: "poll",
				created_at: new Date().toISOString(),
				modified_at: new Date().toISOString(),
				deleted: 0,
				cursor: null,
			},
			siteId,
		);

		// Query scoped tools for event thread
		const scopedTools = registry.getToolsForThread(threadId);

		// Should get ALL tools (both read-only and write)
		expect(scopedTools.size).toBeGreaterThanOrEqual(2);
		expect(scopedTools.has("discord_list_channels")).toBe(true);
		expect(scopedTools.has("discord_send_message")).toBe(true);
	});

	it("AC4.2: event task thread does NOT receive connector tool or other server tools", async () => {
		// Create two mock servers
		const discordServer = await createMockMcpServer([
			{
				name: "discord_list",
				description: "List channels",
				annotations: { readOnlyHint: true },
			},
		]);
		const slackServer = await createMockMcpServer([
			{
				name: "slack_send",
				description: "Send to Slack",
				annotations: undefined,
			},
		]);

		await registry.registerServer("discord", discordServer);
		await registry.registerServer("slack", slackServer);

		// Create event task thread bound to Discord only
		const threadId = "event-thread-2";
		const taskId = "event-task-2";
		const handleId = "handle-event-2";

		insertRow(
			db,
			"threads",
			{
				id: threadId,
				user_id: "user-1",
				host_origin: siteId,
				title: "event",
				created_at: new Date().toISOString(),
				modified_at: new Date().toISOString(),
				last_message_at: new Date().toISOString(),
				deleted: 0,
				interface: "web",
				summary: null,
			},
			siteId,
		);

		insertRow(
			db,
			"tasks",
			{
				id: taskId,
				type: "event",
				thread_id: threadId,
				status: "running",
				created_at: new Date().toISOString(),
				modified_at: new Date().toISOString(),
				deleted: 0,
				trigger_spec: "",
				payload: null,
				last_run_at: null,
				next_run_at: null,
				consecutive_failures: 0,
				alert_threshold: 3,
			},
			siteId,
		);

		insertRow(
			db,
			"connector_handles",
			{
				id: handleId,
				task_id: taskId,
				server_name: "discord",
				event_name: "message",
				event_args: "{}",
				delivery_mode: "poll",
				created_at: new Date().toISOString(),
				modified_at: new Date().toISOString(),
				deleted: 0,
				cursor: null,
			},
			siteId,
		);

		// Query scoped tools for event thread
		const scopedTools = registry.getToolsForThread(threadId);

		// Should only get Discord tools (the bound server)
		expect(scopedTools.has("discord_list")).toBe(true);

		// Should NOT get Slack tools (other server)
		expect(scopedTools.has("slack_send")).toBe(false);

		// Note: Connector tool is not part of scopedTools (it's added separately in the resolver)
		// This test just verifies scoping doesn't leak tools from other servers
	});

	describe("getInstructionsForThread — connector-authored instructions scoping", () => {
		const INSTRUCTIONS =
			"Discord formatting: **bold**. Messages over 2000 characters are rejected.";

		function seedThread(threadId: string): void {
			insertRow(
				db,
				"threads",
				{
					id: threadId,
					user_id: "user-1",
					host_origin: siteId,
					title: "test",
					created_at: new Date().toISOString(),
					modified_at: new Date().toISOString(),
					last_message_at: new Date().toISOString(),
					deleted: 0,
					interface: "web",
					summary: null,
				},
				siteId,
			);
		}

		function seedEventTask(taskId: string, threadId: string): void {
			insertRow(
				db,
				"tasks",
				{
					id: taskId,
					type: "event",
					thread_id: threadId,
					status: "running",
					created_at: new Date().toISOString(),
					modified_at: new Date().toISOString(),
					deleted: 0,
					trigger_spec: "",
					payload: null,
					last_run_at: null,
					next_run_at: null,
					consecutive_failures: 0,
					alert_threshold: 3,
				},
				siteId,
			);
		}

		function seedHandle(handleId: string, taskId: string, serverName: string): void {
			insertRow(
				db,
				"connector_handles",
				{
					id: handleId,
					task_id: taskId,
					server_name: serverName,
					event_name: "message",
					event_args: "{}",
					delivery_mode: "poll",
					created_at: new Date().toISOString(),
					modified_at: new Date().toISOString(),
					deleted: 0,
					cursor: null,
				},
				siteId,
			);
		}

		it("returns the bound server's instructions for an event-bound thread", async () => {
			const server = await createMockMcpServer(
				[{ name: "discord_send", description: "Send" }],
				INSTRUCTIONS,
			);
			await registry.registerServer("discord", server);

			seedThread("instr-thread-1");
			seedEventTask("instr-task-1", "instr-thread-1");
			seedHandle("instr-handle-1", "instr-task-1", "discord");

			expect(registry.getInstructionsForThread("instr-thread-1")).toBe(INSTRUCTIONS);
		});

		it("returns undefined for a thread with no event task", async () => {
			const server = await createMockMcpServer(
				[{ name: "discord_send", description: "Send" }],
				INSTRUCTIONS,
			);
			await registry.registerServer("discord", server);

			seedThread("instr-orphan");

			expect(registry.getInstructionsForThread("instr-orphan")).toBeUndefined();
		});

		it("returns undefined for an event task with no connector handle", async () => {
			const server = await createMockMcpServer(
				[{ name: "discord_send", description: "Send" }],
				INSTRUCTIONS,
			);
			await registry.registerServer("discord", server);

			seedThread("instr-thread-2");
			seedEventTask("instr-task-2", "instr-thread-2");

			expect(registry.getInstructionsForThread("instr-thread-2")).toBeUndefined();
		});

		it("returns undefined when the bound server declares no instructions", async () => {
			const server = await createMockMcpServer([{ name: "discord_send", description: "Send" }]);
			await registry.registerServer("discord", server);

			seedThread("instr-thread-3");
			seedEventTask("instr-task-3", "instr-thread-3");
			seedHandle("instr-handle-3", "instr-task-3", "discord");

			expect(registry.getInstructionsForThread("instr-thread-3")).toBeUndefined();
		});
	});
});
