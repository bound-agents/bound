import type Database from "bun:sqlite";
import { describe, expect, it } from "bun:test";
import type { CommandContext } from "@bound/sandbox";
import type { Logger } from "@bound/shared";
import { TypedEventEmitter } from "@bound/shared";
import { generateMCPCommands } from "../mcp-bridge";
import { MCPClient } from "../mcp-client";

// Helper to create mock CommandContext
function createMockCommandContext(overrides?: Partial<CommandContext>): CommandContext {
	const eventBus = new TypedEventEmitter();
	const logger: Logger = {
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

describe("MCP Bridge", () => {
	it("generates commands from MCP tools", async () => {
		// Create a mock MCP client with tools
		const client = new MCPClient({
			name: "test-server",
			transport: "stdio",
			command: "test",
		});

		await client.connect();

		// Register some tools
		client.registerTool({
			name: "greet",
			description: "Greet someone",
			inputSchema: { type: "object", properties: { name: { type: "string" } } },
		});

		client.registerTool({
			name: "calculate",
			description: "Calculate something",
			inputSchema: { type: "object", properties: { expr: { type: "string" } } },
		});

		// Generate commands
		const clients = new Map([["test-server", client]]);
		const commands = generateMCPCommands(clients);

		// Should have generated tool commands plus 4 MCP access commands (resources, resource, prompts, prompt)
		expect(commands.length).toBe(6); // 2 tools + 4 access commands
		expect(commands.map((c) => c.name)).toContain("test-server-greet");
		expect(commands.map((c) => c.name)).toContain("test-server-calculate");
	});

	it("applies allow_tools filter", async () => {
		const client = new MCPClient({
			name: "filtered-server",
			transport: "stdio",
			command: "test",
			allow_tools: ["allowed"],
		});

		await client.connect();

		client.registerTool({
			name: "allowed",
			description: "This tool is allowed",
			inputSchema: {},
		});

		client.registerTool({
			name: "blocked",
			description: "This tool is blocked",
			inputSchema: {},
		});

		const clients = new Map([["filtered-server", client]]);
		const commands = generateMCPCommands(clients);

		// Should only have "allowed" tool + 4 access commands
		expect(commands.map((c) => c.name)).toContain("filtered-server-allowed");
		expect(commands.map((c) => c.name)).not.toContain("filtered-server-blocked");
	});

	it("blocks confirmed tools in autonomous mode", async () => {
		const client = new MCPClient({
			name: "confirm-server",
			transport: "stdio",
			command: "test",
			confirm: ["dangerous"],
		});

		await client.connect();

		client.registerTool({
			name: "dangerous",
			description: "Dangerous operation",
			inputSchema: {},
		});

		const clients = new Map([["confirm-server", client]]);
		const confirmGates = new Map([["confirm-server", ["dangerous"]]]);
		const commands = generateMCPCommands(clients, confirmGates);

		const dangerousCmd = commands.find((c) => c.name === "confirm-server-dangerous");
		expect(dangerousCmd).toBeDefined();

		if (dangerousCmd) {
			// Call in autonomous mode
			const mockCtx = createMockCommandContext({ taskId: "some-task-id" });

			const result = await dangerousCmd.handler({}, mockCtx);
			expect(result.exitCode).toBe(1);
			expect(result.stderr).toContain("confirmation");
		}
	});

	it("lists resources from all servers", async () => {
		const client1 = new MCPClient({
			name: "server1",
			transport: "stdio",
			command: "test",
		});

		const client2 = new MCPClient({
			name: "server2",
			transport: "stdio",
			command: "test",
		});

		await client1.connect();
		await client2.connect();

		client1.registerResource({
			uri: "resource://file1",
			name: "File 1",
			description: "First file",
		});

		client2.registerResource({
			uri: "resource://file2",
			name: "File 2",
			description: "Second file",
		});

		const clients = new Map([
			["server1", client1],
			["server2", client2],
		]);

		const commands = generateMCPCommands(clients);
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
		const client = new MCPClient({
			name: "test-server",
			transport: "stdio",
			command: "test",
		});

		await client.connect();

		client.registerResource({
			uri: "resource://test",
			name: "Test",
			description: "Test resource",
			mimeType: "text/plain",
		});

		const clients = new Map([["test-server", client]]);
		const commands = generateMCPCommands(clients);
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
		const client = new MCPClient({
			name: "test-server",
			transport: "stdio",
			command: "test",
		});

		await client.connect();

		client.registerPrompt({
			name: "test-prompt",
			description: "A test prompt",
		});

		const clients = new Map([["test-server", client]]);
		const commands = generateMCPCommands(clients);
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
		const client = new MCPClient({
			name: "test-server",
			transport: "stdio",
			command: "test",
		});

		await client.connect();

		client.registerPrompt({
			name: "greet",
			description: "Greet someone",
			arguments: [{ name: "name", description: "Person to greet" }],
		});

		const clients = new Map([["test-server", client]]);
		const commands = generateMCPCommands(clients);
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
});
