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
import { writeOutbox } from "@bound/core";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { findEligibleHosts, isHostStale, createRelayOutboxEntry, type EligibleHost } from "./relay-router";
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
 * Signal from a remote MCP command handler that indicates a relay request
 * should be sent via the outbox, and the agent loop should enter RELAY_WAIT.
 * Also includes CommandResult fields for type compatibility with handlers.
 */
export interface RelayToolCallRequest {
	outboxEntryId: string;
	targetSiteId: string;
	targetHostName: string;
	toolName: string;
	eligibleHosts: EligibleHost[];
	currentHostIndex: number;
	// CommandResult fields (required for handler return type compatibility)
	stdout: string;
	stderr: string;
	exitCode: number;
}

/**
 * Type guard to check if a command result is actually a relay request.
 */
export function isRelayRequest(
	result: CommandResult | RelayToolCallRequest,
): result is RelayToolCallRequest {
	return "outboxEntryId" in result;
}

/**
 * Initiate a relay request for a remote tool call.
 * Uses findEligibleHosts to discover which hosts have the tool,
 * checks host staleness, and writes a relay outbox entry.
 * Returns a RelayToolCallRequest for the agent loop to enter RELAY_WAIT.
 */
function initializeRelayToolCall(
	toolCommandName: string,
	args: Record<string, unknown>,
	proxyConfig: MCPProxyConfig,
): RelayToolCallRequest | { error: string; isError: boolean } {
	const { db, siteId } = proxyConfig;

	// Find eligible hosts using relay routing
	const routingResult = findEligibleHosts(db, toolCommandName, siteId);
	if (!routingResult.ok) {
		// AC1.6: Tool not available on any remote host
		return {
			error: routingResult.error,
			isError: true,
		};
	}

	const hosts = routingResult.hosts;

	// Check if the best host (first in sorted list) is stale
	// AC1.7: All hosts are stale — return descriptive error with staleness info
	if (hosts.length > 0 && isHostStale(hosts[0])) {
		const bestHost = hosts[0];
		const stalenessMs = bestHost.online_at
			? Date.now() - new Date(bestHost.online_at).getTime()
			: Number.POSITIVE_INFINITY;
		const stalenessMinutes = Math.ceil(stalenessMs / 60_000);
		return {
			error: `Tool "${toolCommandName}" not reachable: ${bestHost.host_name} last seen ${stalenessMinutes} minute(s) ago`,
			isError: true,
		};
	}

	// Build relay outbox entry
	const targetHost = hosts[0];
	const payload = JSON.stringify({
		kind: "tool_call",
		toolName: toolCommandName,
		args,
	});

	const outboxEntry = createRelayOutboxEntry(
		targetHost.site_id,
		"tool_call",
		payload,
		30_000, // 30 second timeout per host attempt
	);

	// Write to outbox
	try {
		writeOutbox(db, outboxEntry);
	} catch (error) {
		return {
			error: `Failed to write relay outbox entry: ${error instanceof Error ? error.message : String(error)}`,
			isError: true,
		};
	}

	return {
		outboxEntryId: outboxEntry.id,
		targetSiteId: targetHost.site_id,
		targetHostName: targetHost.host_name,
		toolName: toolCommandName,
		eligibleHosts: hosts,
		currentHostIndex: 0,
		stdout: "",
		stderr: "",
		exitCode: 0,
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
			const schema = tool.inputSchema as
				| { properties?: Record<string, unknown>; required?: string[] }
				| undefined;
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
 * Uses relay-based routing: writes outbox entry and returns RelayToolCallRequest
 * for the agent loop to handle via RELAY_WAIT.
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
					const result = initializeRelayToolCall(toolCommandName, args, proxyConfig);

					// Check if this is a relay request or an error
					if ("outboxEntryId" in result) {
						// Return relay request (also satisfies CommandResult interface)
						// for agent loop to detect and handle via RELAY_WAIT
						return result as CommandResult;
					}

					// It's an error response
					if ("isError" in result && result.isError) {
						return {
							stdout: "",
							stderr: `${result.error}\n`,
							exitCode: 1,
						};
					}

					return {
						stdout: "",
						stderr: "Unknown error in relay initialization\n",
						exitCode: 1,
					};
				} catch (error) {
					const message = formatError(error);
					return {
						stdout: "",
						stderr: `Failed to initialize relay for tool ${toolCommandName}: ${message}\n`,
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
