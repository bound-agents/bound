import Database from "bun:sqlite";
import { beforeEach, describe, expect, it } from "bun:test";
import { randomBytes } from "node:crypto";
import { applySchema, insertRow } from "@bound/core";
import type { TypedEventEmitter } from "@bound/shared";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { PlatformMcpRegistry } from "../mcp-registry.js";

/**
 * Tests for cross-host platform tool discovery via the relay proxy.
 *
 * SCENARIO: This host has no Discord platform server registered locally.
 * Discord runs on a remote host. We want the agent on this host to be able
 * to call read-only Discord tools (e.g. `discord_list_channels`) via a
 * relay-backed PlatformRegisteredTool — without separately registering the
 * platform here.
 *
 * The PlatformMcpRegistry takes a `remotePlatformRequest` callback that
 * proxies MCP requests to the remote platform host. On `discoverRemoteTools()`
 * the registry inspects `hosts.platforms` for non-local hosts, calls
 * `tools/list` via that proxy per remote server, and synthesizes
 * PlatformRegisteredTool entries whose `execute` proxies `tools/call` back
 * through the same relay.
 *
 * Read-only tool filtering uses `annotations.readOnlyHint === true`, matching
 * the local-tool path in `getReadOnlyPlatformTools()`.
 */

const mockLogger = {
	debug: () => {},
	info: () => {},
	warn: () => {},
	error: () => {},
};

class SimpleEventBus {
	private listeners = new Map<string, Set<(payload: unknown) => void>>();
	on<K extends string>(event: K, handler: (payload: unknown) => void): void {
		if (!this.listeners.has(event)) this.listeners.set(event, new Set());
		this.listeners.get(event)?.add(handler);
	}
	emit<K extends string>(event: K, payload: unknown): void {
		const handlers = this.listeners.get(event);
		if (handlers) {
			for (const h of handlers) h(payload);
		}
	}
	off<K extends string>(event: K, handler: (payload: unknown) => void): void {
		this.listeners.get(event)?.delete(handler);
	}
}

/**
 * Stand up a real in-memory MCP server and route tools/list and tools/call
 * to it through an in-process Client. This mirrors what the relay does on
 * the remote side, so we exercise the same JSON-roundtrip shape that
 * executePlatformRequest produces in production.
 */
async function makeRemoteRouter(serverFactory: () => McpServer) {
	const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
	const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");
	const server = serverFactory();
	const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
	const client = new Client({ name: "test-relay-client", version: "1.0.0" }, { capabilities: {} });
	await server.server.connect(serverTransport);
	await client.connect(clientTransport);
	return async (
		_serverName: string,
		method: string,
		params: Record<string, unknown>,
	): Promise<unknown> => {
		const res = await client.request({ method, params }, z.object({}).passthrough());
		// Match production: relay round-trips through JSON.stringify(result) →
		// JSON.parse(stdout). Force the same coercion here so registry code
		// can't accidentally rely on rich client objects.
		return JSON.parse(JSON.stringify(res));
	};
}

describe("PlatformMcpRegistry: remote tool relay (Option 2)", () => {
	let db: Database.Database;
	let siteId: string;
	let registry: PlatformMcpRegistry;

	beforeEach(() => {
		db = new Database(":memory:");
		applySchema(db);
		siteId = `local-${randomBytes(4).toString("hex")}`;
		registry = new PlatformMcpRegistry({
			db,
			siteId,
			eventBus: new SimpleEventBus() as unknown as TypedEventEmitter,
			logger: mockLogger,
		});
	});

	function seedRemoteHost(remoteSiteId: string, platforms: string[]): void {
		const now = new Date().toISOString();
		insertRow(
			db,
			"hosts",
			{
				site_id: remoteSiteId,
				host_name: `host-${remoteSiteId}`,
				version: "test",
				sync_url: null,
				mcp_servers: null,
				mcp_tools: null,
				models: null,
				overlay_root: null,
				online_at: now,
				modified_at: now,
				deleted: 0,
				platforms: JSON.stringify(platforms),
				mcp_tool_annotations: null,
			},
			siteId,
		);
	}

	it("discovers remote read-only tools and surfaces them through getReadOnlyPlatformTools()", async () => {
		seedRemoteHost("remote-A", ["discord"]);

		const remotePlatformRequest = await makeRemoteRouter(() => {
			const s = new McpServer({ name: "discord", version: "1.0.0" });
			s.registerTool(
				"discord_list_channels",
				{
					description: "List known DM channel IDs.",
					inputSchema: z.object({}),
					annotations: { readOnlyHint: true },
				},
				async () => ({ content: [{ type: "text", text: '["C1","C2"]' }] }),
			);
			s.registerTool(
				"discord_send_message",
				{
					description: "Send a Discord message.",
					inputSchema: z.object({ channel_id: z.string(), content: z.string() }),
					// no readOnlyHint → must NOT appear in read-only set
				},
				async () => ({ content: [{ type: "text", text: "sent" }] }),
			);
			return s;
		});

		registry.setRemotePlatformRequest(remotePlatformRequest);
		await registry.discoverRemoteTools();

		const readOnly = registry.getReadOnlyPlatformTools();
		expect(readOnly.has("discord_list_channels")).toBe(true);
		expect(readOnly.has("discord_send_message")).toBe(false);

		const tool = readOnly.get("discord_list_channels");
		expect(tool?.kind).toBe("platform");
		expect(tool?.toolDefinition.function.name).toBe("discord_list_channels");
		expect(tool?.annotations?.readOnlyHint).toBe(true);
	});

	it("relay-backed execute proxies tools/call and unwraps content text", async () => {
		seedRemoteHost("remote-A", ["discord"]);
		let lastCallArgs: Record<string, unknown> | undefined;

		const remotePlatformRequest = await makeRemoteRouter(() => {
			const s = new McpServer({ name: "discord", version: "1.0.0" });
			s.registerTool(
				"discord_list_channels",
				{
					description: "List channels.",
					inputSchema: z.object({}),
					annotations: { readOnlyHint: true },
				},
				async (args) => {
					lastCallArgs = args as Record<string, unknown>;
					return { content: [{ type: "text", text: '["C7"]' }] };
				},
			);
			return s;
		});

		registry.setRemotePlatformRequest(remotePlatformRequest);
		await registry.discoverRemoteTools();

		const tool = registry.getReadOnlyPlatformTools().get("discord_list_channels");
		expect(tool).toBeDefined();
		expect(tool?.execute).toBeDefined();
		if (!tool?.execute) throw new Error("unreachable");
		const result = await tool.execute({});
		expect(result).toBe('["C7"]');
		// MCP SDK fills missing args with {} — the test only needs to confirm
		// the call reached the remote handler, not the exact arg shape.
		expect(lastCallArgs).toBeDefined();
	});

	it("relay-backed execute surfaces isError as 'Error: <text>'", async () => {
		seedRemoteHost("remote-A", ["fakeplatform"]);

		const remotePlatformRequest = await makeRemoteRouter(() => {
			const s = new McpServer({ name: "fakeplatform", version: "1.0.0" });
			s.registerTool(
				"sometimes_fails",
				{
					description: "May fail.",
					inputSchema: z.object({}),
					annotations: { readOnlyHint: true },
				},
				async () => ({
					content: [{ type: "text", text: "boom" }],
					isError: true,
				}),
			);
			return s;
		});

		registry.setRemotePlatformRequest(remotePlatformRequest);
		await registry.discoverRemoteTools();

		const tool = registry.getReadOnlyPlatformTools().get("sometimes_fails");
		if (!tool?.execute) throw new Error("tool or execute missing");
		const result = await tool.execute({});
		expect(result).toBe("Error: boom");
	});

	it("local tools take precedence over remote tools with the same name", async () => {
		seedRemoteHost("remote-A", ["discord"]);

		// Local discord server registered on this host
		const localServer = new McpServer({ name: "discord", version: "1.0.0" });
		localServer.registerTool(
			"discord_list_channels",
			{
				description: "LOCAL list channels.",
				inputSchema: z.object({}),
				annotations: { readOnlyHint: true },
			},
			async () => ({ content: [{ type: "text", text: "local" }] }),
		);
		await registry.registerServer("discord", localServer.server);

		// Remote also exposes the same name
		const remotePlatformRequest = await makeRemoteRouter(() => {
			const s = new McpServer({ name: "discord", version: "1.0.0" });
			s.registerTool(
				"discord_list_channels",
				{
					description: "REMOTE list channels.",
					inputSchema: z.object({}),
					annotations: { readOnlyHint: true },
				},
				async () => ({ content: [{ type: "text", text: "remote" }] }),
			);
			return s;
		});

		registry.setRemotePlatformRequest(remotePlatformRequest);
		await registry.discoverRemoteTools();

		const tool = registry.getReadOnlyPlatformTools().get("discord_list_channels");
		expect(tool).toBeDefined();
		if (!tool?.execute) throw new Error("tool or execute missing");
		// Local must win — calling execute should hit the local handler
		const result = await tool.execute({});
		expect(result).toBe("local");
	});

	it("excludes the local site from remote discovery", async () => {
		// Self-row also has platforms set (e.g., this host did register one).
		// Discovery must skip its own site_id and not double-count its tools.
		insertRow(
			db,
			"hosts",
			{
				site_id: siteId,
				host_name: "self",
				version: "test",
				sync_url: null,
				mcp_servers: null,
				mcp_tools: null,
				models: null,
				overlay_root: null,
				online_at: new Date().toISOString(),
				modified_at: new Date().toISOString(),
				deleted: 0,
				platforms: JSON.stringify(["discord"]),
				mcp_tool_annotations: null,
			},
			siteId,
		);

		let remoteCalled = false;
		const remotePlatformRequest = async (
			_serverName: string,
			_method: string,
			_params: Record<string, unknown>,
		): Promise<unknown> => {
			remoteCalled = true;
			return { tools: [] };
		};

		registry.setRemotePlatformRequest(remotePlatformRequest);
		await registry.discoverRemoteTools();

		expect(remoteCalled).toBe(false);
		expect(registry.getReadOnlyPlatformTools().size).toBe(0);
	});

	it("survives a remote tools/list failure without throwing", async () => {
		seedRemoteHost("remote-A", ["broken"]);
		seedRemoteHost("remote-B", ["working"]);

		const remotePlatformRequest = async (
			serverName: string,
			method: string,
			_params: Record<string, unknown>,
		): Promise<unknown> => {
			if (serverName === "broken") throw new Error("relay timeout");
			if (serverName === "working" && method === "tools/list") {
				return {
					tools: [
						{
							name: "ping",
							description: "ping",
							inputSchema: { type: "object", properties: {} },
							annotations: { readOnlyHint: true },
						},
					],
				};
			}
			throw new Error(`unexpected request: ${serverName} ${method}`);
		};

		registry.setRemotePlatformRequest(remotePlatformRequest);
		await registry.discoverRemoteTools();

		// 'working' tool present, 'broken' silently dropped
		const tools = registry.getReadOnlyPlatformTools();
		expect(tools.has("ping")).toBe(true);
		expect(tools.size).toBe(1);
	});

	it("discoverRemoteTools is a no-op when no remote callback is set", async () => {
		seedRemoteHost("remote-A", ["discord"]);
		// No setRemotePlatformRequest call.
		await registry.discoverRemoteTools();
		expect(registry.getReadOnlyPlatformTools().size).toBe(0);
	});

	it("re-discovery replaces stale remote tools rather than accumulating them", async () => {
		seedRemoteHost("remote-A", ["plat"]);

		let toolName = "first_tool";
		const remotePlatformRequest = async (
			_serverName: string,
			method: string,
			_params: Record<string, unknown>,
		): Promise<unknown> => {
			if (method !== "tools/list") throw new Error("only tools/list is exercised here");
			return {
				tools: [
					{
						name: toolName,
						description: "x",
						inputSchema: { type: "object", properties: {} },
						annotations: { readOnlyHint: true },
					},
				],
			};
		};

		registry.setRemotePlatformRequest(remotePlatformRequest);
		await registry.discoverRemoteTools();
		expect(registry.getReadOnlyPlatformTools().has("first_tool")).toBe(true);

		// Remote rotates its tool catalog
		toolName = "second_tool";
		await registry.discoverRemoteTools();

		const tools = registry.getReadOnlyPlatformTools();
		expect(tools.has("second_tool")).toBe(true);
		expect(tools.has("first_tool")).toBe(false);
	});
});
