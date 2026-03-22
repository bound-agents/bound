/**
 * MCP Bridge for auto-generating defineCommands from MCP tools.
 * Implements MCP tool discovery and command generation per spec §7.3.
 */

import type Database from "bun:sqlite";
import type { CommandContext, CommandDefinition, CommandResult } from "@bound/sandbox";
import type { MCPClient, ToolDefinition } from "./mcp-client";

/**
 * Generate defineCommands from MCP tools discovered on connected servers
 * Returns an array of CommandDefinition for each tool with name format: {server-name}-{tool-name}
 *
 * Tools are enumerated synchronously from the client's internal state after connect() is called.
 */
export function generateMCPCommands(
	clients: Map<string, MCPClient>,
	confirmGates: Map<string, string[]> = new Map(),
): CommandDefinition[] {
	const commands: CommandDefinition[] = [];

	for (const [serverName, client] of clients) {
		if (!client.isConnected()) {
			continue;
		}

		// Get the server config to check allow_tools
		const config = client.getConfig();
		const allowTools = config.allow_tools;

		// Get tools synchronously from the client
		let toolsList: ToolDefinition[] = [];
		try {
			toolsList = client.listTools(); // Sync access to already-loaded tools
		} catch {
			// If listTools throws, skip this server
			continue;
		}

		const serverConfirms = confirmGates.get(serverName) || [];

		for (const tool of toolsList) {
			// Apply allow_tools filter
			if (allowTools && !allowTools.includes(tool.name)) {
				continue;
			}

			const commandName = `${serverName}-${tool.name}`;
			const isConfirmed = serverConfirms.includes(tool.name);

			const command: CommandDefinition = {
				name: commandName,
				args: [],
				handler: async (
					args: Record<string, string>,
					ctx: CommandContext,
				): Promise<CommandResult> => {
					// Check if this is a confirmed tool and we're in autonomous mode
					if (isConfirmed && ctx.taskId && !ctx.taskId.startsWith("interactive-")) {
						return {
							stdout: "",
							stderr: `Tool ${commandName} requires confirmation and cannot be used in autonomous mode\n`,
							exitCode: 1,
						};
					}

					try {
						const result = await client.callTool(tool.name, args);
						return {
							stdout: result.content,
							stderr: result.isError ? result.content : "",
							exitCode: result.isError ? 1 : 0,
						};
					} catch (error) {
						const message = error instanceof Error ? error.message : String(error);
						return {
							stdout: "",
							stderr: `Failed to call tool ${commandName}: ${message}\n`,
							exitCode: 1,
						};
					}
				},
			};

			commands.push(command);
		}
	}

	// Add MCP access commands
	commands.push(createResourcesCommand(clients));
	commands.push(createResourceCommand(clients));
	commands.push(createPromptsCommand(clients));
	commands.push(createPromptCommand(clients));

	return commands;
}

/**
 * Create the 'resources' command to list all resources across MCP servers
 */
function createResourcesCommand(clients: Map<string, MCPClient>): CommandDefinition {
	return {
		name: "resources",
		args: [{ name: "server", required: false, description: "Optional server name to filter by" }],
		handler: async (args: Record<string, string>, ctx: CommandContext): Promise<CommandResult> => {
			try {
				const targetServer = args.server;
				const resources: string[] = [];

				for (const [serverName, client] of clients) {
					if (targetServer && serverName !== targetServer) {
						continue;
					}

					if (!client.isConnected()) {
						continue;
					}

					try {
						const serverResources = client.listResources(); // Sync access
						for (const resource of serverResources) {
							resources.push(`${serverName}: ${resource.uri} (${resource.name})`);
						}
					} catch {
						// Skip servers that fail to list resources
					}
				}

				return {
					stdout: resources.length > 0 ? resources.join("\n") + "\n" : "",
					stderr: "",
					exitCode: 0,
				};
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				return {
					stdout: "",
					stderr: `Failed to list resources: ${message}\n`,
					exitCode: 1,
				};
			}
		},
	};
}

/**
 * Create the 'resource' command to read a specific resource
 */
function createResourceCommand(clients: Map<string, MCPClient>): CommandDefinition {
	return {
		name: "resource",
		args: [
			{ name: "uri", required: true, description: "Resource URI to read" },
			{ name: "server", required: false, description: "Server name (optional)" },
		],
		handler: async (args: Record<string, string>, ctx: CommandContext): Promise<CommandResult> => {
			try {
				const uri = args.uri;
				const targetServer = args.server;

				for (const [serverName, client] of clients) {
					if (targetServer && serverName !== targetServer) {
						continue;
					}

					if (!client.isConnected()) {
						continue;
					}

					try {
						const content = await client.readResource(uri);
						return {
							stdout: content.content + "\n",
							stderr: "",
							exitCode: 0,
						};
					} catch {
						// Try next server
					}
				}

				return {
					stdout: "",
					stderr: `Resource not found: ${uri}\n`,
					exitCode: 1,
				};
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				return {
					stdout: "",
					stderr: `Failed to read resource: ${message}\n`,
					exitCode: 1,
				};
			}
		},
	};
}

/**
 * Create the 'prompts' command to list all prompts across MCP servers
 */
function createPromptsCommand(clients: Map<string, MCPClient>): CommandDefinition {
	return {
		name: "prompts",
		args: [{ name: "server", required: false, description: "Optional server name to filter by" }],
		handler: async (args: Record<string, string>, ctx: CommandContext): Promise<CommandResult> => {
			try {
				const targetServer = args.server;
				const prompts: string[] = [];

				for (const [serverName, client] of clients) {
					if (targetServer && serverName !== targetServer) {
						continue;
					}

					if (!client.isConnected()) {
						continue;
					}

					try {
						const serverPrompts = client.listPrompts(); // Sync access
						for (const prompt of serverPrompts) {
							prompts.push(`${serverName}: ${prompt.name} (${prompt.description})`);
						}
					} catch {
						// Skip servers that fail to list prompts
					}
				}

				return {
					stdout: prompts.length > 0 ? prompts.join("\n") + "\n" : "",
					stderr: "",
					exitCode: 0,
				};
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				return {
					stdout: "",
					stderr: `Failed to list prompts: ${message}\n`,
					exitCode: 1,
				};
			}
		},
	};
}

/**
 * Create the 'prompt' command to invoke a specific prompt
 */
function createPromptCommand(clients: Map<string, MCPClient>): CommandDefinition {
	return {
		name: "prompt",
		args: [{ name: "name", required: true, description: "Prompt name (format: server/name)" }],
		handler: async (args: Record<string, string>, ctx: CommandContext): Promise<CommandResult> => {
			try {
				const nameArg = args.name;
				const [serverName, promptName] = nameArg.includes("/")
					? nameArg.split("/", 2)
					: [nameArg, ""];

				const client = clients.get(serverName);
				if (!client) {
					return {
						stdout: "",
						stderr: `Server not found: ${serverName}\n`,
						exitCode: 1,
					};
				}

				if (!client.isConnected()) {
					return {
						stdout: "",
						stderr: `Server not connected: ${serverName}\n`,
						exitCode: 1,
					};
				}

				// Parse remaining args as prompt arguments
				const promptArgs: Record<string, string> = {};
				for (const [key, value] of Object.entries(args)) {
					if (key !== "name") {
						promptArgs[key] = value;
					}
				}

				const result = await client.invokePrompt(promptName, promptArgs);
				const output = result.messages.map((m) => m.content).join("\n");

				return {
					stdout: output + "\n",
					stderr: "",
					exitCode: 0,
				};
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				return {
					stdout: "",
					stderr: `Failed to invoke prompt: ${message}\n`,
					exitCode: 1,
				};
			}
		},
	};
}

/**
 * Update host's MCP info in database
 * Records the connected servers and their tools in the hosts table
 */
export function updateHostMCPInfo(
	db: Database,
	siteId: string,
	clients: Map<string, MCPClient>,
): void {
	try {
		const mcp_servers = Array.from(clients.keys());

		// Flatten tool names from all servers
		const mcp_tools: string[] = [];
		for (const [serverName, client] of clients) {
			if (client.isConnected()) {
				try {
					const tools = client.listTools().catch(() => []);
					for (const tool of tools) {
						mcp_tools.push(`${serverName}-${tool.name}`);
					}
				} catch {
					// Skip servers that fail
				}
			}
		}

		// Update hosts table
		const stmt = db.prepare(
			"UPDATE hosts SET mcp_servers = ?, mcp_tools = ?, modified_at = ? WHERE site_id = ?",
		);
		stmt.run(
			JSON.stringify(mcp_servers),
			JSON.stringify(mcp_tools),
			new Date().toISOString(),
			siteId,
		);
	} catch (error) {
		// Log but don't fail
		console.error("Failed to update host MCP info:", error);
	}
}
