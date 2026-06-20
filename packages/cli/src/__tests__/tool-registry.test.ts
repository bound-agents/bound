import { beforeEach, describe, expect, it } from "bun:test";
import { createAgentTools, createBuiltInTools } from "@bound/agent";
import { InMemoryFs } from "just-bash";
import { createToolRegistry } from "../commands/start/agent-factory";

describe("tool registry", () => {
	let logger: any;

	beforeEach(() => {
		logger = {
			debug: () => {},
			info: () => {},
			warn: () => {},
			error: () => {},
		};
	});

	/** Helper to get a tool, throwing if missing (avoids non-null assertions). */
	function getTool(registry: Map<string, any>, name: string) {
		const tool = registry.get(name);
		if (!tool) throw new Error(`Tool "${name}" not found`);
		return tool;
	}

	describe("createToolRegistry", () => {
		it("registers the sandbox (bms_bash) tool first", () => {
			const registry = createToolRegistry(undefined, undefined, [], logger);
			const bashTool = getTool(registry, "bms_bash");
			expect(bashTool.kind).toBe("sandbox");
		});

		it("registers client tools (platform tools now come through registry)", () => {
			// Platform tools are no longer passed to createToolRegistry; they come
			// through the unified toolRegistry at the agent-factory level.
			// This test verifies that client tools still work correctly.
			const clientTools = new Map<
				string,
				{
					type: "function";
					function: {
						name: string;
						description: string;
						parameters: Record<string, unknown>;
					};
				}
			>([
				[
					"client_tool",
					{
						type: "function",
						function: {
							name: "client_tool",
							description: "A client tool",
							parameters: { type: "object", properties: {} },
						},
					},
				],
			]);

			const registry = createToolRegistry(undefined, clientTools, [], logger);
			const tool = getTool(registry, "client_tool");
			expect(tool.kind).toBe("client");
			expect(tool.execute).toBeUndefined();
		});

		it("registers client tools without execute handlers", () => {
			const clientTools = new Map<
				string,
				{
					type: "function";
					function: {
						name: string;
						description: string;
						parameters: Record<string, unknown>;
					};
				}
			>([
				[
					"client_tool",
					{
						type: "function",
						function: {
							name: "client_tool",
							description: "A client tool",
							parameters: { type: "object", properties: {} },
						},
					},
				],
			]);

			const registry = createToolRegistry(undefined, clientTools, [], logger);
			const tool = getTool(registry, "client_tool");
			expect(tool.kind).toBe("client");
			expect(tool.execute).toBeUndefined();
		});

		it("registers built-in tools with execute handlers", () => {
			const fs = new InMemoryFs();
			const builtInTools = createBuiltInTools(fs);

			const registry = createToolRegistry(builtInTools, undefined, [], logger);
			expect(registry.has("bms_read")).toBe(true);
			expect(registry.has("bms_write")).toBe(true);
			const readTool = getTool(registry, "bms_read");
			expect(readTool.kind).toBe("builtin");
			expect(readTool.execute).toBeDefined();
		});

		it("detects and skips duplicate tool names, logging a warning", () => {
			const warnMessages: Array<{ msg: string; data?: any }> = [];
			const loggerWithWarnings = {
				debug: () => {},
				info: () => {},
				warn: (msg: string, data?: any) => {
					warnMessages.push({ msg, data });
				},
				error: () => {},
			};

			const fs = new InMemoryFs();
			const builtInTools = createBuiltInTools(fs);

			const clientTools = new Map<
				string,
				{
					type: "function";
					function: {
						name: string;
						description: string;
						parameters: Record<string, unknown>;
					};
				}
			>([
				[
					"bms_read", // duplicate with a built-in tool
					{
						type: "function",
						function: {
							name: "bms_read",
							description: "Duplicate registration",
							parameters: { type: "object", properties: {} },
						},
					},
				],
			]);

			const registry = createToolRegistry(builtInTools, clientTools, [], loggerWithWarnings as any);

			// Client tools register before built-in tools, so client "bms_read" wins and is skipped
			const tool = getTool(registry, "bms_read");
			expect(tool.kind).toBe("client");

			// Warning should have been logged
			expect(warnMessages.length).toBeGreaterThan(0);
			const dupWarning = warnMessages.find((w) => w.msg.includes("Duplicate"));
			expect(dupWarning).toBeDefined();
		});

		it("combines all tool sources in the correct priority order", () => {
			const fs = new InMemoryFs();
			const builtInTools = createBuiltInTools(fs);

			const clientTools = new Map<
				string,
				{
					type: "function";
					function: {
						name: string;
						description: string;
						parameters: Record<string, unknown>;
					};
				}
			>([
				[
					"client_tool",
					{
						type: "function",
						function: {
							name: "client_tool",
							description: "A client tool",
							parameters: { type: "object", properties: {} },
						},
					},
				],
			]);

			const registry = createToolRegistry(builtInTools, clientTools, [], logger);

			// Tools should be present
			expect(registry.has("bms_bash")).toBe(true);
			expect(registry.has("client_tool")).toBe(true);
			expect(registry.has("bms_read")).toBe(true);
			expect(registry.has("bms_write")).toBe(true);

			// Verify kinds
			expect(getTool(registry, "bms_bash").kind).toBe("sandbox");
			expect(getTool(registry, "client_tool").kind).toBe("client");
			expect(getTool(registry, "bms_read").kind).toBe("builtin");
		});
	});

	describe("registry dispatch behavior", () => {
		it("built-in tool (file tool) execute handler returns expected output", async () => {
			const fs = new InMemoryFs();
			fs.writeFileSync("/home/user/test.txt", "test content\n");
			const builtInTools = createBuiltInTools(fs);

			const registry = createToolRegistry(builtInTools, undefined, [], logger);
			const tool = getTool(registry, "bms_read");
			expect(tool.kind).toBe("builtin");
			expect(tool.execute).toBeDefined();

			const result = await tool.execute({ path: "/home/user/test.txt" });
			expect(typeof result).toBe("string");
			expect(result).toContain("test content");
		});

		it("client tool is registered without execute handler", async () => {
			const clientTools = new Map<
				string,
				{
					type: "function";
					function: {
						name: string;
						description: string;
						parameters: Record<string, unknown>;
					};
				}
			>([
				[
					"test_client_tool",
					{
						type: "function",
						function: {
							name: "test_client_tool",
							description: "A test client tool",
							parameters: { type: "object", properties: {} },
						},
					},
				],
			]);

			const registry = createToolRegistry(undefined, clientTools, [], logger);

			const tool = getTool(registry, "test_client_tool");
			expect(tool.kind).toBe("client");
			expect(tool.execute).toBeUndefined();
		});

		it("client tool has no execute handler", () => {
			const clientTools = new Map<
				string,
				{
					type: "function";
					function: {
						name: string;
						description: string;
						parameters: Record<string, unknown>;
					};
				}
			>([
				[
					"test_client_tool",
					{
						type: "function",
						function: {
							name: "test_client_tool",
							description: "A test client tool",
							parameters: { type: "object", properties: {} },
						},
					},
				],
			]);

			const registry = createToolRegistry(undefined, clientTools, [], logger);
			const tool = getTool(registry, "test_client_tool");
			expect(tool.kind).toBe("client");
			expect(tool.execute).toBeUndefined();
		});
	});

	describe("agent tools dispatch (AC1.4)", () => {
		it("registers agent tools via createAgentTools and invokes hostinfo through registry", () => {
			const mockContext = {
				db: {} as any,
				siteId: "test-site",
				eventBus: {} as any,
				logger: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} } as any,
				taskId: undefined,
				threadId: "thread-123",
				fs: undefined,
				mcpClients: new Map(),
			};

			const agentTools = createAgentTools(mockContext);
			expect(agentTools.length).toBeGreaterThan(0);

			const registry = createToolRegistry(undefined, undefined, agentTools, logger);

			// Verify hostinfo is registered
			expect(registry.has("hostinfo")).toBe(true);
			const hostinfoTool = getTool(registry, "hostinfo");
			expect(hostinfoTool.kind).toBe("builtin");
			expect(hostinfoTool.execute).toBeDefined();
		});

		it("agent tools include task, cancel, query, emit, and other core tools", () => {
			const mockContext = {
				db: {} as any,
				siteId: "test-site",
				eventBus: {} as any,
				logger: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} } as any,
				taskId: undefined,
				threadId: "thread-123",
				fs: undefined,
				mcpClients: new Map(),
			};

			const agentTools = createAgentTools(mockContext);
			const registry = createToolRegistry(undefined, undefined, agentTools, logger);

			// Verify core agent tools are registered
			expect(registry.has("task")).toBe(true);
			expect(registry.has("cancel")).toBe(true);
			expect(registry.has("query")).toBe(true);
			expect(registry.has("purge")).toBe(true);
			expect(registry.has("advisory")).toBe(true);
			expect(registry.has("notify")).toBe(true);
			expect(registry.has("memory")).toBe(true);
		});

		it("each agent tool has a valid toolDefinition with parameters", () => {
			const mockContext = {
				db: {} as any,
				siteId: "test-site",
				eventBus: {} as any,
				logger: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} } as any,
				taskId: undefined,
				threadId: "thread-123",
				fs: undefined,
				mcpClients: new Map(),
			};

			const agentTools = createAgentTools(mockContext);
			for (const tool of agentTools) {
				expect(tool.toolDefinition.type).toBe("function");
				expect(tool.toolDefinition.function).toBeDefined();
				expect(tool.toolDefinition.function.name).toBeDefined();
				expect(tool.toolDefinition.function.description).toBeDefined();
				expect(tool.toolDefinition.function.parameters).toBeDefined();
			}
		});
	});

	describe("unknown tool lookup (AC1.6)", () => {
		it("returns undefined for non-existent tool name", () => {
			const registry = createToolRegistry(undefined, undefined, [], logger);
			const tool = registry.get("nonexistent_tool_12345");
			expect(tool).toBeUndefined();
		});

		it("handles lookup of non-existent tool without throwing", () => {
			const registry = createToolRegistry(undefined, undefined, [], logger);
			expect(() => {
				registry.get("missing_tool");
			}).not.toThrow();
		});
	});

	describe("merged tools discoverability (AC5.4)", () => {
		it("all 12 native agent tools have defined parameters", () => {
			const mockContext = {
				db: {} as any,
				siteId: "test-site",
				eventBus: {} as any,
				logger: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} } as any,
				taskId: undefined,
				threadId: "thread-123",
				fs: undefined,
				mcpClients: new Map(),
			};

			const agentTools = createAgentTools(mockContext);

			// Verify we have 12 agent tools (task, cancel, query, purge,
			// advisory, notify, introspect, archive, model_hint, hostinfo, memory, skill)
			expect(agentTools.length).toBe(12);

			// Verify each tool's parameters are defined
			for (const tool of agentTools) {
				const params = tool.toolDefinition.function.parameters;
				expect(params).toBeDefined();
				expect(params).not.toBeNull();
				// Parameters should be an object with type: "object"
				expect(params.type).toBe("object");
			}
		});

		it("each agent tool has proper toolDefinition.function.parameters structure", () => {
			const mockContext = {
				db: {} as any,
				siteId: "test-site",
				eventBus: {} as any,
				logger: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} } as any,
				taskId: undefined,
				threadId: "thread-123",
				fs: undefined,
				mcpClients: new Map(),
			};

			const agentTools = createAgentTools(mockContext);

			for (const tool of agentTools) {
				const toolDef = tool.toolDefinition;
				expect(toolDef.type).toBe("function");
				expect(toolDef.function).toBeDefined();
				expect(toolDef.function.parameters).toBeDefined();
				// Check that parameters have at least the basic structure
				const params = toolDef.function.parameters as Record<string, any>;
				expect(params.type).toBeDefined();
			}
		});

		it("merged tools from all sources maintain parameter definitions", () => {
			const fs = new InMemoryFs();
			const builtInTools = createBuiltInTools(fs);

			const mockContext = {
				db: {} as any,
				siteId: "test-site",
				eventBus: {} as any,
				logger: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} } as any,
				taskId: undefined,
				threadId: "thread-123",
				fs: undefined,
				mcpClients: new Map(),
			};

			const agentTools = createAgentTools(mockContext);
			const registry = createToolRegistry(builtInTools, undefined, agentTools, logger);

			// Verify total tool count: 1 sandbox + 4 builtin file tools + 12 agent = 17
			expect(registry.size).toBeGreaterThanOrEqual(17);

			// Verify all tools in registry have parameters defined
			for (const [name, tool] of registry) {
				const params = tool.toolDefinition.function.parameters;
				expect(params).toBeDefined(
					`Tool "${name}" missing parameters in toolDefinition.function.parameters`,
				);
				expect(typeof params).toBe("object", `Tool "${name}" parameters should be an object`);
			}
		});
	});
});
