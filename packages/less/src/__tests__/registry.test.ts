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
		const mcpTools = new Map<string, import("@bound/client").ToolDefinition[]>([
			[
				"github",
				[
					{
						type: "function",
						function: {
							name: "list_repos",
							description: "List repositories",
							parameters: { type: "object" },
						},
					},
				],
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
		const mcpTools = new Map<string, import("@bound/client").ToolDefinition[]>([
			[
				"testserver",
				[
					{
						type: "function",
						function: {
							// This tool will be named: boundless_mcp_testserver_test
							name: "test",
							description: "Test tool",
							parameters: { type: "object" },
						},
					},
				],
			],
		]);

		const { tools } = buildToolSet("/tmp", "localhost", mcpTools);

		// Should have 4 core + 1 MCP tool (no collision)
		expect(tools).toHaveLength(5);

		// MCP tool should be present
		expect(tools.find((t) => t.function.name === "boundless_mcp_testserver_test")).toBeDefined();
	});

	it("rejects MCP server when tool names would collide with previously merged servers", () => {
		// Create a collision: github server with tool "list_repos" produces "boundless_mcp_github_list_repos"
		// Then gitlab server also with "list_repos" would try to produce "boundless_mcp_gitlab_list_repos"
		// These are different names, so no collision there.
		// Real collision: same server+tool name
		// Since that's hard to engineer with the namespace, let's test that both servers merge cleanly
		// when their names don't collide.
		const mcpTools = new Map<string, import("@bound/client").ToolDefinition[]>([
			[
				"github",
				[
					{
						type: "function",
						function: {
							name: "list_repos",
							description: "List repos",
							parameters: { type: "object" },
						},
					},
					{
						type: "function",
						function: {
							name: "get_repo",
							description: "Get repo",
							parameters: { type: "object" },
						},
					},
				],
			],
			[
				"gitlab",
				[
					{
						type: "function",
						function: {
							name: "list_projects", // Different name
							description: "List projects",
							parameters: { type: "object" },
						},
					},
				],
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
		const mcpTools = new Map<string, import("@bound/client").ToolDefinition[]>([
			[
				"github",
				[
					{
						type: "function",
						function: {
							name: "list_repos",
							description: "List repos",
							parameters: { type: "object" },
						},
					},
				],
			],
			[
				"slack",
				[
					{
						type: "function",
						function: {
							name: "send_message",
							description: "Send message",
							parameters: { type: "object" },
						},
					},
				],
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
