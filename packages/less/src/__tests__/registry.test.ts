import { describe, expect, it } from "bun:test";
import { buildSystemPromptAddition, buildToolSet } from "../tools/registry";

describe("buildToolSet", () => {
	it("returns core tools with correct structure", () => {
		const { tools, handlers } = buildToolSet("/tmp", "localhost");

		// Should have exactly 4 core tools
		expect(tools).toHaveLength(4);

		// Check tool names
		const toolNames = tools.map((t) => t.function.name);
		expect(toolNames).toContain("boundless_read");
		expect(toolNames).toContain("boundless_write");
		expect(toolNames).toContain("boundless_edit");
		expect(toolNames).toContain("boundless_bash");

		// Check handlers exist
		expect(handlers.size).toBe(4);
		expect(handlers.has("boundless_read")).toBe(true);
		expect(handlers.has("boundless_write")).toBe(true);
		expect(handlers.has("boundless_edit")).toBe(true);
		expect(handlers.has("boundless_bash")).toBe(true);
	});

	it("has correct tool definition structure", () => {
		const { tools } = buildToolSet("/tmp", "localhost");

		for (const tool of tools) {
			expect(tool.type).toBe("function");
			expect(tool.function.name).toBeDefined();
			expect(tool.function.description).toBeDefined();
			expect(tool.function.parameters).toBeDefined();
		}
	});

	it("has correct boundless_read parameters", () => {
		const { tools } = buildToolSet("/tmp", "localhost");

		const readTool = tools.find((t) => t.function.name === "boundless_read");
		expect(readTool).toBeDefined();

		if (!readTool) return;

		const params = readTool.function.parameters as Record<string, unknown>;
		expect(params.type).toBe("object");
		expect(params.required).toContain("file_path");
		expect(params.properties).toBeDefined();

		const properties = params.properties as Record<string, unknown>;
		expect(properties.file_path).toBeDefined();
		expect(properties.offset).toBeDefined();
		expect(properties.limit).toBeDefined();
	});

	it("has correct boundless_write parameters", () => {
		const { tools } = buildToolSet("/tmp", "localhost");

		const writeTool = tools.find((t) => t.function.name === "boundless_write");
		expect(writeTool).toBeDefined();

		if (!writeTool) return;

		const params = writeTool.function.parameters as Record<string, unknown>;
		expect(params.required).toContain("file_path");
		expect(params.required).toContain("content");
	});

	it("has correct boundless_edit parameters", () => {
		const { tools } = buildToolSet("/tmp", "localhost");

		const editTool = tools.find((t) => t.function.name === "boundless_edit");
		expect(editTool).toBeDefined();

		if (!editTool) return;

		const params = editTool.function.parameters as Record<string, unknown>;
		expect(params.required).toContain("file_path");
		expect(params.required).toContain("old_string");
		expect(params.required).toContain("new_string");
	});

	it("has correct boundless_bash parameters", () => {
		const { tools } = buildToolSet("/tmp", "localhost");

		const bashTool = tools.find((t) => t.function.name === "boundless_bash");
		expect(bashTool).toBeDefined();

		if (!bashTool) return;

		const params = bashTool.function.parameters as Record<string, unknown>;
		expect(params.required).toContain("command");
	});

	it("merges MCP tools with boundless_mcp_ prefix", () => {
		const mcpTools = new Map<
			string,
			{
				tools: import("@modelcontextprotocol/sdk/types.js").Tool[];
				config: import("../config").McpServerConfig;
			}
		>([
			[
				"github",
				{
					tools: [
						{
							name: "list_repos",
							description: "List repositories",
							inputSchema: { type: "object" },
						},
					],
					config: {
						transport: "stdio",
						name: "github",
						command: "echo",
						enabled: true,
					},
				},
			],
		]);

		const { tools, handlers } = buildToolSet("/tmp", "localhost", mcpTools);

		// Should have 4 core + 1 MCP tool
		expect(tools).toHaveLength(5);

		// Check MCP tool name
		const coreNames = ["boundless_read", "boundless_write", "boundless_edit", "boundless_bash"];
		const mcpToolName = tools.find((t) => !coreNames.includes(t.function.name));
		expect(mcpToolName?.function.name).toBe("boundless_mcp_github_list_repos");

		// Check handler exists
		expect(handlers.has("boundless_mcp_github_list_repos")).toBe(true);
	});

	it("accepts MCP server tools without collision", () => {
		const mcpTools = new Map<
			string,
			{
				tools: import("@modelcontextprotocol/sdk/types.js").Tool[];
				config: import("../config").McpServerConfig;
			}
		>([
			[
				"testserver",
				{
					tools: [
						{
							// This tool will be named: boundless_mcp_testserver_test
							name: "test",
							description: "Test tool",
							inputSchema: { type: "object" },
						},
					],
					config: {
						transport: "stdio",
						name: "testserver",
						command: "echo",
						enabled: true,
					},
				},
			],
		]);

		const { tools } = buildToolSet("/tmp", "localhost", mcpTools);

		// Should have 4 core + 1 MCP tool (no collision)
		expect(tools).toHaveLength(5);

		// MCP tool should be present
		expect(tools.find((t) => t.function.name === "boundless_mcp_testserver_test")).toBeDefined();
	});

	it("rejects MCP servers that produce namespace collisions from underscore ambiguity", () => {
		// Create underscore ambiguity collision:
		// server "a_b" with tool "read" -> "boundless_mcp_a_b_read"
		// server "a" with tool "b_read"  -> "boundless_mcp_a_b_read" (collision!)
		const mcpTools = new Map<
			string,
			{
				tools: import("@modelcontextprotocol/sdk/types.js").Tool[];
				config: import("../config").McpServerConfig;
			}
		>([
			[
				"a_b",
				{
					tools: [
						{
							name: "read",
							description: "Read from a_b server",
							inputSchema: { type: "object" },
						},
					],
					config: {
						transport: "stdio",
						name: "a_b",
						command: "echo",
						enabled: true,
					},
				},
			],
			[
				"a",
				{
					tools: [
						{
							name: "b_read", // This creates collision: boundless_mcp_a_b_read
							description: "Read from a server",
							inputSchema: { type: "object" },
						},
					],
					config: {
						transport: "stdio",
						name: "a",
						command: "echo",
						enabled: true,
					},
				},
			],
		]);

		const { tools } = buildToolSet("/tmp", "localhost", mcpTools);

		// Should have 4 core tools only (both MCP servers rejected due to collision)
		expect(tools).toHaveLength(4);

		// Verify the colliding tools are NOT present
		expect(tools.find((t) => t.function.name === "boundless_mcp_a_b_read")).toBeUndefined();
		expect(tools.find((t) => t.function.name === "boundless_mcp_a_b_read")).toBeUndefined();
	});

	it("allows multiple MCP servers that do not have namespace collisions", () => {
		// Test that both servers merge cleanly when their names don't collide
		const mcpTools = new Map<
			string,
			{
				tools: import("@modelcontextprotocol/sdk/types.js").Tool[];
				config: import("../config").McpServerConfig;
			}
		>([
			[
				"github",
				{
					tools: [
						{
							name: "list_repos",
							description: "List repos",
							inputSchema: { type: "object" },
						},
						{
							name: "get_repo",
							description: "Get repo",
							inputSchema: { type: "object" },
						},
					],
					config: {
						transport: "stdio",
						name: "github",
						command: "echo",
						enabled: true,
					},
				},
			],
			[
				"gitlab",
				{
					tools: [
						{
							name: "list_projects", // Different naming scheme
							description: "List projects",
							inputSchema: { type: "object" },
						},
					],
					config: {
						transport: "stdio",
						name: "gitlab",
						command: "echo",
						enabled: true,
					},
				},
			],
		]);

		const { tools } = buildToolSet("/tmp", "localhost", mcpTools);

		// Should have 4 core + 3 MCP tools
		expect(tools).toHaveLength(7);

		// All MCP tools should be present
		expect(tools.find((t) => t.function.name === "boundless_mcp_github_list_repos")).toBeDefined();
		expect(tools.find((t) => t.function.name === "boundless_mcp_github_get_repo")).toBeDefined();
		expect(
			tools.find((t) => t.function.name === "boundless_mcp_gitlab_list_projects"),
		).toBeDefined();
	});

	it("processes multiple MCP servers cleanly when no collisions", () => {
		const mcpTools = new Map<
			string,
			{
				tools: import("@modelcontextprotocol/sdk/types.js").Tool[];
				config: import("../config").McpServerConfig;
			}
		>([
			[
				"github",
				{
					tools: [
						{
							name: "list_repos",
							description: "List repos",
							inputSchema: { type: "object" },
						},
					],
					config: {
						transport: "stdio",
						name: "github",
						command: "echo",
						enabled: true,
					},
				},
			],
			[
				"slack",
				{
					tools: [
						{
							name: "send_message",
							description: "Send message",
							inputSchema: { type: "object" },
						},
					],
					config: {
						transport: "stdio",
						name: "slack",
						command: "echo",
						enabled: true,
					},
				},
			],
		]);

		const { tools, handlers } = buildToolSet("/tmp", "localhost", mcpTools);

		// Should have 4 core + 2 MCP tools
		expect(tools).toHaveLength(6);

		// Check both MCP tools present
		expect(tools.find((t) => t.function.name === "boundless_mcp_github_list_repos")).toBeDefined();
		expect(tools.find((t) => t.function.name === "boundless_mcp_slack_send_message")).toBeDefined();

		// Check handlers
		expect(handlers.has("boundless_mcp_github_list_repos")).toBe(true);
		expect(handlers.has("boundless_mcp_slack_send_message")).toBe(true);
	});
	it("filters MCP tools using allowTools whitelist (AC6.4)", () => {
		const mcpTools = new Map<
			string,
			{
				tools: import("@modelcontextprotocol/sdk/types.js").Tool[];
				config: import("../config").McpServerConfig;
			}
		>([
			[
				"fileserver",
				{
					tools: [
						{
							name: "read",
							description: "Read file",
							inputSchema: { type: "object" },
						},
						{
							name: "write",
							description: "Write file",
							inputSchema: { type: "object" },
						},
						{
							name: "delete",
							description: "Delete file",
							inputSchema: { type: "object" },
						},
					],
					config: {
						transport: "stdio",
						name: "fileserver",
						command: "echo",
						enabled: true,
						allowTools: ["read", "write"],
					},
				},
			],
		]);

		const { tools } = buildToolSet("/tmp", "localhost", mcpTools);

		// Should have 4 core + 2 MCP tools (delete excluded)
		expect(tools).toHaveLength(6);

		// Check allowed tools are present
		expect(tools.find((t) => t.function.name === "boundless_mcp_fileserver_read")).toBeDefined();
		expect(tools.find((t) => t.function.name === "boundless_mcp_fileserver_write")).toBeDefined();

		// Check excluded tool is NOT present
		expect(
			tools.find((t) => t.function.name === "boundless_mcp_fileserver_delete"),
		).toBeUndefined();
	});

	it("applies confirm gating to marked tools (AC6.5)", async () => {
		let confirmCalled = false;
		const confirmFn = async (toolName: string): Promise<boolean> => {
			confirmCalled = true;
			expect(toolName).toBe("boundless_mcp_admin_destroy_database");
			return false; // User declines
		};

		const mcpTools = new Map<
			string,
			{
				tools: import("@modelcontextprotocol/sdk/types.js").Tool[];
				config: import("../config").McpServerConfig;
			}
		>([
			[
				"admin",
				{
					tools: [
						{
							name: "destroy_database",
							description: "Destroy database",
							inputSchema: { type: "object" },
						},
					],
					config: {
						transport: "stdio",
						name: "admin",
						command: "echo",
						enabled: true,
						confirm: ["destroy_database"],
					},
				},
			],
		]);

		const { handlers } = buildToolSet("/tmp", "localhost", mcpTools, confirmFn);

		const handler = handlers.get("boundless_mcp_admin_destroy_database");
		expect(handler).toBeDefined();

		if (!handler) return;

		// Call the handler
		const result = await handler({}, new AbortController().signal, "/tmp");

		// Verify confirmFn was called
		expect(confirmCalled).toBe(true);

		// Verify result is an error
		expect(result.isError).toBe(true);
		expect(result.content[0]?.type).toBe("text");
		if (result.content[0]?.type === "text") {
			expect(result.content[0].text).toContain("declined");
		}
	});

	it("allows confirmed tool calls when user approves (AC6.5)", async () => {
		const confirmFn = async (_toolName: string): Promise<boolean> => {
			return true; // User approves
		};

		const mcpTools = new Map<
			string,
			{
				tools: import("@modelcontextprotocol/sdk/types.js").Tool[];
				config: import("../config").McpServerConfig;
			}
		>([
			[
				"admin",
				{
					tools: [
						{
							name: "destroy_database",
							description: "Destroy database",
							inputSchema: { type: "object" },
						},
					],
					config: {
						transport: "stdio",
						name: "admin",
						command: "echo",
						enabled: true,
						confirm: ["destroy_database"],
					},
				},
			],
		]);

		const { handlers } = buildToolSet("/tmp", "localhost", mcpTools, confirmFn);

		const handler = handlers.get("boundless_mcp_admin_destroy_database");
		expect(handler).toBeDefined();

		if (!handler) return;

		// Call the handler
		const result = await handler({}, new AbortController().signal, "/tmp");

		// Verify result is NOT an error
		expect(result.isError).toBeUndefined();
		expect(result.content).toBeDefined();
	});

	it("handles missing confirmFn gracefully for confirm-marked tools", async () => {
		// When confirmFn is not provided, confirm-marked tools should still work
		const mcpTools = new Map<
			string,
			{
				tools: import("@modelcontextprotocol/sdk/types.js").Tool[];
				config: import("../config").McpServerConfig;
			}
		>([
			[
				"admin",
				{
					tools: [
						{
							name: "destroy_database",
							description: "Destroy database",
							inputSchema: { type: "object" },
						},
					],
					config: {
						transport: "stdio",
						name: "admin",
						command: "echo",
						enabled: true,
						confirm: ["destroy_database"],
					},
				},
			],
		]);

		const { handlers } = buildToolSet("/tmp", "localhost", mcpTools);

		const handler = handlers.get("boundless_mcp_admin_destroy_database");
		expect(handler).toBeDefined();

		if (!handler) return;

		// Call the handler - should not throw even without confirmFn
		const result = await handler({}, new AbortController().signal, "/tmp");

		// Verify result is NOT an error (base handler returned)
		expect(result.isError).toBeUndefined();
		expect(result.content).toBeDefined();
	});

	it("combines allowTools and confirm filtering", async () => {
		const confirmFn = async (_toolName: string): Promise<boolean> => {
			return false; // Always decline
		};

		const mcpTools = new Map<
			string,
			{
				tools: import("@modelcontextprotocol/sdk/types.js").Tool[];
				config: import("../config").McpServerConfig;
			}
		>([
			[
				"admin",
				{
					tools: [
						{
							name: "read",
							description: "Read",
							inputSchema: { type: "object" },
						},
						{
							name: "write",
							description: "Write",
							inputSchema: { type: "object" },
						},
						{
							name: "delete",
							description: "Delete",
							inputSchema: { type: "object" },
						},
					],
					config: {
						transport: "stdio",
						name: "admin",
						command: "echo",
						enabled: true,
						allowTools: ["read", "write"], // delete is excluded
						confirm: ["write"], // write requires confirmation
					},
				},
			],
		]);

		const { tools, handlers } = buildToolSet("/tmp", "localhost", mcpTools, confirmFn);

		// Should have 4 core + 2 MCP tools (delete excluded)
		expect(tools).toHaveLength(6);

		// read should exist without confirmation
		expect(tools.find((t) => t.function.name === "boundless_mcp_admin_read")).toBeDefined();

		// write should exist with confirmation
		expect(tools.find((t) => t.function.name === "boundless_mcp_admin_write")).toBeDefined();

		// delete should NOT exist (filtered by allowTools)
		expect(tools.find((t) => t.function.name === "boundless_mcp_admin_delete")).toBeUndefined();

		// Test that write handler has confirmation gate
		const writeHandler = handlers.get("boundless_mcp_admin_write");
		if (writeHandler) {
			const result = await writeHandler({}, new AbortController().signal, "/tmp");
			expect(result.isError).toBe(true);
		}
	});
});

describe("buildSystemPromptAddition", () => {
	it("returns system prompt with core tools only", () => {
		const prompt = buildSystemPromptAddition("/home/user", "example.com", []);

		expect(prompt).toContain("boundless terminal client");
		expect(prompt).toContain("Host: example.com");
		expect(prompt).toContain("Working directory: /home/user");
		expect(prompt).toContain("boundless_read");
		expect(prompt).toContain("boundless_write");
		expect(prompt).toContain("boundless_edit");
		expect(prompt).toContain("boundless_bash");
		expect(prompt).toContain("provenance metadata");
	});

	it("includes MCP server namespaces", () => {
		const prompt = buildSystemPromptAddition("/home/user", "example.com", ["github", "slack"]);

		expect(prompt).toContain("boundless_mcp_github_*");
		expect(prompt).toContain("boundless_mcp_slack_*");
	});

	it("returns consistent format", () => {
		const prompt = buildSystemPromptAddition("/tmp", "localhost", []);

		// Should have multiple lines
		expect(prompt.split("\n").length).toBeGreaterThan(2);

		// Should mention available tools
		expect(prompt.toLowerCase()).toContain("tool");
	});
});
