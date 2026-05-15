import Database from "bun:sqlite";
import { beforeEach, describe, expect, it } from "bun:test";
import { randomBytes } from "node:crypto";
import { applySchema } from "@bound/core";
import type { TypedEventEmitter } from "@bound/shared";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { PlatformMcpRegistry } from "../mcp-registry.js";

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

describe("Annotation Pipeline Tests", () => {
	let db: Database.Database;
	let siteId: string;
	let eventBus: SimpleEventBus;
	let registry: PlatformMcpRegistry;

	beforeEach(async () => {
		// Setup database
		const dbPath = ":memory:";
		db = new Database(dbPath);
		applySchema(db);

		siteId = `test-site-${randomBytes(4).toString("hex")}`;

		eventBus = new SimpleEventBus();

		// Create registry
		registry = new PlatformMcpRegistry({
			db,
			siteId,
			eventBus: eventBus as unknown as TypedEventEmitter,
			logger: mockLogger,
		});
	});

	describe("remove-dispatcher.AC3.1 & AC3.2: Annotations preserved in discovery", () => {
		it("discord_list_channels is registered with readOnlyHint annotation", async () => {
			// Create a mock Discord MCP server that registers tools with annotations
			const discordMcpServer = new McpServer({
				name: "discord",
				version: "1.0.0",
			});

			// Register tools with annotations using registerTool
			discordMcpServer.registerTool(
				"discord_list_channels",
				{
					description: "List known DM channel IDs that have sent messages to this bot.",
					inputSchema: z.object({}),
					annotations: {
						readOnlyHint: true,
					},
				},
				async () => ({
					content: [{ type: "text", text: "[]" }],
				}),
			);

			discordMcpServer.registerTool(
				"discord_send_message",
				{
					description: "Send a message to a Discord channel.",
					inputSchema: z.object({
						channel_id: z.string(),
						content: z.string(),
					}),
					// No annotations — write tool
				},
				async () => ({
					content: [{ type: "text", text: "Message sent" }],
				}),
			);

			// Register the Discord server
			await registry.registerServer("discord", discordMcpServer.server);

			// Get the discovered tools
			const allTools = registry.getAllPlatformTools();

			// Verify discord_list_channels exists
			expect(allTools.has("discord_list_channels")).toBe(true);
			const listChannelsTool = allTools.get("discord_list_channels");
			expect(listChannelsTool).toBeDefined();

			// Verify the annotations were preserved (AC3.2)
			expect(listChannelsTool?.annotations?.readOnlyHint).toBe(true);
		});

		it("preserves annotations from MCP listTools response on PlatformRegisteredTool", async () => {
			// Create a mock platform server with multiple tools with different annotations
			const platformMcpServer = new McpServer({
				name: "test-platform",
				version: "1.0.0",
			});

			// Register tools with different annotations
			platformMcpServer.registerTool(
				"read_tool",
				{
					description: "A read-only tool",
					inputSchema: z.object({}),
					annotations: {
						readOnlyHint: true,
					},
				},
				async () => ({
					content: [{ type: "text", text: "read data" }],
				}),
			);

			platformMcpServer.registerTool(
				"write_tool",
				{
					description: "A write tool",
					inputSchema: z.object({}),
					annotations: {
						destructiveHint: true,
					},
				},
				async () => ({
					content: [{ type: "text", text: "written" }],
				}),
			);

			platformMcpServer.registerTool(
				"idempotent_tool",
				{
					description: "An idempotent tool",
					inputSchema: z.object({}),
					annotations: {
						idempotentHint: true,
					},
				},
				async () => ({
					content: [{ type: "text", text: "idempotent result" }],
				}),
			);

			// Register the platform server
			await registry.registerServer("test-platform", platformMcpServer.server);

			// Get the discovered tools
			const allTools = registry.getAllPlatformTools();

			// Verify all tools were discovered
			expect(allTools.size).toBe(3);
			expect(allTools.has("read_tool")).toBe(true);
			expect(allTools.has("write_tool")).toBe(true);
			expect(allTools.has("idempotent_tool")).toBe(true);

			// Verify each annotation was preserved correctly
			const readTool = allTools.get("read_tool");
			expect(readTool?.annotations?.readOnlyHint).toBe(true);
			expect(readTool?.annotations?.destructiveHint).toBeUndefined();

			const writeTool = allTools.get("write_tool");
			expect(writeTool?.annotations?.destructiveHint).toBe(true);
			expect(writeTool?.annotations?.readOnlyHint).toBeUndefined();

			const idempotentTool = allTools.get("idempotent_tool");
			expect(idempotentTool?.annotations?.idempotentHint).toBe(true);
		});
	});

	describe("remove-dispatcher.AC3.3: getReadOnlyPlatformTools() filtering", () => {
		it("returns only tools where annotations.readOnlyHint === true", async () => {
			// Create a mock server with mixed tools
			const mcpServer = new McpServer({
				name: "test-platform",
				version: "1.0.0",
			});

			// Register tools with different annotation states
			mcpServer.registerTool(
				"list_items",
				{
					description: "List items",
					inputSchema: z.object({}),
					annotations: {
						readOnlyHint: true,
					},
				},
				async () => ({
					content: [{ type: "text", text: "[]" }],
				}),
			);

			mcpServer.registerTool(
				"create_item",
				{
					description: "Create item",
					inputSchema: z.object({}),
					annotations: {
						destructiveHint: true,
					},
				},
				async () => ({
					content: [{ type: "text", text: "created" }],
				}),
			);

			mcpServer.registerTool(
				"get_info",
				{
					description: "Get info",
					inputSchema: z.object({}),
					annotations: {
						readOnlyHint: true,
					},
				},
				async () => ({
					content: [{ type: "text", text: "info" }],
				}),
			);

			mcpServer.registerTool(
				"delete_item",
				{
					description: "Delete item",
					inputSchema: z.object({}),
					annotations: {
						destructiveHint: true,
						readOnlyHint: false,
					},
				},
				async () => ({
					content: [{ type: "text", text: "deleted" }],
				}),
			);

			// Register the server
			await registry.registerServer("test-platform", mcpServer.server);

			// Get read-only tools
			const readOnlyTools = registry.getReadOnlyPlatformTools();

			// Verify only read-only tools are returned
			expect(readOnlyTools.size).toBe(2);
			expect(readOnlyTools.has("list_items")).toBe(true);
			expect(readOnlyTools.has("get_info")).toBe(true);

			// Verify write tools are excluded
			expect(readOnlyTools.has("create_item")).toBe(false);
			expect(readOnlyTools.has("delete_item")).toBe(false);

			// Verify the returned tools have correct annotations
			const listItemsTool = readOnlyTools.get("list_items");
			expect(listItemsTool?.annotations?.readOnlyHint).toBe(true);

			const getInfoTool = readOnlyTools.get("get_info");
			expect(getInfoTool?.annotations?.readOnlyHint).toBe(true);
		});

		it("excludes tools with no annotations (AC3.6 edge case)", async () => {
			// Create a mock server where some tools have no annotations
			const mcpServer = new McpServer({
				name: "test-platform",
				version: "1.0.0",
			});

			mcpServer.registerTool(
				"annotated_readonly",
				{
					description: "Has read-only annotation",
					inputSchema: z.object({}),
					annotations: {
						readOnlyHint: true,
					},
				},
				async () => ({
					content: [{ type: "text", text: "readonly" }],
				}),
			);

			mcpServer.registerTool(
				"not_annotated",
				{
					description: "No annotations",
					inputSchema: z.object({}),
					// No annotations property
				},
				async () => ({
					content: [{ type: "text", text: "no annotations" }],
				}),
			);

			mcpServer.registerTool(
				"annotated_write",
				{
					description: "Has write annotation",
					inputSchema: z.object({}),
					annotations: {
						destructiveHint: true,
					},
				},
				async () => ({
					content: [{ type: "text", text: "write" }],
				}),
			);

			// Register the server
			await registry.registerServer("test-platform", mcpServer.server);

			// Get read-only tools
			const readOnlyTools = registry.getReadOnlyPlatformTools();

			// Only the explicitly read-only tool should be included
			expect(readOnlyTools.size).toBe(1);
			expect(readOnlyTools.has("annotated_readonly")).toBe(true);

			// Tools without annotations or with other annotations should be excluded
			expect(readOnlyTools.has("not_annotated")).toBe(false);
			expect(readOnlyTools.has("annotated_write")).toBe(false);
		});

		it("discord_send_message is excluded from read-only tools", async () => {
			// Create a Discord-like server with both read and write tools
			const discordMcpServer = new McpServer({
				name: "discord",
				version: "1.0.0",
			});

			discordMcpServer.registerTool(
				"discord_list_channels",
				{
					description: "List channels",
					inputSchema: z.object({}),
					annotations: {
						readOnlyHint: true,
					},
				},
				async () => ({
					content: [{ type: "text", text: "[]" }],
				}),
			);

			discordMcpServer.registerTool(
				"discord_send_message",
				{
					description: "Send a message",
					inputSchema: z.object({
						channel_id: z.string(),
						content: z.string(),
					}),
					annotations: {
						destructiveHint: true,
					},
				},
				async () => ({
					content: [{ type: "text", text: "sent" }],
				}),
			);

			// Register the Discord server
			await registry.registerServer("discord", discordMcpServer.server);

			// Get read-only tools
			const readOnlyTools = registry.getReadOnlyPlatformTools();

			// discord_list_channels should be included
			expect(readOnlyTools.has("discord_list_channels")).toBe(true);

			// discord_send_message should be excluded
			expect(readOnlyTools.has("discord_send_message")).toBe(false);
		});
	});

	describe("Multiple servers with mixed annotations", () => {
		it("correctly aggregates read-only tools across multiple servers", async () => {
			// Create first server with read-only tools
			const server1McpServer = new McpServer({
				name: "server1",
				version: "1.0.0",
			});

			server1McpServer.registerTool(
				"server1_read",
				{
					description: "Read tool from server1",
					inputSchema: z.object({}),
					annotations: {
						readOnlyHint: true,
					},
				},
				async () => ({
					content: [{ type: "text", text: "read1" }],
				}),
			);

			server1McpServer.registerTool(
				"server1_write",
				{
					description: "Write tool from server1",
					inputSchema: z.object({}),
					annotations: {
						destructiveHint: true,
					},
				},
				async () => ({
					content: [{ type: "text", text: "write1" }],
				}),
			);

			// Create second server with read-only tools
			const server2McpServer = new McpServer({
				name: "server2",
				version: "1.0.0",
			});

			server2McpServer.registerTool(
				"server2_read",
				{
					description: "Read tool from server2",
					inputSchema: z.object({}),
					annotations: {
						readOnlyHint: true,
					},
				},
				async () => ({
					content: [{ type: "text", text: "read2" }],
				}),
			);

			server2McpServer.registerTool(
				"server2_info",
				{
					description: "Info tool from server2",
					inputSchema: z.object({}),
					annotations: {
						readOnlyHint: true,
					},
				},
				async () => ({
					content: [{ type: "text", text: "info2" }],
				}),
			);

			// Register both servers
			await registry.registerServer("server1", server1McpServer.server);
			await registry.registerServer("server2", server2McpServer.server);

			// Get read-only tools
			const readOnlyTools = registry.getReadOnlyPlatformTools();

			// Verify we have 3 read-only tools total (1 from server1, 2 from server2)
			expect(readOnlyTools.size).toBe(3);
			expect(readOnlyTools.has("server1_read")).toBe(true);
			expect(readOnlyTools.has("server2_read")).toBe(true);
			expect(readOnlyTools.has("server2_info")).toBe(true);

			// Verify write tools are excluded
			expect(readOnlyTools.has("server1_write")).toBe(false);

			// Verify all returned tools have readOnlyHint: true
			for (const [_name, tool] of readOnlyTools) {
				expect(tool.annotations?.readOnlyHint).toBe(true);
			}
		});
	});
});
