import type { ToolDefinition } from "@bound/client";
import { createBashTool } from "./bash";
import { createEditTool } from "./edit";
import { createReadTool } from "./read";
import type { ToolHandler } from "./types";
import { createWriteTool } from "./write";

export interface ToolNameMapping {
	serverName: string;
	toolName: string;
}

export interface BuildToolSetResult {
	tools: ToolDefinition[];
	handlers: Map<string, ToolHandler>;
	toolNameMapping: Map<string, ToolNameMapping>;
}

export function buildToolSet(
	_cwd: string,
	_hostname: string,
	mcpTools?: Map<string, ToolDefinition[]>,
): BuildToolSetResult {
	const toolDefinitions: ToolDefinition[] = [];
	const handlers = new Map<string, ToolHandler>();
	const toolNameMapping = new Map<string, ToolNameMapping>();

	// Add core tools
	const coreToolDefs: ToolDefinition[] = [
		{
			type: "function",
			function: {
				name: "boundless_read",
				description: "Read file contents with line numbers",
				parameters: {
					type: "object",
					required: ["file_path"],
					properties: {
						file_path: {
							type: "string",
							description: "Path to file to read (relative to cwd if not absolute)",
						},
						offset: {
							type: "number",
							description: "Starting line number (1-indexed, optional)",
						},
						limit: {
							type: "number",
							description: "Number of lines to read (optional)",
						},
					},
				},
			},
		},
		{
			type: "function",
			function: {
				name: "boundless_write",
				description: "Write content to a file (creates parents, atomic write)",
				parameters: {
					type: "object",
					required: ["file_path", "content"],
					properties: {
						file_path: {
							type: "string",
							description: "Path to file to write (relative to cwd if not absolute)",
						},
						content: {
							type: "string",
							description: "Content to write",
						},
					},
				},
			},
		},
		{
			type: "function",
			function: {
				name: "boundless_edit",
				description: "Replace exactly one occurrence of a string in a file",
				parameters: {
					type: "object",
					required: ["file_path", "old_string", "new_string"],
					properties: {
						file_path: {
							type: "string",
							description: "Path to file to edit (relative to cwd if not absolute)",
						},
						old_string: {
							type: "string",
							description: "String to find and replace",
						},
						new_string: {
							type: "string",
							description: "String to replace with",
						},
					},
				},
			},
		},
		{
			type: "function",
			function: {
				name: "boundless_bash",
				description: "Execute a shell command with AbortSignal support",
				parameters: {
					type: "object",
					required: ["command"],
					properties: {
						command: {
							type: "string",
							description: "Shell command to execute",
						},
						timeout: {
							type: "number",
							description: "Timeout in milliseconds (default 300000)",
						},
					},
				},
			},
		},
	];

	toolDefinitions.push(...coreToolDefs);
	handlers.set("boundless_read", createReadTool(_hostname));
	handlers.set("boundless_write", createWriteTool(_hostname));
	handlers.set("boundless_edit", createEditTool(_hostname));
	handlers.set("boundless_bash", createBashTool(_hostname));

	// Detect potential namespace collisions from underscore ambiguity
	// Example: server "a_b" with tool "c" -> "boundless_mcp_a_b_c"
	//          server "a" with tool "b_c"  -> "boundless_mcp_a_b_c" (collision!)
	function detectNamespaceCollision(mcpServersMap: Map<string, ToolDefinition[]>): {
		collision: boolean;
		servers: string[];
	} {
		const toolNamespacesToServers = new Map<string, string[]>();
		const collisionServers = new Set<string>();

		for (const [serverName, tools] of mcpServersMap) {
			for (const tool of tools) {
				const fullNamespace = `boundless_mcp_${serverName}_${tool.function.name}`;

				let servers = toolNamespacesToServers.get(fullNamespace);
				if (!servers) {
					servers = [];
					toolNamespacesToServers.set(fullNamespace, servers);
				}

				servers.push(serverName);

				if (servers.length > 1) {
					// Collision detected - mark all servers involved in this collision
					for (const server of servers) {
						collisionServers.add(server);
					}
				}
			}
		}

		return {
			collision: collisionServers.size > 0,
			servers: Array.from(collisionServers),
		};
	}

	// Add MCP tools with collision detection
	if (mcpTools) {
		// Check for underscore ambiguity collisions
		const collisionCheck = detectNamespaceCollision(mcpTools);
		if (collisionCheck.collision) {
			console.warn(
				`MCP servers produce namespace collisions (underscore ambiguity): ${collisionCheck.servers.join(", ")}. These servers will be rejected.`,
			);
		}

		for (const [serverName, tools] of mcpTools) {
			// Skip servers that have collision issues
			if (collisionCheck.servers.includes(serverName)) {
				continue;
			}

			for (const tool of tools) {
				const mcpToolName = `boundless_mcp_${serverName}_${tool.function.name}`;

				// Create a new tool definition with the namespaced name
				const mcpToolDef: ToolDefinition = {
					type: "function",
					function: {
						name: mcpToolName,
						description: tool.function.description,
						parameters: tool.function.parameters,
					},
				};

				toolDefinitions.push(mcpToolDef);

				// Store reverse mapping for proxyToolCall lookup
				toolNameMapping.set(mcpToolName, {
					serverName,
					toolName: tool.function.name,
				});

				// For MCP tools, we don't have actual handlers - they would be
				// proxied through the MCP server. This is a placeholder.
				// The actual handler would be implemented in a different layer.
				handlers.set(mcpToolName, async () => {
					return {
						content: [
							{
								type: "text",
								text: `MCP tool ${mcpToolName} not directly executable`,
							},
						],
					};
				});
			}
		}
	}

	return {
		tools: toolDefinitions,
		handlers,
		toolNameMapping,
	};
}

export function buildSystemPromptAddition(
	cwd: string,
	hostname: string,
	mcpServers: string[],
): string {
	const mcpNamespaces = mcpServers.map((s) => `boundless_mcp_${s}_*`).join(", ");
	const toolList = `boundless_read, boundless_write, boundless_edit, boundless_bash${
		mcpNamespaces ? `, ${mcpNamespaces}` : ""
	}`;

	return `You are connected to a boundless terminal client.
Host: ${hostname}
Working directory: ${cwd}
Available tool namespaces: ${toolList}

Tool results include provenance metadata showing which host and directory produced them.`;
}
