import type { Database } from "bun:sqlite";
import DatabaseModule from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { randomBytes } from "node:crypto";
import { applySchema, insertRow } from "@bound/core";
import type { TypedEventEmitter } from "@bound/shared";

import { DISPATCHER_TASK_ID } from "../dispatcher";
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
 * Mock MCP server for testing tool discovery and execution.
 */
class MockMcpServer {
	private tools: { name: string; description: string; inputSchema: Record<string, unknown> }[];

	constructor(
		tools: { name: string; description: string; inputSchema?: Record<string, unknown> }[],
	) {
		this.tools = tools.map((t) => ({
			name: t.name,
			description: t.description,
			inputSchema: t.inputSchema ?? { type: "object", properties: {} },
		}));
	}

	async listTools() {
		return { tools: this.tools };
	}

	async callTool(name: string, _args: Record<string, unknown>) {
		// Mock response
		return {
			content: [{ type: "text", text: `Called ${name}` }],
			isError: false,
		};
	}
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
		const mockServer = new MockMcpServer([
			{ name: "send_message", description: "Send a message" },
			{ name: "delete_message", description: "Delete a message" },
		]);

		// Register server and discover tools
		const entry = await registry.registerServer("discord", mockServer as any);
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

		// Execute tool via proxy closure
		const result = await sendTool?.execute?.({ text: "hello" });
		expect(result).toBe("Called send_message");
	});

	it("AC3.1: event task thread receives tools only from its bound connector", async () => {
		// Create two mock servers
		const discordServer = new MockMcpServer([
			{ name: "discord_send", description: "Send to Discord" },
		]);
		const slackServer = new MockMcpServer([{ name: "slack_send", description: "Send to Slack" }]);

		await registry.registerServer("discord", discordServer as any);
		await registry.registerServer("slack", slackServer as any);

		// Create thread with event task
		const threadId = "thread-1";
		const taskId = "task-1";
		insertRow(
			db,
			"tasks",
			{
				id: taskId,
				site_id: siteId,
				type: "event",
				thread_id: threadId,
				status: "running",
				priority: 1,
				created_at: new Date().toISOString(),
				modified_at: new Date().toISOString(),
				deleted: 0,
				trigger_spec: null,
				payload: null,
				last_run_at: null,
				next_run_at: null,
				consecutive_failures: 0,
				alert_threshold: null,
				consecutive_success_count: 0,
			},
			siteId,
		);

		// Create thread
		insertRow(
			db,
			"threads",
			{
				id: threadId,
				site_id: siteId,
				user_id: "user-1",
				title: "test",
				created_at: new Date().toISOString(),
				modified_at: new Date().toISOString(),
				deleted: 0,
				last_message_at: null,
				archived: 0,
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
				site_id: siteId,
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

	it("AC3.2: dispatcher task receives tools from ALL servers", async () => {
		// Create two mock servers
		const discordServer = new MockMcpServer([
			{ name: "discord_send", description: "Send to Discord" },
		]);
		const slackServer = new MockMcpServer([{ name: "slack_send", description: "Send to Slack" }]);

		await registry.registerServer("discord", discordServer as any);
		await registry.registerServer("slack", slackServer as any);

		// Create dispatcher task thread
		const threadId = "dispatcher-thread";
		insertRow(
			db,
			"tasks",
			{
				id: DISPATCHER_TASK_ID,
				site_id: siteId,
				type: "system",
				thread_id: threadId,
				status: "running",
				priority: 1,
				created_at: new Date().toISOString(),
				modified_at: new Date().toISOString(),
				deleted: 0,
				trigger_spec: null,
				payload: null,
				last_run_at: null,
				next_run_at: null,
				consecutive_failures: 0,
				alert_threshold: null,
				consecutive_success_count: 0,
			},
			siteId,
		);

		// Create thread
		insertRow(
			db,
			"threads",
			{
				id: threadId,
				site_id: siteId,
				user_id: "user-1",
				title: "dispatcher",
				created_at: new Date().toISOString(),
				modified_at: new Date().toISOString(),
				deleted: 0,
				last_message_at: null,
				archived: 0,
				interface: "web",
				summary: null,
			},
			siteId,
		);

		// Check if dispatcher thread
		expect(registry.isDispatcherThread(threadId)).toBe(true);

		// Get all platform tools
		const tools = registry.getAllPlatformTools();

		// Should get ALL tools from all servers
		expect(tools.size).toBe(2);
		expect(tools.has("discord_send")).toBe(true);
		expect(tools.has("slack_send")).toBe(true);
	});

	it("AC3.3: thread with no event task receives no tools", async () => {
		// Create a thread with no event task
		const threadId = "orphan-thread";
		insertRow(
			db,
			"threads",
			{
				id: threadId,
				site_id: siteId,
				user_id: "user-1",
				title: "orphan",
				created_at: new Date().toISOString(),
				modified_at: new Date().toISOString(),
				deleted: 0,
				last_message_at: null,
				archived: 0,
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
				site_id: siteId,
				type: "event",
				thread_id: threadId,
				status: "running",
				priority: 1,
				created_at: new Date().toISOString(),
				modified_at: new Date().toISOString(),
				deleted: 0,
				trigger_spec: null,
				payload: null,
				last_run_at: null,
				next_run_at: null,
				consecutive_failures: 0,
				alert_threshold: null,
				consecutive_success_count: 0,
			},
			siteId,
		);

		// Create thread
		insertRow(
			db,
			"threads",
			{
				id: threadId,
				site_id: siteId,
				user_id: "user-1",
				title: "test",
				created_at: new Date().toISOString(),
				modified_at: new Date().toISOString(),
				deleted: 0,
				last_message_at: null,
				archived: 0,
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
		const mockServer = new MockMcpServer([{ name: "channel_list", description: "List channels" }]);
		await registry.registerServer("discord", mockServer as any);

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
				site_id: siteId,
				user_id: "user-1",
				title: "test",
				created_at: new Date().toISOString(),
				modified_at: new Date().toISOString(),
				deleted: 0,
				last_message_at: null,
				archived: 0,
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
				site_id: siteId,
				type: "event",
				thread_id: threadId,
				status: "running",
				priority: 1,
				created_at: new Date().toISOString(),
				modified_at: new Date().toISOString(),
				deleted: 0,
				trigger_spec: null,
				payload: null,
				last_run_at: null,
				next_run_at: null,
				consecutive_failures: 0,
				alert_threshold: null,
				consecutive_success_count: 0,
			},
			siteId,
		);

		// Create connector handle (final link in chain)
		insertRow(
			db,
			"connector_handles",
			{
				id: handleId,
				site_id: siteId,
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
});
