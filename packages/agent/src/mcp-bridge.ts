/**
 * MCP Bridge for auto-generating defineCommands from MCP tools.
 * Implements MCP tool discovery and command generation per spec §7.3.
 * Implements cross-host MCP tool proxying per spec §7.5.
 *
 * NOTE: URL filtering for outbound requests should be enforced at the tool handler level.
 * The sandbox's urlFilter (from createSandbox) should be checked before making any
 * outbound HTTP requests from MCP tools. This is currently the responsibility of
 * the caller (e.g., agent loop or MCP tool implementations).
 */

import type { Database } from "bun:sqlite";
import type { CommandContext, CommandDefinition, CommandResult } from "@bound/sandbox";
import { formatError } from "@bound/shared";
import type { KeyringConfig } from "@bound/shared";
import { signRequest } from "@bound/sync";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import type { MCPClient, ToolResult } from "./mcp-client";

/**
 * Configuration for cross-host proxy routing.
 */
export interface MCPProxyConfig {
	db: Database;
	siteId: string;
	keyring: KeyringConfig;
	privateKey: CryptoKey;
}

/**
 * Proxy a tool call to a remote host.
 * Looks up the remote host's sync_url, signs the request, and POSTs to /api/mcp-proxy.
 * Implements the routing logic from spec §7.5.
 *
 * TODO: Integrate URL filtering (sandbox.urlFilter.enforce(targetUrl)) before fetch
 * to enforce the allowlist from network.json per spec R-S1.
 */
async function proxyToolCall(
	toolCommandName: string,
	serverName: string,
	toolName: string,
	args: Record<string, unknown>,
	proxyConfig: MCPProxyConfig,
): Promise<ToolResult> {
	const { db, siteId, keyring, privateKey } = proxyConfig;

	// Find a remote host that advertises this tool in its mcp_tools column
	// Prefer hosts with a sync_url set; skip our own row
	const remoteHosts = db
		.query(
			`SELECT site_id, host_name, sync_url, mcp_tools
			 FROM hosts
			 WHERE site_id != ? AND sync_url IS NOT NULL AND mcp_tools IS NOT NULL`,
		)
		.all(siteId) as Array<{
		site_id: string;
		host_name: string;
		sync_url: string;
		mcp_tools: string;
	}>;

	// Find eligible hosts that list the tool
	const eligible = remoteHosts.filter((row) => {
		try {
			const tools = JSON.parse(row.mcp_tools) as string[];
			return tools.includes(toolCommandName);
		} catch {
			// Skip hosts with malformed mcp_tools JSON
			return false;
		}
	});

	if (eligible.length === 0) {
		return {
			content: `Error: Tool "${toolCommandName}" is not available on any reachable remote host`,
			isError: true,
		};
	}

	const body = JSON.stringify({ server: serverName, tool: toolName, arguments: args });
	const path = "/api/mcp-proxy";

	// Try each eligible host in order; failover on error
	const errors: string[] = [];
	for (const remoteHost of eligible) {
		// Resolve base URL: hosts table sync_url first, keyring fallback
		let baseUrl = remoteHost.sync_url;
		const keyringEntry = (keyring.hosts as Record<string, { url: string } | undefined>)[
			remoteHost.site_id
		];
		if (!baseUrl && keyringEntry?.url) {
			baseUrl = keyringEntry.url;
		}
		if (!baseUrl) {
			errors.push(`${remoteHost.host_name}: no URL available`);
			continue;
		}

		const targetUrl = `${baseUrl.replace(/\/$/, "")}${path}`;

		try {
			const signedHeaders = await signRequest(privateKey, siteId, "POST", path, body);
			const response = await fetch(targetUrl, {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					...signedHeaders,
				},
				body,
			});

			if (!response.ok) {
				const errText = await response.text().catch(() => `HTTP ${response.status}`);
				errors.push(`${remoteHost.host_name}: ${response.status} ${errText}`);
				continue;
			}

			const data = (await response.json()) as { result?: ToolResult; error?: string };
			if (data.error) {
				return { content: `Remote error: ${data.error}`, isError: true };
			}
			if (data.result) {
				return data.result;
			}
			return { content: "", isError: false };
		} catch (fetchError) {
			const message = fetchError instanceof Error ? fetchError.message : String(fetchError);
			errors.push(`${remoteHost.host_name}: ${message}`);
		}
	}

	return {
		content: `Error: All remote hosts failed for tool "${toolCommandName}":\n${errors.join("\n")}`,
		isError: true,
	};
}

/**
 * Generate defineCommands from MCP tools discovered on connected servers.
 * Returns an array of CommandDefinition for each tool with name format: {server-name}-{tool-name}
 *
 * Calls listTools() on each connected client to enumerate tools.
 * When proxyConfig is provided, also generates commands for tools advertised by remote hosts
 * that are not available locally.
 */
export async function generateMCPCommands(
	clients: Map<string, MCPClient>,
	confirmGates: Map<string, string[]> = new Map(),
	proxyConfig?: MCPProxyConfig,
): Promise<CommandDefinition[]> {
	const commands: CommandDefinition[] = [];

	for (const [serverName, client] of clients) {
		if (!client.isConnected()) {
			continue;
		}

		// Get the server config to check allow_tools
		const config = client.getConfig();
		const allowTools = config.allow_tools;

		let toolsList: Tool[] = [];
		try {
			toolsList = await client.listTools();
		} catch {
			// If listTools throws (e.g., server disconnected), skip this server
			continue;
		}

		const serverConfirms = confirmGates.get(serverName) ?? [];

		for (const tool of toolsList) {
			// Apply allow_tools filter
			if (allowTools && !allowTools.includes(tool.name)) {
				continue;
			}

			const commandName = `${serverName}-${tool.name}`;
			const isConfirmed = serverConfirms.includes(tool.name);

			// Extract parameter names from tool's inputSchema for help/discovery
			const toolArgs: CommandDefinition["args"] = [];
			const schema = tool.inputSchema as { properties?: Record<string, unknown>; required?: string[] } | undefined;
			if (schema?.properties) {
				const required = new Set(schema.required ?? []);
				for (const paramName of Object.keys(schema.properties)) {
					const prop = schema.properties[paramName] as { description?: string } | undefined;
					toolArgs.push({
						name: paramName,
						required: required.has(paramName),
						description: prop?.description,
					});
				}
			}

			const command: CommandDefinition = {
				name: commandName,
				args: toolArgs,
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
						const message = formatError(error);
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

	// Generate proxy commands for remote tools not available locally
	if (proxyConfig) {
		const localToolNames = new Set(commands.map((c) => c.name));
		const remoteCommands = generateRemoteMCPCommands(localToolNames, proxyConfig);
		for (const cmd of remoteCommands) {
			commands.push(cmd);
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
 * Generate proxy CommandDefinitions for tools available on remote hosts but not locally.
 * Only creates commands for tool names not already present in localToolNames.
 */
function generateRemoteMCPCommands(
	localToolNames: Set<string>,
	proxyConfig: MCPProxyConfig,
): CommandDefinition[] {
	const { db, siteId } = proxyConfig;

	// Collect all remote tool names from the hosts table, excluding our own row
	const remoteHosts = db
		.query(
			`SELECT site_id, mcp_tools
			 FROM hosts
			 WHERE site_id != ? AND mcp_tools IS NOT NULL`,
		)
		.all(siteId) as Array<{ site_id: string; mcp_tools: string }>;

	// Build a deduplicated set of remote tool command names
	const remoteToolNames = new Set<string>();
	for (const row of remoteHosts) {
		try {
			const tools = JSON.parse(row.mcp_tools) as string[];
			for (const toolCommandName of tools) {
				if (!localToolNames.has(toolCommandName)) {
					remoteToolNames.add(toolCommandName);
				}
			}
		} catch {
			// Skip hosts with malformed mcp_tools JSON
		}
	}

	const commands: CommandDefinition[] = [];

	for (const toolCommandName of remoteToolNames) {
		// Decompose "{serverName}-{toolName}" — split on first dash
		const dashIdx = toolCommandName.indexOf("-");
		const serverName = dashIdx >= 0 ? toolCommandName.slice(0, dashIdx) : toolCommandName;
		const toolName = dashIdx >= 0 ? toolCommandName.slice(dashIdx + 1) : toolCommandName;

		const command: CommandDefinition = {
			name: toolCommandName,
			args: [],
			handler: async (
				args: Record<string, string>,
				_ctx: CommandContext,
			): Promise<CommandResult> => {
				try {
					const result = await proxyToolCall(
						toolCommandName,
						serverName,
						toolName,
						args,
						proxyConfig,
					);
					return {
						stdout: result.content,
						stderr: result.isError ? result.content : "",
						exitCode: result.isError ? 1 : 0,
					};
				} catch (error) {
					const message = formatError(error);
					return {
						stdout: "",
						stderr: `Failed to proxy tool ${toolCommandName}: ${message}\n`,
						exitCode: 1,
					};
				}
			},
		};

		commands.push(command);
	}

	return commands;
}

/**
 * Create the 'resources' command to list all resources across MCP servers
 */
function createResourcesCommand(clients: Map<string, MCPClient>): CommandDefinition {
	return {
		name: "resources",
		args: [{ name: "server", required: false, description: "Optional server name to filter by" }],
		handler: async (args: Record<string, string>, _ctx: CommandContext): Promise<CommandResult> => {
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
						const serverResources = await client.listResources();
						for (const resource of serverResources) {
							resources.push(`${serverName}: ${resource.uri} (${resource.name})`);
						}
					} catch {
						// Skip servers that fail to list resources (e.g., disconnected)
					}
				}

				return {
					stdout: resources.length > 0 ? `${resources.join("\n")}\n` : "",
					stderr: "",
					exitCode: 0,
				};
			} catch (error) {
				const message = formatError(error);
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
		handler: async (args: Record<string, string>, _ctx: CommandContext): Promise<CommandResult> => {
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
							stdout: `${content.content}\n`,
							stderr: "",
							exitCode: 0,
						};
					} catch {
						// Resource not found on this server, try next
					}
				}

				return {
					stdout: "",
					stderr: `Resource not found: ${args.uri}\n`,
					exitCode: 1,
				};
			} catch (error) {
				const message = formatError(error);
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
		handler: async (args: Record<string, string>, _ctx: CommandContext): Promise<CommandResult> => {
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
						const serverPrompts = await client.listPrompts();
						for (const prompt of serverPrompts) {
							prompts.push(`${serverName}: ${prompt.name} (${prompt.description ?? ""})`);
						}
					} catch {
						// Skip servers that fail to list prompts (e.g., disconnected)
					}
				}

				return {
					stdout: prompts.length > 0 ? `${prompts.join("\n")}\n` : "",
					stderr: "",
					exitCode: 0,
				};
			} catch (error) {
				const message = formatError(error);
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
		handler: async (args: Record<string, string>, _ctx: CommandContext): Promise<CommandResult> => {
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
					stdout: `${output}\n`,
					stderr: "",
					exitCode: 0,
				};
			} catch (error) {
				const message = formatError(error);
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
 * Update host's MCP info in database.
 * Records the connected servers and their tools in the hosts table.
 */
export async function updateHostMCPInfo(
	db: Database,
	siteId: string,
	clients: Map<string, MCPClient>,
): Promise<void> {
	try {
		const mcp_servers = Array.from(clients.keys());

		// Flatten tool names from all servers
		const mcp_tools: string[] = [];
		for (const [serverName, client] of clients) {
			if (client.isConnected()) {
				try {
					const tools = await client.listTools();
					for (const tool of tools) {
						mcp_tools.push(`${serverName}-${tool.name}`);
					}
				} catch {
					// Skip servers that fail to list tools (e.g., temporary disconnect)
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
	} catch {
		// Silently ignore DB errors — this is a best-effort metadata update, logger not available in this function signature
	}
}
