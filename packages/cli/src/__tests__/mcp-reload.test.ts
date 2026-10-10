import { describe, expect, it } from "bun:test";
import type { MCPClient, MCPServerConfig } from "@bound/agent";
import { AuthChallengeRaisedError } from "@bound/agent";
import type { Tool } from "@bound/agent";
import type { AppContext } from "@bound/core";
import type { Logger, McpConfig } from "@bound/shared";
import { TypedEventEmitter } from "@bound/shared";
import {
	connectConfiguredMcpServers,
	diffMcpConfigs,
	reconnectResolvedMcpServer,
	reloadMcpServers,
} from "../commands/start/mcp";

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

describe("connectConfiguredMcpServers", () => {
	it("connects configured servers concurrently and preserves config order in the map", async () => {
		const logger = createMockLogger();
		let inFlight = 0;
		let maxInFlight = 0;

		const configs: MCPServerConfig[] = [
			{ name: "slow", transport: "stdio", command: "slow" },
			{ name: "fast", transport: "stdio", command: "fast" },
		];

		const clientsByName = new Map<string, MCPClient>();
		const createClient = (config: MCPServerConfig): MCPClient => {
			const delayMs = config.name === "slow" ? 30 : 5;
			const client = {
				...makeMockClient(config, [{ name: `${config.name}_tool` } as Tool], false),
				isConnected: () => true,
				connect: async () => {
					inFlight++;
					maxInFlight = Math.max(maxInFlight, inFlight);
					await new Promise((resolve) => setTimeout(resolve, delayMs));
					inFlight--;
				},
			} as unknown as MCPClient;
			clientsByName.set(config.name, client);
			return client;
		};

		const clients = await connectConfiguredMcpServers(configs, logger, createClient);

		expect(maxInFlight).toBe(2);
		expect([...clients.keys()]).toEqual(["slow", "fast"]);
		expect(clients.get("slow")).toBe(clientsByName.get("slow"));
		expect(clients.get("fast")).toBe(clientsByName.get("fast"));
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

	// R-MO13: a connect-time 401 from an oauth-configured server on the RELOAD path
	// must raise a challenge and leave the server reconnectable, NOT dead-fail like a
	// plain connect error. The reload path must thread the same provideAuth hook the
	// startup path uses so the oauth provider is stamped as authProvider before
	// connect (bound-agents/bound MCP OAuth RFC, slice 3.5 wiring parity).
	it("raises a challenge instead of dead-failing an oauth server whose connect 401s", async () => {
		const { appContext, cleanup } = createMockAppContext();
		const mcpClientsMap = new Map<string, MCPClient>();
		const mcpServerNames = new Set<string>();
		const confirmGates = new Map<string, string[]>();

		const oldConfig: McpConfig = { servers: [] };
		const newConfig: McpConfig = {
			servers: [
				{
					name: "oauth-server",
					transport: "http",
					url: "https://mcp.example.com/mcp",
					auth: { type: "oauth" },
				},
			],
		};

		// The provideAuth hook stands in for mcpOAuth.providerFor: it marks the
		// server oauth-configured. The mock client's connect() throws the typed
		// AuthChallengeRaisedError the real provider throws from
		// redirectToAuthorization on a connect-time 401.
		let provideAuthCalled = false;
		const provideAuth = (server: MCPServerConfig): MCPServerConfig => {
			provideAuthCalled = true;
			return { ...server, authProvider: {} as never };
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
			oldConfig,
			newConfig,
			provideAuth,
			createClient: (config) =>
				({
					...makeMockClient(config, [], false),
					connect: async () => {
						throw new AuthChallengeRaisedError(
							"challenge-abc",
							"Authorization required for oauth-server. Run `bound login oauth-server`.",
						);
					},
				}) as unknown as MCPClient,
		});

		// The hook was threaded through (regression guard for the missing-arg bug).
		expect(provideAuthCalled).toBe(true);
		// A raised challenge is NOT a failed connect: the server is pending auth,
		// reconnectable once consent resolves (R-MO13b).
		expect(result.failed).not.toContain("oauth-server");
		expect(result.added).not.toContain("oauth-server");
		cleanup();
	});

	// A plain (non-oauth) connect failure still lands in `failed` — the
	// pending-auth classification must not swallow ordinary connect errors.
	it("still reports a non-oauth connect failure as failed", async () => {
		const { appContext, cleanup } = createMockAppContext();
		const mcpClientsMap = new Map<string, MCPClient>();
		const mcpServerNames = new Set<string>();
		const confirmGates = new Map<string, string[]>();

		const oldConfig: McpConfig = { servers: [] };
		const newConfig: McpConfig = {
			servers: [{ name: "broken", transport: "stdio", command: "nope" }],
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
			oldConfig,
			newConfig,
			createClient: (config) =>
				({
					...makeMockClient(config, [], false),
					connect: async () => {
						throw new Error("connection refused");
					},
				}) as unknown as MCPClient,
		});

		expect(result.failed).toContain("broken");
		cleanup();
	});
});

describe("reconnectResolvedMcpServer (R-MO13b + §7 smoke 2026-10-10)", () => {
	// A resolved OAuth grant must reconnect the parked client IN PLACE and refresh
	// the capability surface — re-list tools, re-register sandbox commands, and
	// rewrite hosts.mcp_capabilities — so the web UI Connections view and the
	// sandbox see the server's tools WITHOUT a daemon restart. Reconnect-only (the
	// pre-fix behavior) re-established the session but left the inventory stale.
	const commandCtx = (
		appContext: { db: unknown; siteId: string; eventBus: unknown; logger: unknown },
		map: Map<string, MCPClient>,
	) => ({
		db: appContext.db,
		siteId: appContext.siteId,
		eventBus: appContext.eventBus,
		logger: appContext.logger,
		mcpClients: map,
	});

	it("reconnects, re-lists tools, and updates the host capability inventory", async () => {
		const { appContext, cleanup } = createMockAppContext();
		let connectCalls = 0;
		const registeredCommandNames: string[] = [];
		const sandbox = {
			bash: {
				registerCommand: (cmd: { name: string }) => {
					registeredCommandNames.push(cmd.name);
				},
			},
		};
		const client = {
			...makeMockClient({ name: "sentry", transport: "http", url: "https://mcp.sentry.dev/mcp" }, [
				{ name: "find_issues" } as Tool,
				{ name: "get_issue" } as Tool,
			]),
			isConnected: () => true,
			getServerDescription: () => "Sentry MCP",
			getServerInstructions: () => undefined,
			getServerInfo: () => ({ name: "sentry", version: "1.0.0" }),
			getServerCapabilities: () => ({ tools: {} }),
			connect: async () => {
				connectCalls++;
			},
		} as unknown as MCPClient;

		const mcpClientsMap = new Map<string, MCPClient>([["sentry", client]]);
		const mcpServerNames = new Set(["sentry"]);
		const confirmGates = new Map<string, string[]>();

		await reconnectResolvedMcpServer({
			appContext: appContext as unknown as AppContext,
			mcpClientsMap,
			mcpServerNames,
			confirmGates,
			sandbox,
			commandContext: commandCtx(appContext, mcpClientsMap),
			serverName: "sentry",
		});

		// Reconnect ran, and the sandbox got a command re-registered for the server.
		expect(connectCalls).toBe(1);
		expect(registeredCommandNames).toContain("sentry");

		// hosts.mcp_capabilities now carries the server's tools — the web UI source.
		const row = appContext.db
			.query("SELECT mcp_tools, mcp_capabilities FROM hosts WHERE site_id = ?")
			.get(appContext.siteId) as { mcp_tools: string | null; mcp_capabilities: string | null };
		expect(row.mcp_tools ?? "").toContain("sentry");
		const caps = JSON.parse(row.mcp_capabilities ?? "{}");
		expect(caps.sentry?.tools?.map((t: { name: string }) => t.name).sort()).toEqual([
			"find_issues",
			"get_issue",
		]);
		cleanup();
	});

	it("is a no-op for a server not in the client map (idempotent)", async () => {
		const { appContext, cleanup } = createMockAppContext();
		const mcpClientsMap = new Map<string, MCPClient>();
		const mcpServerNames = new Set<string>();
		const confirmGates = new Map<string, string[]>();

		// No throw, no host row write for an unknown server.
		await reconnectResolvedMcpServer({
			appContext: appContext as unknown as AppContext,
			mcpClientsMap,
			mcpServerNames,
			confirmGates,
			sandbox: null,
			commandContext: commandCtx(appContext, mcpClientsMap),
			serverName: "never-configured",
		});

		const row = appContext.db
			.query("SELECT mcp_tools FROM hosts WHERE site_id = ?")
			.get(appContext.siteId) as { mcp_tools: string | null };
		expect(row.mcp_tools ?? "").not.toContain("never-configured");
		cleanup();
	});

	it("leaves the client parked (does not throw) when reconnect fails", async () => {
		const { appContext, cleanup } = createMockAppContext();
		const client = {
			...makeMockClient(
				{ name: "sentry", transport: "http", url: "https://mcp.sentry.dev/mcp" },
				[],
				false,
			),
			isConnected: () => false,
			connect: async () => {
				throw new Error("transport refused");
			},
		} as unknown as MCPClient;

		const mcpClientsMap = new Map<string, MCPClient>([["sentry", client]]);
		const mcpServerNames = new Set(["sentry"]);
		const confirmGates = new Map<string, string[]>();

		// A reconnect failure does not throw and does not un-resolve the grant: the
		// client stays in the map, parked and reconnectable (R-MO13b).
		await reconnectResolvedMcpServer({
			appContext: appContext as unknown as AppContext,
			mcpClientsMap,
			mcpServerNames,
			confirmGates,
			sandbox: null,
			commandContext: commandCtx(appContext, mcpClientsMap),
			serverName: "sentry",
		});

		expect(mcpClientsMap.get("sentry")).toBe(client);
		cleanup();
	});
});
