import type Database from "bun:sqlite";
import { describe, expect, it } from "bun:test";
import type { CommandContext } from "@bound/sandbox";
import type { Logger } from "@bound/shared";
import { TypedEventEmitter } from "@bound/shared";
import { generateMCPCommands, updateHostMCPInfo } from "../mcp-bridge";
import type { MCPClient, MCPServerConfig, Prompt, Resource, Tool } from "../mcp-client";

// Helper to create mock CommandContext
function createMockCommandContext(overrides?: Partial<CommandContext>): CommandContext {
	const eventBus = new TypedEventEmitter();
	const logger: Logger = {
		debug: () => {},
		info: () => {},
		warn: () => {},
		error: () => {},
	};

	return {
		db: {} as Database,
		siteId: "test",
		eventBus,
		logger,
		...overrides,
	};
}

/**
 * Build a minimal MCPClient stand-in for bridge tests.
 * Avoids spawning real processes while still exercising the bridge logic.
 */
function makeMockClient(
	config: MCPServerConfig,
	tools: Tool[],
	resources: Resource[],
	prompts: Prompt[],
): MCPClient {
	return {
		getConfig: () => config,
		isConnected: () => true,
		listTools: async () => tools,
		listResources: async () => resources,
		listPrompts: async () => prompts,
		callTool: async (name: string, args: Record<string, unknown>) => ({
			content: `Tool ${name} called with args: ${JSON.stringify(args)}`,
			isError: false,
		}),
		readResource: async (uri: string) => ({
			uri,
			content: `Content of ${uri}`,
		}),
		invokePrompt: async (name: string, args: Record<string, string>) => ({
			messages: [
				{ role: "system", content: `Prompt ${name} invoked with args: ${JSON.stringify(args)}` },
			],
		}),
		connect: async () => {},
		disconnect: async () => {},
		getServerDescription: () => undefined,
		getServerInstructions: () => undefined,
		getServerInfo: () => undefined,
	} as unknown as MCPClient;
}

describe("MCP Bridge", () => {
	it("generates commands from MCP tools", async () => {
		const client = makeMockClient(
			{ name: "test-server", transport: "stdio", command: "test" },
			[
				{
					name: "greet",
					description: "Greet someone",
					inputSchema: { type: "object", properties: { name: { type: "string" } } },
				},
				{
					name: "calculate",
					description: "Calculate something",
					inputSchema: { type: "object", properties: { expr: { type: "string" } } },
				},
			],
			[],
			[],
		);

		const clients = new Map([["test-server", client]]);
		const { commands, serverNames } = await generateMCPCommands(clients);

		// Should have generated 1 server command plus 4 MCP access commands
		expect(commands.length).toBe(5); // 1 server command + 4 meta-commands
		expect(commands.map((c) => c.name)).toContain("test-server");
		expect(serverNames).toEqual(new Set(["test-server"]));
		// Verify meta-commands still present
		expect(commands.map((c) => c.name)).toContain("resources");
		expect(commands.map((c) => c.name)).toContain("resource");
		expect(commands.map((c) => c.name)).toContain("prompts");
		expect(commands.map((c) => c.name)).toContain("prompt");
	});

	it("applies allow_tools filter", async () => {
		const client = makeMockClient(
			{ name: "filtered-server", transport: "stdio", command: "test", allow_tools: ["allowed"] },
			[
				{ name: "allowed", description: "This tool is allowed", inputSchema: {} },
				{ name: "blocked", description: "This tool is blocked", inputSchema: {} },
			],
			[],
			[],
		);

		const clients = new Map([["filtered-server", client]]);
		const { commands } = await generateMCPCommands(clients);

		// The server-level command exists
		const serverCmd = commands.find((c) => c.name === "filtered-server");
		expect(serverCmd).toBeDefined();

		// To verify filtering, call the command handler with the blocked subcommand
		if (serverCmd) {
			const mockCtx = createMockCommandContext();
			const resultBlocked = await serverCmd.handler({ subcommand: "blocked" }, mockCtx);
			expect(resultBlocked.exitCode).toBe(1);
			expect(resultBlocked.stderr).toContain("Unknown subcommand");

			// And verify allowed works
			const resultAllowed = await serverCmd.handler({ subcommand: "allowed" }, mockCtx);
			expect(resultAllowed.exitCode).toBe(0);
		}
	});

	it("blocks confirmed tools in autonomous mode", async () => {
		const client = makeMockClient(
			{ name: "confirm-server", transport: "stdio", command: "test", confirm: ["dangerous"] },
			[{ name: "dangerous", description: "Dangerous operation", inputSchema: {} }],
			[],
			[],
		);

		const clients = new Map([["confirm-server", client]]);
		const confirmGates = new Map([["confirm-server", ["dangerous"]]]);
		const { commands } = await generateMCPCommands(clients, confirmGates);

		const serverCmd = commands.find((c) => c.name === "confirm-server");
		expect(serverCmd).toBeDefined();

		if (serverCmd) {
			const mockCtx = createMockCommandContext({ taskId: "some-task-id" });
			const result = await serverCmd.handler({ subcommand: "dangerous" }, mockCtx);
			expect(result.exitCode).toBe(1);
			expect(result.stderr).toContain("confirmation");
		}
	});

	it("lists resources from all servers", async () => {
		const client1 = makeMockClient(
			{ name: "server1", transport: "stdio", command: "test" },
			[],
			[{ uri: "resource://file1", name: "File 1", description: "First file" }],
			[],
		);

		const client2 = makeMockClient(
			{ name: "server2", transport: "stdio", command: "test" },
			[],
			[{ uri: "resource://file2", name: "File 2", description: "Second file" }],
			[],
		);

		const clients = new Map([
			["server1", client1],
			["server2", client2],
		]);

		const { commands } = await generateMCPCommands(clients);
		const resourcesCmd = commands.find((c) => c.name === "resources");

		expect(resourcesCmd).toBeDefined();

		if (resourcesCmd) {
			const mockCtx = createMockCommandContext();
			const result = await resourcesCmd.handler({}, mockCtx);
			expect(result.exitCode).toBe(0);
			expect(result.stdout).toContain("resource://file1");
			expect(result.stdout).toContain("resource://file2");
		}
	});

	it("reads a specific resource", async () => {
		const client = makeMockClient(
			{ name: "test-server", transport: "stdio", command: "test" },
			[],
			[
				{
					uri: "resource://test",
					name: "Test",
					description: "Test resource",
					mimeType: "text/plain",
				},
			],
			[],
		);

		const clients = new Map([["test-server", client]]);
		const { commands } = await generateMCPCommands(clients);
		const resourceCmd = commands.find((c) => c.name === "resource");

		expect(resourceCmd).toBeDefined();

		if (resourceCmd) {
			const mockCtx = createMockCommandContext();
			const result = await resourceCmd.handler({ uri: "resource://test" }, mockCtx);
			expect(result.exitCode).toBe(0);
			expect(result.stdout).toContain("resource://test");
		}
	});

	it("lists prompts from all servers", async () => {
		const client = makeMockClient(
			{ name: "test-server", transport: "stdio", command: "test" },
			[],
			[],
			[{ name: "test-prompt", description: "A test prompt" }],
		);

		const clients = new Map([["test-server", client]]);
		const { commands } = await generateMCPCommands(clients);
		const promptsCmd = commands.find((c) => c.name === "prompts");

		expect(promptsCmd).toBeDefined();

		if (promptsCmd) {
			const mockCtx = createMockCommandContext();
			const result = await promptsCmd.handler({}, mockCtx);
			expect(result.exitCode).toBe(0);
			expect(result.stdout).toContain("test-prompt");
		}
	});

	it("invokes a prompt with arguments", async () => {
		const client = makeMockClient(
			{ name: "test-server", transport: "stdio", command: "test" },
			[],
			[],
			[
				{
					name: "greet",
					description: "Greet someone",
					arguments: [{ name: "name", description: "Person to greet" }],
				},
			],
		);

		const clients = new Map([["test-server", client]]);
		const { commands } = await generateMCPCommands(clients);
		const promptCmd = commands.find((c) => c.name === "prompt");

		expect(promptCmd).toBeDefined();

		if (promptCmd) {
			const mockCtx = createMockCommandContext();
			const result = await promptCmd.handler(
				{ name: "test-server/greet", person: "Alice" },
				mockCtx,
			);
			expect(result.exitCode).toBe(0);
		}
	});

	// AC1.1: returns one CommandDefinition per connected server
	it("returns one CommandDefinition per connected server", async () => {
		const client = makeMockClient(
			{ name: "single-server", transport: "stdio", command: "test" },
			[
				{ name: "tool1", description: "First tool", inputSchema: {} },
				{ name: "tool2", description: "Second tool", inputSchema: {} },
			],
			[],
			[],
		);

		const clients = new Map([["single-server", client]]);
		const { commands, serverNames } = await generateMCPCommands(clients);

		// 1 server command + 4 meta-commands
		expect(commands.length).toBe(5);
		expect(serverNames.size).toBe(1);
		expect(serverNames).toEqual(new Set(["single-server"]));
		expect(commands.map((c) => c.name)).toContain("single-server");
	});

	// AC1.2: returns three server commands for three servers
	it("returns three server commands for three servers", async () => {
		const client1 = makeMockClient(
			{ name: "server-1", transport: "stdio", command: "test" },
			[{ name: "tool1", description: "Tool", inputSchema: {} }],
			[],
			[],
		);
		const client2 = makeMockClient(
			{ name: "server-2", transport: "stdio", command: "test" },
			[{ name: "tool2", description: "Tool", inputSchema: {} }],
			[],
			[],
		);
		const client3 = makeMockClient(
			{ name: "server-3", transport: "stdio", command: "test" },
			[{ name: "tool3", description: "Tool", inputSchema: {} }],
			[],
			[],
		);

		const clients = new Map([
			["server-1", client1],
			["server-2", client2],
			["server-3", client3],
		]);
		const { commands, serverNames } = await generateMCPCommands(clients);

		// 3 server commands + 4 meta-commands
		expect(commands.length).toBe(7);
		expect(serverNames.size).toBe(3);
		expect(serverNames).toEqual(new Set(["server-1", "server-2", "server-3"]));
	});

	// AC1.3: dispatches valid subcommand to callTool with correct args
	it("dispatches valid subcommand to callTool with correct args", async () => {
		const client = makeMockClient(
			{ name: "dispatch-server", transport: "stdio", command: "test" },
			[
				{
					name: "greet",
					description: "Greet someone",
					inputSchema: { properties: { name: { type: "string" } } },
				},
			],
			[],
			[],
		);

		const clients = new Map([["dispatch-server", client]]);
		const { commands } = await generateMCPCommands(clients);

		const serverCmd = commands.find((c) => c.name === "dispatch-server");
		expect(serverCmd).toBeDefined();

		if (serverCmd) {
			const mockCtx = createMockCommandContext();
			const result = await serverCmd.handler({ subcommand: "greet", name: "Alice" }, mockCtx);
			expect(result.exitCode).toBe(0);
			expect(result.stdout).toContain("Tool greet called");
			expect(result.stdout).toContain("Alice");
		}
	});

	it("coerces string args to schema types (number, boolean, enum)", async () => {
		const client = makeMockClient(
			{ name: "typed-server", transport: "stdio", command: "test" },
			[
				{
					name: "list_commits",
					description: "List commits",
					inputSchema: {
						properties: {
							owner: { type: "string" },
							repo: { type: "string" },
							perPage: { type: "number" },
							recursive: { type: "boolean" },
							state: { type: "string", enum: ["OPEN", "CLOSED", "MERGED"] },
						},
						required: ["owner", "repo"],
					},
				},
			],
			[],
			[],
		);

		const clients = new Map([["typed-server", client]]);
		const { commands } = await generateMCPCommands(clients);
		const serverCmd = commands.find((c) => c.name === "typed-server");
		expect(serverCmd).toBeDefined();

		if (serverCmd) {
			const mockCtx = createMockCommandContext();
			// Args arrive as strings from bash --key value parsing
			const result = await serverCmd.handler(
				{
					subcommand: "list_commits",
					owner: "karashiiro",
					repo: "bound",
					perPage: "5",
					recursive: "true",
					state: "open",
				},
				mockCtx,
			);
			expect(result.exitCode).toBe(0);
			// callTool receives the args — check they were coerced
			const output = result.stdout;
			// Number coercion: "5" → 5
			expect(output).toContain('"perPage":5');
			expect(output).not.toContain('"perPage":"5"');
			// Boolean coercion: "true" → true
			expect(output).toContain('"recursive":true');
			expect(output).not.toContain('"recursive":"true"');
			// Enum case normalization: "open" → "OPEN"
			expect(output).toContain('"state":"OPEN"');
			expect(output).not.toContain('"state":"open"');
		}
	});

	// AC1.4: returns error for unknown subcommand
	it("returns error for unknown subcommand", async () => {
		const client = makeMockClient(
			{ name: "error-server", transport: "stdio", command: "test" },
			[{ name: "known", description: "Known tool", inputSchema: {} }],
			[],
			[],
		);

		const clients = new Map([["error-server", client]]);
		const { commands } = await generateMCPCommands(clients);

		const serverCmd = commands.find((c) => c.name === "error-server");
		expect(serverCmd).toBeDefined();

		if (serverCmd) {
			const mockCtx = createMockCommandContext();
			const result = await serverCmd.handler({ subcommand: "nonexistent" }, mockCtx);
			expect(result.exitCode).toBe(1);
			expect(result.stderr).toContain("Unknown subcommand");
			expect(result.stderr).toContain("Available subcommands");
		}
	});

	// AC1.5: disconnected server produces no command
	it("disconnected server produces no command", async () => {
		const disconnectedClient: MCPClient = {
			getConfig: () => ({ name: "disconnected", transport: "stdio", command: "test" }),
			isConnected: () => false,
			listTools: async () => [],
			listResources: async () => [],
			listPrompts: async () => [],
			callTool: async () => ({ content: "", isError: false }),
			readResource: async (uri) => ({ uri, content: "" }),
			invokePrompt: async () => ({ messages: [] }),
			connect: async () => {},
			disconnect: async () => {},
			getServerDescription: () => undefined,
			getServerInstructions: () => undefined,
		} as unknown as MCPClient;

		const clients = new Map([["disconnected", disconnectedClient]]);
		const { commands, serverNames } = await generateMCPCommands(clients);

		// Only 4 meta-commands, no server command
		expect(commands.length).toBe(4);
		expect(serverNames.size).toBe(0);
		expect(commands.map((c) => c.name)).not.toContain("disconnected");
	});

	// AC2.1 & AC2.3: no-args handler returns server-level listing
	it("no-args handler returns server-level listing", async () => {
		const client = makeMockClient(
			{ name: "help-server", transport: "stdio", command: "test" },
			[
				{ name: "tool1", description: "First tool", inputSchema: {} },
				{ name: "tool2", description: "Second tool", inputSchema: {} },
			],
			[],
			[],
		);

		const clients = new Map([["help-server", client]]);
		const { commands } = await generateMCPCommands(clients);

		const serverCmd = commands.find((c) => c.name === "help-server");
		expect(serverCmd).toBeDefined();

		if (serverCmd) {
			const mockCtx = createMockCommandContext();
			const result = await serverCmd.handler({}, mockCtx);
			expect(result.exitCode).toBe(0);
			expect(result.stdout).toContain("help-server subcommands");
			expect(result.stdout).toContain("tool1");
			expect(result.stdout).toContain("tool2");
			expect(result.stdout).toContain("First tool");
			expect(result.stdout).toContain("Second tool");
		}
	});

	// AC2.1: --help only returns server-level listing
	it("--help only returns server-level listing", async () => {
		const client = makeMockClient(
			{ name: "help-server", transport: "stdio", command: "test" },
			[{ name: "tool1", description: "First tool", inputSchema: {} }],
			[],
			[],
		);

		const clients = new Map([["help-server", client]]);
		const { commands } = await generateMCPCommands(clients);

		const serverCmd = commands.find((c) => c.name === "help-server");
		expect(serverCmd).toBeDefined();

		if (serverCmd) {
			const mockCtx = createMockCommandContext();
			const result = await serverCmd.handler({ help: "true" }, mockCtx);
			expect(result.exitCode).toBe(0);
			expect(result.stdout).toContain("help-server subcommands");
			expect(result.stdout).toContain("tool1");
		}
	});

	// AC2.1/AC2.3 LLM convention: subcommand='help' returns server-level listing
	it("subcommand='help' returns server-level listing (LLM convention)", async () => {
		const client = makeMockClient(
			{ name: "help-server", transport: "stdio", command: "test" },
			[
				{ name: "action1", description: "Action", inputSchema: {} },
				{ name: "action2", description: "Another action", inputSchema: {} },
			],
			[],
			[],
		);

		const clients = new Map([["help-server", client]]);
		const { commands } = await generateMCPCommands(clients);

		const serverCmd = commands.find((c) => c.name === "help-server");
		expect(serverCmd).toBeDefined();

		if (serverCmd) {
			const mockCtx = createMockCommandContext();
			const result = await serverCmd.handler({ subcommand: "help" }, mockCtx);
			expect(result.exitCode).toBe(0);
			expect(result.stdout).toContain("help-server subcommands");
			expect(result.stdout).toContain("action1");
			expect(result.stdout).toContain("action2");
		}
	});

	// AC2.2: subcommand + --help returns param table
	it("subcommand + --help returns param table", async () => {
		const client = makeMockClient(
			{ name: "param-server", transport: "stdio", command: "test" },
			[
				{
					name: "create_issue",
					description: "Create an issue",
					inputSchema: {
						type: "object",
						properties: {
							title: { type: "string", description: "Issue title" },
							owner: { type: "string", description: "Issue owner" },
						},
						required: ["title"],
					},
				},
			],
			[],
			[],
		);

		const clients = new Map([["param-server", client]]);
		const { commands } = await generateMCPCommands(clients);

		const serverCmd = commands.find((c) => c.name === "param-server");
		expect(serverCmd).toBeDefined();

		if (serverCmd) {
			const mockCtx = createMockCommandContext();
			const result = await serverCmd.handler({ subcommand: "create_issue", help: "true" }, mockCtx);
			expect(result.exitCode).toBe(0);
			expect(result.stdout).toContain("create_issue");
			expect(result.stdout).toContain("Create an issue");
			expect(result.stdout).toContain("title");
			expect(result.stdout).toContain("(required)");
			expect(result.stdout).toContain("owner");
			expect(result.stdout).toContain("(optional)");
			expect(result.stdout).toContain("Issue title");
			expect(result.stdout).toContain("Issue owner");
		}
	});

	// AC2.4: help listing only shows allow_tools-filtered subcommands
	it("help listing only shows allow_tools-filtered subcommands", async () => {
		const client = makeMockClient(
			{ name: "filtered-help", transport: "stdio", command: "test", allow_tools: ["allowed"] },
			[
				{ name: "allowed", description: "Allowed tool", inputSchema: {} },
				{ name: "blocked", description: "Blocked tool", inputSchema: {} },
			],
			[],
			[],
		);

		const clients = new Map([["filtered-help", client]]);
		const { commands } = await generateMCPCommands(clients);

		const serverCmd = commands.find((c) => c.name === "filtered-help");
		expect(serverCmd).toBeDefined();

		if (serverCmd) {
			const mockCtx = createMockCommandContext();
			const result = await serverCmd.handler({}, mockCtx);
			expect(result.exitCode).toBe(0);
			expect(result.stdout).toContain("allowed");
			expect(result.stdout).not.toContain("blocked");
		}
	});

	// AC3.1: allow_tools blocks non-allowed subcommands
	it("allow_tools blocks non-allowed subcommands", async () => {
		const client = makeMockClient(
			{ name: "allow-server", transport: "stdio", command: "test", allow_tools: ["allowed"] },
			[
				{ name: "allowed", description: "Allowed", inputSchema: {} },
				{ name: "blocked", description: "Blocked", inputSchema: {} },
			],
			[],
			[],
		);

		const clients = new Map([["allow-server", client]]);
		const { commands } = await generateMCPCommands(clients);

		const serverCmd = commands.find((c) => c.name === "allow-server");
		expect(serverCmd).toBeDefined();

		if (serverCmd) {
			const mockCtx = createMockCommandContext();
			const result = await serverCmd.handler({ subcommand: "blocked" }, mockCtx);
			expect(result.exitCode).toBe(1);
			expect(result.stderr).toContain("Unknown subcommand");
			expect(result.stderr).toContain("Available subcommands");
			expect(result.stderr).toContain("allowed");
		}
	});

	// AC3.2: gated subcommand blocked in autonomous mode
	it("gated subcommand blocked in autonomous mode", async () => {
		const client = makeMockClient(
			{ name: "gate-server", transport: "stdio", command: "test" },
			[{ name: "dangerous", description: "Dangerous operation", inputSchema: {} }],
			[],
			[],
		);

		const clients = new Map([["gate-server", client]]);
		const confirmGates = new Map([["gate-server", ["dangerous"]]]);
		const { commands } = await generateMCPCommands(clients, confirmGates);

		const serverCmd = commands.find((c) => c.name === "gate-server");
		expect(serverCmd).toBeDefined();

		if (serverCmd) {
			const mockCtx = createMockCommandContext({ taskId: "task-abc" });
			const result = await serverCmd.handler({ subcommand: "dangerous" }, mockCtx);
			expect(result.exitCode).toBe(1);
			expect(result.stderr).toContain("confirmation");
		}
	});

	// AC3.3: gated subcommand allowed in interactive mode
	it("gated subcommand allowed in interactive mode", async () => {
		const client = makeMockClient(
			{ name: "gate-server", transport: "stdio", command: "test" },
			[{ name: "dangerous", description: "Dangerous operation", inputSchema: {} }],
			[],
			[],
		);

		const clients = new Map([["gate-server", client]]);
		const confirmGates = new Map([["gate-server", ["dangerous"]]]);
		const { commands } = await generateMCPCommands(clients, confirmGates);

		const serverCmd = commands.find((c) => c.name === "gate-server");
		expect(serverCmd).toBeDefined();

		if (serverCmd) {
			const mockCtx = createMockCommandContext({ taskId: "interactive-session-1" });
			const result = await serverCmd.handler({ subcommand: "dangerous" }, mockCtx);
			expect(result.exitCode).toBe(0);
		}
	});

	// AC5.1 & AC5.2: updateHostMCPInfo stores server names not tool names
	it("updateHostMCPInfo stores server names not tool names", async () => {
		const { applySchema, createDatabase } = await import("@bound/core");

		const db = createDatabase(":memory:");
		applySchema(db);

		const siteId = "test-site";

		// Create the host row first
		db.run(
			`INSERT INTO hosts (site_id, host_name, modified_at, deleted)
			VALUES (?, ?, ?, ?)`,
			[siteId, "test-host", new Date().toISOString(), 0],
		);

		const client1 = makeMockClient(
			{ name: "server-a", transport: "stdio", command: "test" },
			[
				{ name: "tool1", description: "Tool 1", inputSchema: {} },
				{ name: "tool2", description: "Tool 2", inputSchema: {} },
			],
			[],
			[],
		);
		const client2 = makeMockClient(
			{ name: "server-b", transport: "stdio", command: "test" },
			[
				{ name: "tool3", description: "Tool 3", inputSchema: {} },
				{ name: "tool4", description: "Tool 4", inputSchema: {} },
			],
			[],
			[],
		);

		const clients = new Map([
			["server-a", client1],
			["server-b", client2],
		]);

		await updateHostMCPInfo(db, siteId, clients);

		const host = db.query("SELECT mcp_tools FROM hosts WHERE site_id = ?").get(siteId) as {
			mcp_tools: string;
		} | null;

		expect(host).not.toBeNull();
		const parsed = JSON.parse(host?.mcp_tools ?? "[]");
		expect(parsed).toEqual(["server-a", "server-b"]);
		expect(parsed.length).toBe(2);

		db.close();
	});

	it("updateHostMCPInfo captures per-tool MCP annotations into mcp_tool_annotations", async () => {
		const { applySchema, createDatabase } = await import("@bound/core");

		const db = createDatabase(":memory:");
		applySchema(db);

		const siteId = "test-site-annotations";

		db.run(
			`INSERT INTO hosts (site_id, host_name, modified_at, deleted)
			VALUES (?, ?, ?, ?)`,
			[siteId, "test-host", new Date().toISOString(), 0],
		);

		const githubClient = makeMockClient(
			{ name: "github", transport: "stdio", command: "test" },
			[
				{
					name: "search_repositories",
					description: "Search repos",
					inputSchema: {},
					annotations: { idempotentHint: true, readOnlyHint: true },
				},
				{
					name: "create_issue",
					description: "Create issue",
					inputSchema: {},
					annotations: { idempotentHint: false, readOnlyHint: false },
				},
				{
					name: "no_annotations",
					description: "No annotations",
					inputSchema: {},
				},
			],
			[],
			[],
		);

		const clients = new Map([["github", githubClient]]);
		await updateHostMCPInfo(db, siteId, clients);

		const host = db
			.query("SELECT mcp_tool_annotations FROM hosts WHERE site_id = ?")
			.get(siteId) as { mcp_tool_annotations: string } | null;

		expect(host).not.toBeNull();
		expect(host?.mcp_tool_annotations).toBeTruthy();
		const parsed = JSON.parse(host?.mcp_tool_annotations ?? "{}");
		expect(parsed.github).toBeDefined();
		expect(parsed.github.search_repositories).toEqual({
			idempotentHint: true,
			readOnlyHint: true,
		});
		expect(parsed.github.create_issue).toEqual({
			idempotentHint: false,
			readOnlyHint: false,
		});
		// Tools without annotations are omitted (or stored as empty).
		// Either way, the lookup helper must treat absence as "no info".
		if (parsed.github.no_annotations !== undefined) {
			expect(parsed.github.no_annotations).toEqual({});
		}

		db.close();
	});

	// Dynamic client lookup: handlers use clients.get(serverName) at dispatch time,
	// so replacing a client in the map is reflected in subsequent calls.
	it("handler uses updated client after map replacement (dynamic lookup)", async () => {
		const originalClient = makeMockClient(
			{ name: "hot-server", transport: "stdio", command: "test" },
			[{ name: "greet", description: "Greet", inputSchema: {} }],
			[],
			[],
		);

		const clients = new Map([["hot-server", originalClient]]);
		const { commands } = await generateMCPCommands(clients);

		const serverCmd = commands.find((c) => c.name === "hot-server");
		expect(serverCmd).toBeDefined();

		if (serverCmd) {
			// Call with original client — should succeed
			const mockCtx = createMockCommandContext();
			const result1 = await serverCmd.handler({ subcommand: "greet" }, mockCtx);
			expect(result1.exitCode).toBe(0);
			expect(result1.stdout).toContain("Tool greet called");

			// Replace client in the shared map with one that returns different output
			const replacementClient = {
				...originalClient,
				isConnected: () => true,
				getConfig: () => ({
					name: "hot-server",
					transport: "stdio" as const,
					command: "test",
				}),
				listTools: async () => [{ name: "greet", description: "Greet", inputSchema: {} }] as Tool[],
				callTool: async (_name: string, _args: Record<string, unknown>) => ({
					content: "REPLACED_CLIENT_RESPONSE",
					isError: false,
				}),
				getServerDescription: () => undefined,
				getServerInstructions: () => undefined,
			} as unknown as MCPClient;
			clients.set("hot-server", replacementClient);

			// Same command should now use the replacement client
			const result2 = await serverCmd.handler({ subcommand: "greet" }, mockCtx);
			expect(result2.exitCode).toBe(0);
			expect(result2.stdout).toContain("REPLACED_CLIENT_RESPONSE");
		}
	});

	// Dynamic client lookup: removing a client from the map makes the handler fail gracefully
	it("handler fails gracefully after client removed from map", async () => {
		const client = makeMockClient(
			{ name: "removable-server", transport: "stdio", command: "test" },
			[{ name: "tool1", description: "Tool", inputSchema: {} }],
			[],
			[],
		);

		const clients = new Map([["removable-server", client]]);
		const { commands } = await generateMCPCommands(clients);

		const serverCmd = commands.find((c) => c.name === "removable-server");
		expect(serverCmd).toBeDefined();

		if (serverCmd) {
			// Remove the client from the map
			clients.delete("removable-server");

			const mockCtx = createMockCommandContext();
			const result = await serverCmd.handler({ subcommand: "tool1" }, mockCtx);
			expect(result.exitCode).toBe(1);
			expect(result.stderr).toContain("not connected");
		}
	});

	// mcp_capabilities: full per-server inventory (serverInfo, tools, prompts, resources)
	it("updateHostMCPInfo persists full server capabilities into mcp_capabilities", async () => {
		const { applySchema, createDatabase } = await import("@bound/core");

		const db = createDatabase(":memory:");
		applySchema(db);

		const siteId = "test-site";
		db.run(
			`INSERT INTO hosts (site_id, host_name, modified_at, deleted)
			VALUES (?, ?, ?, ?)`,
			[siteId, "test-host", new Date().toISOString(), 0],
		);

		const client = makeMockClient(
			{ name: "server-a", transport: "stdio", command: "test" },
			[{ name: "tool1", description: "Tool 1", inputSchema: {} }],
			[{ uri: "doc://a", name: "Doc A", description: "A doc", mimeType: "text/plain" }],
			[{ name: "prompt1", description: "Prompt 1" }],
		);
		const c = client as unknown as Record<string, unknown>;
		c.getServerInfo = () => ({ name: "server-a-impl", title: "Server A", version: "1.2.3" });
		c.getServerDescription = () => "Does A things";
		c.getServerInstructions = () => "Use wisely.";

		await updateHostMCPInfo(db, siteId, new Map([["server-a", client]]));

		const host = db.query("SELECT mcp_capabilities FROM hosts WHERE site_id = ?").get(siteId) as {
			mcp_capabilities: string;
		} | null;
		expect(host?.mcp_capabilities).toBeTruthy();
		const caps = JSON.parse(host?.mcp_capabilities ?? "{}");
		expect(caps["server-a"].serverInfo).toEqual({
			name: "server-a-impl",
			title: "Server A",
			version: "1.2.3",
			description: "Does A things",
			instructions: "Use wisely.",
		});
		expect(caps["server-a"].tools).toEqual([{ name: "tool1", description: "Tool 1" }]);
		expect(caps["server-a"].prompts).toEqual([{ name: "prompt1", description: "Prompt 1" }]);
		expect(caps["server-a"].resources).toEqual([
			{ uri: "doc://a", name: "Doc A", description: "A doc", mimeType: "text/plain" },
		]);

		db.close();
	});

	it("updateHostMCPInfo omits prompts/resources when the server lacks those capabilities", async () => {
		const { applySchema, createDatabase } = await import("@bound/core");

		const db = createDatabase(":memory:");
		applySchema(db);

		const siteId = "test-site";
		db.run(
			`INSERT INTO hosts (site_id, host_name, modified_at, deleted)
			VALUES (?, ?, ?, ?)`,
			[siteId, "test-host", new Date().toISOString(), 0],
		);

		const client = makeMockClient(
			{ name: "server-b", transport: "stdio", command: "test" },
			[{ name: "tool1", description: "Tool 1", inputSchema: {} }],
			[],
			[],
		);
		const c = client as unknown as Record<string, unknown>;
		c.listPrompts = async () => {
			throw new Error("Server does not support prompts");
		};
		c.listResources = async () => {
			throw new Error("Server does not support resources");
		};

		await updateHostMCPInfo(db, siteId, new Map([["server-b", client]]));

		const host = db.query("SELECT mcp_capabilities FROM hosts WHERE site_id = ?").get(siteId) as {
			mcp_capabilities: string;
		} | null;
		const caps = JSON.parse(host?.mcp_capabilities ?? "{}");
		expect(caps["server-b"].tools).toEqual([{ name: "tool1", description: "Tool 1" }]);
		// Listing failed ≠ listed-and-empty: omit the field so the UI can say "unavailable".
		expect(caps["server-b"].prompts).toBeUndefined();
		expect(caps["server-b"].resources).toBeUndefined();

		db.close();
	});

	// Outbox bypass fix: updateHostMCPInfo must use change-log outbox
	it("updateHostMCPInfo creates changelog entry for hosts table", async () => {
		const { applySchema, createDatabase, insertRow } = await import("@bound/core");

		const db = createDatabase(":memory:");
		applySchema(db);

		const siteId = "test-site-id";

		// Create the host row first using insertRow to establish initial changelog
		insertRow(
			db,
			"hosts",
			{
				site_id: siteId,
				host_name: "test-host",
				deleted: 0,
				modified_at: new Date().toISOString(),
			},
			siteId,
		);

		const client1 = makeMockClient(
			{ name: "server-x", transport: "stdio", command: "test" },
			[{ name: "tool1", description: "Tool 1", inputSchema: {} }],
			[],
			[],
		);

		const clients = new Map([["server-x", client1]]);

		await updateHostMCPInfo(db, siteId, clients);

		// Verify changelog entry exists
		const changelogEntry = db
			.query(
				`SELECT * FROM change_log
				WHERE table_name = 'hosts' AND row_id = ?
				ORDER BY hlc DESC LIMIT 1`,
			)
			.get(siteId) as { table_name: string; row_id: string; row_data: string } | null;

		expect(changelogEntry).not.toBeNull();
		expect(changelogEntry?.table_name).toBe("hosts");
		expect(changelogEntry?.row_id).toBe(siteId);

		const rowData = JSON.parse(changelogEntry?.row_data ?? "{}");
		expect(rowData.mcp_servers).toBeDefined();
		expect(rowData.mcp_tools).toBeDefined();

		const mcpServers = JSON.parse(rowData.mcp_servers);
		const mcpTools = JSON.parse(rowData.mcp_tools);
		expect(mcpServers).toEqual(["server-x"]);
		expect(mcpTools).toEqual(["server-x"]);

		db.close();
	});

	it("serializes image content blocks as JSON ContentBlock[] in stdout", async () => {
		const imageClient = {
			getConfig: () => ({ name: "image-server", transport: "stdio", command: "test" }),
			isConnected: () => true,
			listTools: async () => [
				{ name: "screenshot", description: "Take a screenshot", inputSchema: {} },
			],
			listResources: async () => [],
			listPrompts: async () => [],
			callTool: async () => ({
				content: "Here is the screenshot",
				images: [{ media_type: "image/png", data: "iVBORw0KGgo=" }],
				isError: false,
			}),
			readResource: async (uri: string) => ({ uri, content: "" }),
			invokePrompt: async () => ({ messages: [] }),
			connect: async () => {},
			disconnect: async () => {},
			getServerDescription: () => undefined,
			getServerInstructions: () => undefined,
		} as unknown as MCPClient;

		const clients = new Map([["image-server", imageClient]]);
		const { commands } = await generateMCPCommands(clients);
		const serverCmd = commands.find((c) => c.name === "image-server");
		expect(serverCmd).toBeDefined();

		const mockCtx = createMockCommandContext();
		// biome-ignore lint/style/noNonNullAssertion: test assertion after expect(defined)
		const result = await serverCmd!.handler({ subcommand: "screenshot" }, mockCtx);
		expect(result.exitCode).toBe(0);

		// stdout should be a JSON ContentBlock[] with text and image blocks
		const blocks = JSON.parse(result.stdout);
		expect(Array.isArray(blocks)).toBe(true);
		expect(blocks).toHaveLength(2);
		expect(blocks[0]).toEqual({ type: "text", text: "Here is the screenshot" });
		expect(blocks[1]).toEqual({
			type: "image",
			source: { type: "base64", media_type: "image/png", data: "iVBORw0KGgo=" },
		});
	});
});

describe("MCP Bridge — binary resources and resource_link passthrough", () => {
	const { mkdtempSync } = require("node:fs");
	const { tmpdir } = require("node:os");
	const { join } = require("node:path");
	const { createDatabase, applySchema } = require("@bound/core");

	function makeRealDbCtx(): { ctx: CommandContext; db: any } {
		const dir = mkdtempSync(join(tmpdir(), "mcp-bridge-binary-"));
		const db = createDatabase(join(dir, "test.db"));
		applySchema(db);
		const eventBus = new TypedEventEmitter();
		const logger: Logger = {
			debug: () => {},
			info: () => {},
			warn: () => {},
			error: () => {},
		};
		return {
			ctx: {
				db,
				siteId: "test-site",
				eventBus,
				logger,
			} as CommandContext,
			db,
		};
	}

	function buildClient(serverName: string, overrides: Partial<MCPClient>): MCPClient {
		return {
			isConnected: () => true,
			listTools: async () => [],
			listResources: async () => [],
			listPrompts: async () => [],
			callTool: async () => ({ content: "", isError: false }),
			readResource: async (uri: string) => ({ uri, content: "", isBinary: false }),
			invokePrompt: async () => ({ messages: [] }),
			connect: async () => {},
			disconnect: async () => {},
			getServerDescription: () => undefined,
			getServerInstructions: () => undefined,
			getConfig: () => ({
				name: serverName,
				transport: "stdio",
				command: "test",
			}),
			...overrides,
		} as unknown as MCPClient;
	}

	it("MCP tool returning a binary resource persists it to files and emits a file_ref document block", async () => {
		// PDF bytes (5-byte fake header) base64-encoded so the round-trip is
		// inspectable in the assertions.
		const pdfBase64 = Buffer.from("%PDF-").toString("base64");
		const fakeClient = buildClient("doc-server", {
			listTools: async () => [
				{
					name: "fetch_pdf",
					description: "Fetch a PDF",
					inputSchema: { properties: {} },
				},
			],
			callTool: async () => ({
				content: "Here is your PDF",
				documents: [
					{
						media_type: "application/pdf",
						data: pdfBase64,
						uri: "https://example.test/report.pdf",
					},
				],
				isError: false,
			}),
		});

		const clients = new Map([["doc-server", fakeClient]]);
		const { commands } = await generateMCPCommands(clients);
		const serverCmd = commands.find((c) => c.name === "doc-server");
		expect(serverCmd).toBeDefined();

		const { ctx, db } = makeRealDbCtx();
		// biome-ignore lint/style/noNonNullAssertion: test assertion after expect(defined)
		const result = await serverCmd!.handler({ subcommand: "fetch_pdf" }, ctx);
		expect(result.exitCode).toBe(0);

		const blocks = JSON.parse(result.stdout);
		expect(Array.isArray(blocks)).toBe(true);
		expect(blocks).toHaveLength(2);
		expect(blocks[0]).toEqual({ type: "text", text: "Here is your PDF" });
		expect(blocks[1]).toMatchObject({
			type: "document",
			source: {
				type: "file_ref",
				media_type: "application/pdf",
			},
			title: "https://example.test/report.pdf",
		});

		// File row should be present with the original base64 content.
		const fileId = blocks[1].source.file_id;
		const row = db
			.query("SELECT content, is_binary, host_origin FROM files WHERE id = ?")
			.get(fileId) as { content: string; is_binary: number; host_origin: string };
		expect(row.content).toBe(pdfBase64);
		expect(row.is_binary).toBe(1);
		expect(row.host_origin).toBe("test-site");
	});

	it("MCP tool returning a resource_link emits a text annotation referencing the bash resource command", async () => {
		const fakeClient = buildClient("link-server", {
			listTools: async () => [
				{
					name: "list",
					description: "List resources",
					inputSchema: { properties: {} },
				},
			],
			callTool: async () => ({
				content: "available downloads:",
				resourceLinks: [
					{
						uri: "https://example.test/data.csv",
						name: "Sales data",
						mimeType: "text/csv",
					},
				],
				isError: false,
			}),
		});

		const clients = new Map([["link-server", fakeClient]]);
		const { commands } = await generateMCPCommands(clients);
		const serverCmd = commands.find((c) => c.name === "link-server");
		expect(serverCmd).toBeDefined();

		const { ctx } = makeRealDbCtx();
		// biome-ignore lint/style/noNonNullAssertion: test assertion after expect(defined)
		const result = await serverCmd!.handler({ subcommand: "list" }, ctx);
		expect(result.exitCode).toBe(0);

		const blocks = JSON.parse(result.stdout);
		expect(blocks).toHaveLength(1);
		expect(blocks[0].type).toBe("text");
		// Should mention the URI, the friendly name, the mime type, and the
		// bash command the agent should run to dereference.
		expect(blocks[0].text).toContain("https://example.test/data.csv");
		expect(blocks[0].text).toContain('name="Sales data"');
		expect(blocks[0].text).toContain("mimeType=text/csv");
		expect(blocks[0].text).toContain('Load with: resource "https://example.test/data.csv"');
	});

	it("bash `resource` command on a text resource keeps the legacy plain-string contract", async () => {
		const fakeClient = buildClient("text-res", {
			readResource: async (uri: string) => ({
				uri,
				mimeType: "text/plain",
				content: "hello world",
				isBinary: false,
			}),
		});

		const clients = new Map([["text-res", fakeClient]]);
		const { commands } = await generateMCPCommands(clients);
		const resourceCmd = commands.find((c) => c.name === "resource");
		expect(resourceCmd).toBeDefined();

		const { ctx } = makeRealDbCtx();
		// biome-ignore lint/style/noNonNullAssertion: test assertion after expect(defined)
		const result = await resourceCmd!.handler(
			{ uri: "file:///hello.txt", server: "text-res" },
			ctx,
		);
		expect(result.exitCode).toBe(0);
		expect(result.stdout).toBe("hello world\n");
	});

	it("bash `resource` command on a binary doc-mime resource persists to files and emits a file_ref document block", async () => {
		const pdfBase64 = Buffer.from("%PDF-").toString("base64");
		const fakeClient = buildClient("pdf-res", {
			readResource: async (uri: string) => ({
				uri,
				mimeType: "application/pdf",
				content: pdfBase64,
				isBinary: true,
			}),
		});

		const clients = new Map([["pdf-res", fakeClient]]);
		const { commands } = await generateMCPCommands(clients);
		const resourceCmd = commands.find((c) => c.name === "resource");
		expect(resourceCmd).toBeDefined();

		const { ctx, db } = makeRealDbCtx();
		// biome-ignore lint/style/noNonNullAssertion: test assertion after expect(defined)
		const result = await resourceCmd!.handler(
			{ uri: "https://example.test/report.pdf", server: "pdf-res" },
			ctx,
		);
		expect(result.exitCode).toBe(0);

		const blocks = JSON.parse(result.stdout);
		expect(blocks).toHaveLength(1);
		expect(blocks[0]).toMatchObject({
			type: "document",
			source: { type: "file_ref", media_type: "application/pdf" },
			title: "https://example.test/report.pdf",
		});
		const fileId = blocks[0].source.file_id;
		const row = db.query("SELECT content FROM files WHERE id = ?").get(fileId) as {
			content: string;
		};
		expect(row.content).toBe(pdfBase64);
	});

	it("bash `resource` command on a binary image-mime resource emits an image block (not document)", async () => {
		const pngBase64 = "iVBORw0KGgo=";
		const fakeClient = buildClient("img-res", {
			readResource: async (uri: string) => ({
				uri,
				mimeType: "image/png",
				content: pngBase64,
				isBinary: true,
			}),
		});

		const clients = new Map([["img-res", fakeClient]]);
		const { commands } = await generateMCPCommands(clients);
		const resourceCmd = commands.find((c) => c.name === "resource");
		expect(resourceCmd).toBeDefined();

		const { ctx } = makeRealDbCtx();
		// biome-ignore lint/style/noNonNullAssertion: test assertion after expect(defined)
		const result = await resourceCmd!.handler(
			{ uri: "https://example.test/shot.png", server: "img-res" },
			ctx,
		);
		expect(result.exitCode).toBe(0);

		const blocks = JSON.parse(result.stdout);
		expect(blocks).toHaveLength(1);
		expect(blocks[0]).toEqual({
			type: "image",
			source: { type: "base64", media_type: "image/png", data: pngBase64 },
		});
	});
});

describe("MCP Bridge — coerceArgsFromSchema extended types", () => {
	// Helper: extract the JSON args object from a callTool stdout message.
	// The mock callTool returns: "Tool <name> called with args: <json>"
	function extractArgs(stdout: string): Record<string, unknown> {
		return JSON.parse(stdout.slice(stdout.indexOf("{")));
	}

	it("coerces JSON array string to array for array-typed params", async () => {
		const client = makeMockClient(
			{ name: "arr-server", transport: "stdio", command: "test" },
			[
				{
					name: "search",
					description: "Search with filters",
					inputSchema: {
						properties: {
							query: { type: "string" },
							tags: { type: "array" },
						},
						required: ["query"],
					},
				},
			],
			[],
			[],
		);

		const clients = new Map([["arr-server", client]]);
		const { commands } = await generateMCPCommands(clients);
		// biome-ignore lint/style/noNonNullAssertion: test assertion via find + defined check
		const serverCmd = commands.find((c) => c.name === "arr-server")!;
		expect(serverCmd).toBeDefined();

		const ctx = createMockCommandContext();
		// Simulates what preserveRepeatedFlags produces for: --tag a --tag b --tag c
		const result = await serverCmd.handler(
			{ subcommand: "search", query: "hello", tags: '["a","b","c"]' },
			ctx,
		);

		expect(result.exitCode).toBe(0);
		const calledArgs = extractArgs(result.stdout);
		expect(calledArgs.query).toBe("hello");
		expect(calledArgs.tags).toEqual(["a", "b", "c"]);
	});

	it("wraps a lone non-array string in a single-element array for array-typed params", async () => {
		const client = makeMockClient(
			{ name: "arr-server", transport: "stdio", command: "test" },
			[
				{
					name: "tag_item",
					description: "Tag an item",
					inputSchema: {
						properties: { tags: { type: "array" } },
						required: ["tags"],
					},
				},
			],
			[],
			[],
		);

		const clients = new Map([["arr-server", client]]);
		const { commands } = await generateMCPCommands(clients);
		// biome-ignore lint/style/noNonNullAssertion: test assertion via find + defined check
		const serverCmd = commands.find((c) => c.name === "arr-server")!;
		expect(serverCmd).toBeDefined();

		const ctx = createMockCommandContext();
		// Single value for an array-typed param — should be wrapped in a one-element array
		const result = await serverCmd.handler({ subcommand: "tag_item", tags: "only" }, ctx);

		expect(result.exitCode).toBe(0);
		const calledArgs = extractArgs(result.stdout);
		expect(calledArgs.tags).toEqual(["only"]);
	});

	it("coerces JSON object string to object for object-typed params", async () => {
		const client = makeMockClient(
			{ name: "obj-server", transport: "stdio", command: "test" },
			[
				{
					name: "configure",
					description: "Configure something",
					inputSchema: {
						properties: { options: { type: "object" } },
						required: [],
					},
				},
			],
			[],
			[],
		);

		const clients = new Map([["obj-server", client]]);
		const { commands } = await generateMCPCommands(clients);
		// biome-ignore lint/style/noNonNullAssertion: test assertion via find + defined check
		const serverCmd = commands.find((c) => c.name === "obj-server")!;
		expect(serverCmd).toBeDefined();

		const ctx = createMockCommandContext();
		const result = await serverCmd.handler(
			{ subcommand: "configure", options: '{"key":"value","count":3}' },
			ctx,
		);

		expect(result.exitCode).toBe(0);
		const calledArgs = extractArgs(result.stdout);
		expect(calledArgs.options).toEqual({ key: "value", count: 3 });
	});

	it('coerces number for union-type params (type: ["number", "null"])', async () => {
		const client = makeMockClient(
			{ name: "union-server", transport: "stdio", command: "test" },
			[
				{
					name: "paginate",
					description: "Paginate results",
					inputSchema: {
						properties: { limit: { type: ["number", "null"] } },
						required: [],
					},
				},
			],
			[],
			[],
		);

		const clients = new Map([["union-server", client]]);
		const { commands } = await generateMCPCommands(clients);
		// biome-ignore lint/style/noNonNullAssertion: test assertion via find + defined check
		const serverCmd = commands.find((c) => c.name === "union-server")!;
		expect(serverCmd).toBeDefined();

		const ctx = createMockCommandContext();
		const result = await serverCmd.handler({ subcommand: "paginate", limit: "10" }, ctx);

		expect(result.exitCode).toBe(0);
		const calledArgs = extractArgs(result.stdout);
		expect(calledArgs.limit).toBe(10);
	});

	it("safety: JSON array string for string-typed param falls back to last element (last-wins)", async () => {
		const client = makeMockClient(
			{ name: "scalar-server", transport: "stdio", command: "test" },
			[
				{
					name: "greet",
					description: "Greet someone",
					inputSchema: {
						properties: { name: { type: "string" } },
						required: ["name"],
					},
				},
			],
			[],
			[],
		);

		const clients = new Map([["scalar-server", client]]);
		const { commands } = await generateMCPCommands(clients);
		// biome-ignore lint/style/noNonNullAssertion: test assertion via find + defined check
		const serverCmd = commands.find((c) => c.name === "scalar-server")!;
		expect(serverCmd).toBeDefined();

		const ctx = createMockCommandContext();
		// Simulates accidental --name foo --name bar on a string param:
		// preserveRepeatedFlags produces '["foo","bar"]' — must NOT reach the tool raw.
		const result = await serverCmd.handler({ subcommand: "greet", name: '["foo","bar"]' }, ctx);

		expect(result.exitCode).toBe(0);
		const calledArgs = extractArgs(result.stdout);
		// Last element wins; raw JSON array string is never forwarded
		expect(calledArgs.name).toBe("bar");
	});

	it("safety: JSON array string for number-typed param falls back to last element and coerces to number", async () => {
		const client = makeMockClient(
			{ name: "num-server", transport: "stdio", command: "test" },
			[
				{
					name: "calculate",
					description: "Do math",
					inputSchema: {
						properties: { count: { type: "number" } },
						required: ["count"],
					},
				},
			],
			[],
			[],
		);

		const clients = new Map([["num-server", client]]);
		const { commands } = await generateMCPCommands(clients);
		// biome-ignore lint/style/noNonNullAssertion: test assertion via find + defined check
		const serverCmd = commands.find((c) => c.name === "num-server")!;
		expect(serverCmd).toBeDefined();

		const ctx = createMockCommandContext();
		// --count 5 --count 10 with preserveRepeatedFlags → '["5","10"]'; schema is number.
		// Safety: extract last element "10", coerce to number 10.
		const result = await serverCmd.handler({ subcommand: "calculate", count: '["5","10"]' }, ctx);

		expect(result.exitCode).toBe(0);
		const calledArgs = extractArgs(result.stdout);
		expect(calledArgs.count).toBe(10);
	});
});
