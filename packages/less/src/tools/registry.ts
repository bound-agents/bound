import type { ToolDefinition } from "@bound/client";
import { bashTool } from "./bash";
import { editTool } from "./edit";
import { readTool } from "./read";
import type { ToolHandler } from "./types";
import { writeTool } from "./write";

export interface BuildToolSetResult {
	tools: ToolDefinition[];
	handlers: Map<string, ToolHandler>;
}

export function buildToolSet(
	_cwd: string,
	_hostname: string,
	mcpTools?: Map<string, ToolDefinition[]>,
): BuildToolSetResult {
	const toolDefinitions: ToolDefinition[] = [];
	const handlers = new Map<string, ToolHandler>();

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
	handlers.set("boundless_read", readTool);
	handlers.set("boundless_write", writeTool);
	handlers.set("boundless_edit", editTool);
	handlers.set("boundless_bash", bashTool);

	// Track all existing tool names for collision detection
	const existingNames = new Set<string>([
		"boundless_read",
		"boundless_write",
		"boundless_edit",
		"boundless_bash",
	]);

	// Add MCP tools with collision detection
	if (mcpTools) {
		for (const [serverName, tools] of mcpTools) {
			let serverRejected = false;

			for (const tool of tools) {
				const mcpToolName = `boundless_mcp_${serverName}_${tool.function.name}`;

				// Check for collision
				if (existingNames.has(mcpToolName)) {
					console.warn(
						`MCP server '${serverName}' has tool '${tool.function.name}' that collides with existing tool '${mcpToolName}'. Rejecting entire server.`,
					);
					serverRejected = true;
					break;
				}

				existingNames.add(mcpToolName);
			}

			// If no collision, add all tools from this server
			if (!serverRejected) {
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

					// For MCP tools, we don't have actual handlers - they would be
					// proxied through the MCP server. This is a placeholder.
					// The actual handler would be implemented in a different layer.
					handlers.set(mcpToolName, async () => {
						return [
							{
								type: "text",
								text: `MCP tool ${mcpToolName} not directly executable`,
							},
						];
					});
				}
			}
		}
	}

	return {
		tools: toolDefinitions,
		handlers,
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
