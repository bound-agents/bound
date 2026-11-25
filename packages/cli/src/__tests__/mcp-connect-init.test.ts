import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { MCPClient, MCPServerConfig, Tool } from "@bound/agent";
import {
	AuthChallengeRaisedError,
	McpOAuthProvider,
	McpTokenStore,
	RaiseDebouncer,
} from "@bound/agent";
import type { AppContext } from "@bound/core";
import { applySchema, createDatabase } from "@bound/core";
import type { Logger, McpConfig } from "@bound/shared";
import { TypedEventEmitter } from "@bound/shared";
import { connectConfiguredMcpServers, initMcp } from "../commands/start/mcp";

/**
 * Behavioral coverage for connectMcpServer's uncovered branches (reached via
 * connectConfiguredMcpServers) and initMcp: the pending-auth hold on an
 * AuthChallengeRaisedError, disconnect-on-connect-failure, the provideAuth
 * wiring hook, and initMcp's confirm-gate extraction + no-servers path.
 */

function makeLogger(): Logger & { entries: Array<{ level: string; msg: string }> } {
	const entries: Array<{ level: string; msg: string }> = [];
	const mk = (level: string) => (msg: string) => entries.push({ level, msg });
	return {
		debug: () => {},
		info: mk("info"),
		warn: mk("warn"),
		error: mk("error"),
		entries,
	} as Logger & { entries: Array<{ level: string; msg: string }> };
}

function mockClient(
	cfg: MCPServerConfig,
	opts: {
		tools?: Tool[];
		connect?: () => Promise<void>;
		connected?: boolean;
		onDisconnect?: () => void;
	} = {},
): MCPClient {
	let connected = opts.connected ?? false;
	return {
		getConfig: () => cfg,
		isConnected: () => connected,
		connect: async () => {
			if (opts.connect) {
				await opts.connect();
			}
			connected = true;
		},
		disconnect: async () => {
			opts.onDisconnect?.();
			connected = false;
		},
		listTools: async () => opts.tools ?? [],
		listResources: async () => [],
		listPrompts: async () => [],
		callTool: async () => ({ content: "", isError: false }),
		readResource: async () => ({ uri: "", content: "" }),
		invokePrompt: async () => ({ messages: [] }),
		getServerDescription: () => undefined,
		getServerInstructions: () => undefined,
		getServerInfo: () => ({ name: cfg.name, version: "1.0.0" }),
		getServerCapabilities: () => ({ tools: {} }),
	} as unknown as MCPClient;
}

describe("connectConfiguredMcpServers — connect outcomes", () => {
	it("holds a pending-auth client in the map when connect raises AuthChallengeRaisedError", async () => {
		const logger = makeLogger();
		const cfg: MCPServerConfig = {
			name: "oauth-srv",
			transport: "http",
			url: "https://x.example/mcp",
		} as unknown as MCPServerConfig;
		const client = mockClient(cfg, {
			connect: async () => {
				throw new AuthChallengeRaisedError("chal-1", "auth_challenge_raised");
			},
		});

		const map = await connectConfiguredMcpServers([cfg], logger, () => client);

		// R-MO13: the server is held reconnectable, not dropped.
		expect(map.get("oauth-srv")).toBe(client);
		expect(logger.entries.some((e) => e.level === "info" && e.msg.includes("chal-1"))).toBe(true);
	});

	it("disconnects a connected client when listTools throws, and omits it from the map", async () => {
		const logger = makeLogger();
		const cfg: MCPServerConfig = {
			name: "flaky",
			transport: "stdio",
			command: "x",
		} as unknown as MCPServerConfig;
		let disconnected = false;
		const client = {
			...mockClient(cfg),
			isConnected: () => true,
			connect: async () => {},
			listTools: async () => {
				throw new Error("listTools boom");
			},
			disconnect: async () => {
				disconnected = true;
			},
		} as unknown as MCPClient;

		const map = await connectConfiguredMcpServers([cfg], logger, () => client);

		expect(map.has("flaky")).toBe(false);
		expect(disconnected).toBe(true);
		expect(logger.entries.some((e) => e.level === "warn" && e.msg.includes("flaky"))).toBe(true);
	});

	it("applies provideAuth to the config before building the client", async () => {
		const logger = makeLogger();
		const cfg: MCPServerConfig = {
			name: "srv",
			transport: "http",
			url: "https://x.example/mcp",
		} as unknown as MCPServerConfig;
		let sawAuthStamp = false;
		const provideAuth = (s: MCPServerConfig): MCPServerConfig =>
			({ ...s, authProvider: {} }) as unknown as MCPServerConfig;
		const createClient = (effective: MCPServerConfig): MCPClient => {
			sawAuthStamp = "authProvider" in effective;
			return mockClient(effective, { tools: [{ name: "t" } as Tool] });
		};

		const map = await connectConfiguredMcpServers([cfg], logger, createClient, provideAuth);

		expect(sawAuthStamp).toBe(true);
		expect(map.get("srv")).toBeDefined();
	});
});

describe("initMcp", () => {
	let db: ReturnType<typeof createDatabase>;
	const SITE = "mcp-site";

	beforeEach(() => {
		db = createDatabase(":memory:");
		applySchema(db);
		db.run("INSERT INTO hosts (site_id, host_name, modified_at, deleted) VALUES (?, ?, ?, 0)", [
			SITE,
			"mcp-host",
			new Date().toISOString(),
		]);
	});

	afterEach(() => {
		db.close();
	});

	function appContext(mcp?: McpConfig): AppContext {
		return {
			db,
			siteId: SITE,
			hostName: "mcp-host",
			logger: makeLogger(),
			optionalConfig: mcp ? { mcp: { ok: true, value: mcp } } : {},
			eventBus: new TypedEventEmitter(),
		} as unknown as AppContext;
	}

	it("reports no servers configured when mcp config is absent", async () => {
		const ctx = appContext();
		const result = await initMcp(ctx);
		expect(result.mcpClientsMap.size).toBe(0);
		expect(result.mcpServerNames.size).toBe(0);
		expect(
			(ctx.logger as unknown as { entries: Array<{ msg: string }> }).entries.some((e) =>
				e.msg.includes("No MCP servers configured"),
			),
		).toBe(true);
	});

	it("extracts confirm gates from the mcp config for a connecting server", async () => {
		const mcp: McpConfig = {
			servers: [
				{
					name: "gated",
					transport: "stdio",
					command: "x",
					confirm: ["dangerous_tool"],
				},
			],
		} as unknown as McpConfig;
		const ctx = appContext(mcp);

		// Stub the default MCPClient path by making initMcp connect fail; the
		// confirm-gate map is built independently of connection success, so it
		// still reflects the config after initMcp returns.
		const result = await initMcp(ctx);
		expect(result.confirmGates.get("gated")).toEqual(["dangerous_tool"]);
	});
});

describe("connectConfiguredMcpServers — disconnect on partial failure", () => {
	it("disconnects a connected client when connect itself throws after connecting", async () => {
		const logger = makeLogger();
		const cfg: MCPServerConfig = {
			name: "partial",
			transport: "stdio",
			command: "x",
		} as unknown as MCPServerConfig;
		let disconnected = false;
		// connect() throws, but isConnected() reports true → the catch runs the
		// best-effort disconnect (mcp.ts 111-116).
		const client = {
			...mockClient(cfg),
			isConnected: () => true,
			connect: async () => {
				throw new Error("handshake failed mid-connect");
			},
			disconnect: async () => {
				disconnected = true;
			},
		} as unknown as MCPClient;

		const map = await connectConfiguredMcpServers([cfg], logger, () => client);
		expect(map.has("partial")).toBe(false);
		expect(disconnected).toBe(true);
	});

	it("swallows a disconnect error during cleanup (best-effort)", async () => {
		const logger = makeLogger();
		const cfg: MCPServerConfig = {
			name: "noisy",
			transport: "stdio",
			command: "x",
		} as unknown as MCPServerConfig;
		const client = {
			...mockClient(cfg),
			isConnected: () => true,
			connect: async () => {
				throw new Error("connect boom");
			},
			disconnect: async () => {
				throw new Error("disconnect also boom");
			},
		} as unknown as MCPClient;

		// The disconnect throw is caught internally; connectConfiguredMcpServers
		// still resolves and reports the server as failed (not in the map).
		const map = await connectConfiguredMcpServers([cfg], logger, () => client);
		expect(map.has("noisy")).toBe(false);
	});
});

describe("reloadMcpServers — injected-client connect outcomes", () => {
	function makeAppCtx() {
		const db = createDatabase(":memory:");
		applySchema(db);
		const siteId = "reload-site";
		db.run("INSERT INTO hosts (site_id, host_name, modified_at, deleted) VALUES (?, ?, ?, 0)", [
			siteId,
			"reload-host",
			new Date().toISOString(),
		]);
		return {
			db,
			siteId,
			hostName: "reload-host",
			logger: makeLogger(),
			optionalConfig: {},
			eventBus: new TypedEventEmitter(),
		} as unknown as AppContext;
	}

	it("adds a server via an injected succeeding client and registers its bash command", async () => {
		const { reloadMcpServers } = await import("../commands/start/mcp");
		const ctx = makeAppCtx();
		const mcpClientsMap = new Map<string, MCPClient>();
		const mcpServerNames = new Set<string>();
		const confirmGates = new Map<string, string[]>();
		const registered: string[] = [];
		const sandbox = { bash: { registerCommand: (c: { name: string }) => registered.push(c.name) } };

		const newServer = { name: "added-srv", transport: "stdio", command: "x", confirm: ["danger"] };
		const result = await reloadMcpServers({
			appContext: ctx,
			mcpClientsMap,
			mcpServerNames,
			confirmGates,
			sandbox,
			commandContext: {
				db: ctx.db,
				siteId: ctx.siteId,
				eventBus: ctx.eventBus,
				logger: ctx.logger,
				mcpClients: mcpClientsMap,
			},
			oldConfig: { servers: [] } as unknown as McpConfig,
			newConfig: { servers: [newServer] } as unknown as McpConfig,
			createClient: (cfg) => mockClient(cfg, { tools: [{ name: "t1" } as Tool] }),
		});

		expect(result.added).toContain("added-srv");
		expect(mcpClientsMap.has("added-srv")).toBe(true);
		expect(confirmGates.get("added-srv")).toEqual(["danger"]);
		(ctx.db as unknown as { close: () => void }).close();
	});

	it("reports a changed server as changed (not added) and holds a pending-auth one in pendingAuth", async () => {
		const { reloadMcpServers } = await import("../commands/start/mcp");
		const ctx = makeAppCtx();
		const existing = mockClient(
			{ name: "chg", transport: "stdio", command: "old" } as unknown as MCPServerConfig,
			{},
		);
		const mcpClientsMap = new Map<string, MCPClient>([["chg", existing]]);
		const mcpServerNames = new Set<string>(["chg"]);
		const confirmGates = new Map<string, string[]>();

		const createClient = (cfg: MCPServerConfig): MCPClient => {
			if (cfg.name === "oauth-add") {
				return mockClient(cfg, {
					connect: async () => {
						throw new AuthChallengeRaisedError("chal-x", "auth_challenge_raised");
					},
				});
			}
			return mockClient(cfg, { tools: [{ name: "tool" } as Tool] });
		};

		const result = await reloadMcpServers({
			appContext: ctx,
			mcpClientsMap,
			mcpServerNames,
			confirmGates,
			sandbox: null,
			commandContext: {
				db: ctx.db,
				siteId: ctx.siteId,
				eventBus: ctx.eventBus,
				logger: ctx.logger,
				mcpClients: mcpClientsMap,
			},
			oldConfig: {
				servers: [{ name: "chg", transport: "stdio", command: "old" }],
			} as unknown as McpConfig,
			newConfig: {
				servers: [
					{ name: "chg", transport: "stdio", command: "new" },
					{ name: "oauth-add", transport: "http", url: "https://x.example/mcp" },
				],
			} as unknown as McpConfig,
			createClient,
		});

		expect(result.changed).toContain("chg");
		expect(result.added).not.toContain("chg");
		expect(result.pendingAuth).toContain("oauth-add");
		expect(mcpClientsMap.has("oauth-add")).toBe(true);
		(ctx.db as unknown as { close: () => void }).close();
	});
});

describe("connectConfiguredMcpServers — terminal OAuth rejection (#299)", () => {
	function oauthSetup() {
		const db = createDatabase(":memory:");
		applySchema(db);
		const store = new McpTokenStore(
			join(tmpdir(), `mcp-auth-${randomBytes(4).toString("hex")}`, "mcp-auth.json"),
		);
		const provider = new McpOAuthProvider(
			db,
			store,
			{ name: "sentry", url: "https://mcp.sentry.dev/mcp" },
			"site-a",
			new RaiseDebouncer(),
		);
		const cfg = {
			name: "sentry",
			transport: "http",
			url: "https://mcp.sentry.dev/mcp",
			auth: { type: "oauth" },
		} as unknown as MCPServerConfig;
		const provideAuth = (s: MCPServerConfig): MCPServerConfig =>
			({ ...s, authProvider: provider }) as unknown as MCPServerConfig;
		return { db, provider, cfg, provideAuth };
	}

	it("holds the client pending-auth when the provider maps the escaped error to a challenge", async () => {
		const logger = makeLogger();
		const { db, provider, cfg, provideAuth } = oauthSetup();
		const escaped = new Error("Grant not found");
		let seen: unknown;
		provider.raiseIfGrantLost = async (e: unknown) => {
			seen = e;
			return new AuthChallengeRaisedError("chal-lost", "auth_challenge_raised");
		};
		const client = mockClient(cfg, {
			connect: async () => {
				throw escaped;
			},
		});

		const map = await connectConfiguredMcpServers([cfg], logger, () => client, provideAuth);

		expect(seen).toBe(escaped);
		expect(map.get("sentry")).toBe(client);
		expect(logger.entries.some((e) => e.level === "info" && e.msg.includes("chal-lost"))).toBe(
			true,
		);
		expect(logger.entries.some((e) => e.level === "warn")).toBe(false);
		db.close();
	});

	it("still drops the client with a WARN for a non-OAuth connect failure", async () => {
		const logger = makeLogger();
		const { db, cfg, provideAuth } = oauthSetup();
		const client = mockClient(cfg, {
			connect: async () => {
				throw new TypeError("fetch failed");
			},
		});

		const map = await connectConfiguredMcpServers([cfg], logger, () => client, provideAuth);

		expect(map.has("sentry")).toBe(false);
		expect(logger.entries.some((e) => e.level === "warn" && e.msg.includes("sentry"))).toBe(true);
		db.close();
	});
});
