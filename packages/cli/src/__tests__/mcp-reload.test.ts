import { describe, expect, it } from "bun:test";
import type { MCPClient, MCPServerConfig } from "@bound/agent";
import type { Tool } from "@bound/agent";
import type { AppContext } from "@bound/core";
import type { Logger, McpConfig } from "@bound/shared";
import { TypedEventEmitter } from "@bound/shared";
import { diffMcpConfigs, reloadMcpServers } from "../commands/start/mcp";

/**
 * Build a minimal MCPClient stand-in for reload tests.
 */
function makeMockClient(config: MCPServerConfig, tools: Tool[] = [], connected = true): MCPClient {
	return {
		getConfig: () => config,
		isConnected: () => connected,
		listTools: async () => tools,
		listResources: async () => [],
		listPrompts: async () => [],
		callTool: async (name: string, args: Record<string, unknown>) => ({
			content: `Tool ${name} called with args: ${JSON.stringify(args)}`,
			isError: false,
		}),
		readResource: async (uri: string) => ({ uri, content: `Content of ${uri}` }),
		invokePrompt: async () => ({ messages: [] }),
		connect: async () => {},
		disconnect: async () => {},
	} as unknown as MCPClient;
}

describe("diffMcpConfigs", () => {
	it("detects added servers", () => {
		const oldConfig: McpConfig = { servers: [] };
		const newConfig: McpConfig = {
			servers: [{ name: "new-server", transport: "stdio", command: "test" }],
		};

		const diff = diffMcpConfigs(oldConfig, newConfig);
		expect(diff.added).toHaveLength(1);
		expect(diff.added[0].name).toBe("new-server");
		expect(diff.removed).toHaveLength(0);
		expect(diff.changed).toHaveLength(0);
	});

	it("detects removed servers", () => {
		const oldConfig: McpConfig = {
			servers: [{ name: "old-server", transport: "stdio", command: "test" }],
		};
		const newConfig: McpConfig = { servers: [] };

		const diff = diffMcpConfigs(oldConfig, newConfig);
		expect(diff.added).toHaveLength(0);
		expect(diff.removed).toHaveLength(1);
		expect(diff.removed[0].name).toBe("old-server");
		expect(diff.changed).toHaveLength(0);
	});

	it("detects changed servers (command changed)", () => {
		const oldConfig: McpConfig = {
			servers: [{ name: "server", transport: "stdio", command: "old-cmd" }],
		};
		const newConfig: McpConfig = {
			servers: [{ name: "server", transport: "stdio", command: "new-cmd" }],
		};

		const diff = diffMcpConfigs(oldConfig, newConfig);
		expect(diff.added).toHaveLength(0);
		expect(diff.removed).toHaveLength(0);
		expect(diff.changed).toHaveLength(1);
		expect(diff.changed[0].name).toBe("server");
	});

	it("detects changed servers (url changed for http)", () => {
		const oldConfig: McpConfig = {
			servers: [{ name: "server", transport: "http", url: "https://old.example.com" }],
		};
		const newConfig: McpConfig = {
			servers: [{ name: "server", transport: "http", url: "https://new.example.com" }],
		};

		const diff = diffMcpConfigs(oldConfig, newConfig);
		expect(diff.changed).toHaveLength(1);
	});

	it("detects changed servers (allow_tools changed)", () => {
		const oldConfig: McpConfig = {
			servers: [{ name: "server", transport: "stdio", command: "cmd", allow_tools: ["tool1"] }],
		};
		const newConfig: McpConfig = {
			servers: [
				{
					name: "server",
					transport: "stdio",
					command: "cmd",
					allow_tools: ["tool1", "tool2"],
				},
			],
		};

		const diff = diffMcpConfigs(oldConfig, newConfig);
		expect(diff.changed).toHaveLength(1);
	});

	it("reports unchanged servers as unchanged", () => {
		const serverCfg = { name: "server", transport: "stdio" as const, command: "cmd" };
		const oldConfig: McpConfig = { servers: [serverCfg] };
		const newConfig: McpConfig = { servers: [{ ...serverCfg }] };

		const diff = diffMcpConfigs(oldConfig, newConfig);
		expect(diff.added).toHaveLength(0);
		expect(diff.removed).toHaveLength(0);
		expect(diff.changed).toHaveLength(0);
	});

	it("handles mixed add/remove/change", () => {
		const oldConfig: McpConfig = {
			servers: [
				{ name: "keep-same", transport: "stdio", command: "cmd" },
				{ name: "will-change", transport: "stdio", command: "old-cmd" },
				{ name: "will-remove", transport: "stdio", command: "cmd" },
			],
		};
		const newConfig: McpConfig = {
			servers: [
				{ name: "keep-same", transport: "stdio", command: "cmd" },
				{ name: "will-change", transport: "stdio", command: "new-cmd" },
				{ name: "will-add", transport: "http", url: "https://new.example.com" },
			],
		};

		const diff = diffMcpConfigs(oldConfig, newConfig);
		expect(diff.added).toHaveLength(1);
		expect(diff.added[0].name).toBe("will-add");
		expect(diff.removed).toHaveLength(1);
		expect(diff.removed[0].name).toBe("will-remove");
		expect(diff.changed).toHaveLength(1);
		expect(diff.changed[0].name).toBe("will-change");
	});
});

// Helpers for reloadMcpServers tests
function createMockLogger(): Logger {
	return { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };
}

function createMockAppContext() {
	const { applySchema, createDatabase } = require("@bound/core") as typeof import("@bound/core");
	const db = createDatabase(":memory:");
	applySchema(db);

	const siteId = "test-site";
	// Create host row so updateHostMCPInfo can update it
	db.run("INSERT INTO hosts (site_id, host_name, modified_at, deleted) VALUES (?, ?, ?, ?)", [
		siteId,
		"test-host",
		new Date().toISOString(),
		0,
	]);

	const logger = createMockLogger();
	const eventBus = new TypedEventEmitter();
	return {
		appContext: {
			db,
			config: {},
			optionalConfig: {},
			eventBus,
			logger,
			siteId,
			hostName: "test-host",
		},
		cleanup: () => db.close(),
	};
}

describe("reloadMcpServers", () => {
	it("adds new servers to the client map", async () => {
		const { appContext, cleanup } = createMockAppContext();
		const mcpClientsMap = new Map<string, MCPClient>();
		const mcpServerNames = new Set<string>();
		const confirmGates = new Map<string, string[]>();

		// MCPClient constructor creates real connections, so adding a server with
		// a fake command will fail. We test that the failure is reported correctly.
		const oldConfig: McpConfig = { servers: [] };
		const newConfig: McpConfig = {
			servers: [{ name: "new-server", transport: "stdio", command: "echo" }],
		};

		const result = await reloadMcpServers({
			appContext: appContext as unknown as AppContext,
			mcpClientsMap,
			mcpServerNames,
			confirmGates,
			sandbox: null, // no sandbox — just tests map mutation
			commandContext: {
				db: appContext.db,
				siteId: appContext.siteId,
				eventBus: appContext.eventBus,
				logger: appContext.logger,
				mcpClients: mcpClientsMap,
			},
			oldConfig,
			newConfig,
		});

		// Connection will fail (no real server), so it ends up in failed
		expect(result.failed).toContain("new-server");
		expect(result.added).toHaveLength(0); // failed, not added
		cleanup();
	});

	it("removes servers from the client map", async () => {
		const { appContext, cleanup } = createMockAppContext();
		const existingClient = makeMockClient(
			{ name: "old-server", transport: "stdio", command: "test" },
			[],
		);

		const mcpClientsMap = new Map<string, MCPClient>([["old-server", existingClient]]);
		const mcpServerNames = new Set(["old-server"]);
		const confirmGates = new Map<string, string[]>();

		const oldConfig: McpConfig = {
			servers: [{ name: "old-server", transport: "stdio", command: "test" }],
		};
		const newConfig: McpConfig = { servers: [] };

		const result = await reloadMcpServers({
			appContext: appContext as unknown as AppContext,
			mcpClientsMap,
			mcpServerNames,
			confirmGates,
			sandbox: null,
			commandContext: {
				db: appContext.db,
				siteId: appContext.siteId,
				eventBus: appContext.eventBus,
				logger: appContext.logger,
				mcpClients: mcpClientsMap,
			},
			oldConfig,
			newConfig,
		});

		expect(result.removed).toEqual(["old-server"]);
		expect(mcpClientsMap.has("old-server")).toBe(false);
		expect(mcpServerNames.has("old-server")).toBe(false);
		cleanup();
	});

	it("returns no-op result when configs are identical", async () => {
		const { appContext, cleanup } = createMockAppContext();
		const mcpClientsMap = new Map<string, MCPClient>();
		const mcpServerNames = new Set<string>();
		const confirmGates = new Map<string, string[]>();

		const config: McpConfig = {
			servers: [{ name: "server", transport: "stdio", command: "test" }],
		};

		const result = await reloadMcpServers({
			appContext: appContext as unknown as AppContext,
			mcpClientsMap,
			mcpServerNames,
			confirmGates,
			sandbox: null,
			commandContext: {
				db: appContext.db,
				siteId: appContext.siteId,
				eventBus: appContext.eventBus,
				logger: appContext.logger,
				mcpClients: mcpClientsMap,
			},
			oldConfig: config,
			newConfig: { ...config, servers: [...config.servers] },
		});

		expect(result.added).toHaveLength(0);
		expect(result.removed).toHaveLength(0);
		expect(result.changed).toHaveLength(0);
		expect(result.failed).toHaveLength(0);
		cleanup();
	});

	it("disconnects changed servers before reconnecting", async () => {
		const { appContext, cleanup } = createMockAppContext();
		let disconnectCalled = false;
		const existingClient = {
			...makeMockClient({ name: "server", transport: "stdio", command: "old" }),
			disconnect: async () => {
				disconnectCalled = true;
			},
		} as unknown as MCPClient;

		const mcpClientsMap = new Map<string, MCPClient>([["server", existingClient]]);
		const mcpServerNames = new Set(["server"]);
		const confirmGates = new Map<string, string[]>();

		const oldConfig: McpConfig = {
			servers: [{ name: "server", transport: "stdio", command: "old" }],
		};
		const newConfig: McpConfig = {
			servers: [{ name: "server", transport: "stdio", command: "new" }],
		};

		await reloadMcpServers({
			appContext: appContext as unknown as AppContext,
			mcpClientsMap,
			mcpServerNames,
			confirmGates,
			sandbox: null,
			commandContext: {
				db: appContext.db,
				siteId: appContext.siteId,
				eventBus: appContext.eventBus,
				logger: appContext.logger,
				mcpClients: mcpClientsMap,
			},
			oldConfig,
			newConfig,
		});

		expect(disconnectCalled).toBe(true);
		cleanup();
	});

	it("updates confirm gates on reload", async () => {
		const { appContext, cleanup } = createMockAppContext();
		const existingClient = makeMockClient({ name: "server", transport: "stdio", command: "test" });
		const mcpClientsMap = new Map<string, MCPClient>([["server", existingClient]]);
		const mcpServerNames = new Set(["server"]);
		const confirmGates = new Map([["server", ["old-tool"]]]);

		const oldConfig: McpConfig = {
			servers: [
				{
					name: "server",
					transport: "stdio",
					command: "test",
					confirm: ["old-tool"],
				},
			],
		};
		const newConfig: McpConfig = { servers: [] };

		await reloadMcpServers({
			appContext: appContext as unknown as AppContext,
			mcpClientsMap,
			mcpServerNames,
			confirmGates,
			sandbox: null,
			commandContext: {
				db: appContext.db,
				siteId: appContext.siteId,
				eventBus: appContext.eventBus,
				logger: appContext.logger,
				mcpClients: mcpClientsMap,
			},
			oldConfig,
			newConfig,
		});

		expect(confirmGates.has("server")).toBe(false);
		cleanup();
	});
});
