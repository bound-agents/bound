/**
 * MCP subsystem: client connections, command generation, and tool definitions.
 */

import { MCPClient, generateMCPCommands, updateHostMCPInfo } from "@bound/agent";
import type { AppContext } from "@bound/core";
import type { ToolDefinition } from "@bound/llm";
import type { CommandDefinition } from "@bound/sandbox";
import { formatError } from "@bound/shared";

export interface McpResult {
	mcpClientsMap: Map<string, MCPClient>;
	mcpCommands: CommandDefinition[];
	mcpServerNames: Set<string>;
	mcpToolDefinitions: ToolDefinition[];
	confirmGates: Map<string, string[]>;
}

/**
 * Build LLM ToolDefinitions for MCP servers — one per server using subcommand dispatch schema.
 * @param serverNames - Set of connected server names from MCPCommandsResult
 */
export function buildMcpToolDefinitions(serverNames: Set<string>): ToolDefinition[] {
	const definitions: ToolDefinition[] = [];
	for (const serverName of serverNames) {
		definitions.push({
			type: "function",
			function: {
				name: serverName,
				description: `${serverName} MCP server tools. Call with subcommand="help" to list available tools and their parameters.`,
				parameters: {
					type: "object",
					properties: {
						subcommand: {
							type: "string",
							description:
								'Tool to invoke on this server. Use "help" to list available subcommands.',
						},
					},
					required: ["subcommand"],
					additionalProperties: true,
				},
			},
		});
	}
	return definitions;
}

export async function initMcp(appContext: AppContext): Promise<McpResult> {
	// 8. MCP connections — build a named Map so the agent loop can look up clients by server name
	appContext.logger.info("Initializing MCP servers...");
	const mcpClientsMap = new Map<string, MCPClient>();
	{
		const mcpResult = appContext.optionalConfig.mcp;
		if (mcpResult?.ok) {
			const mcpConfig = mcpResult.value as {
				servers: Array<{
					name: string;
					command?: string;
					args?: string[];
					url?: string;
					transport: "stdio" | "http";
					allow_tools?: string[];
					confirm?: string[];
				}>;
			};

			appContext.logger.info(`[mcp] Found ${mcpConfig.servers.length} server(s) in config`);

			for (const serverCfg of mcpConfig.servers) {
				try {
					const client = new MCPClient(serverCfg);
					await client.connect();
					mcpClientsMap.set(serverCfg.name, client);
					const tools = await client.listTools();
					appContext.logger.info(
						`[mcp] Connected to server: ${serverCfg.name} (${serverCfg.transport}), tools: ${tools.map((t) => t.name).join(", ") || "(none)"}`,
					);
				} catch (error) {
					appContext.logger.warn(`[mcp] Failed to connect to ${serverCfg.name}`, {
						error: formatError(error),
					});
				}
			}
		} else {
			appContext.logger.info("[mcp] No MCP servers configured");
		}
	}

	// Build confirm gates map from MCP config (R-U32)
	const confirmGates = new Map<string, string[]>();
	{
		const mcpResult = appContext.optionalConfig.mcp;
		if (mcpResult?.ok) {
			const mcpConfig = mcpResult.value as {
				servers: Array<{
					name: string;
					confirm?: string[];
				}>;
			};
			for (const serverCfg of mcpConfig.servers) {
				if (serverCfg.confirm && serverCfg.confirm.length > 0) {
					confirmGates.set(serverCfg.name, serverCfg.confirm);
				}
			}
		}
	}

	const { commands: mcpCommands, serverNames: mcpServerNames } = await generateMCPCommands(
		mcpClientsMap,
		confirmGates,
	);
	appContext.logger.info(`[mcp] Generated ${mcpCommands.length} MCP command definition(s)`);

	// Update hosts.mcp_tools with the connected server names so relay routing
	// and delegation affinity work correctly for this host.
	await updateHostMCPInfo(appContext.db, appContext.siteId, mcpClientsMap);

	// Build LLM ToolDefinitions — one per server, using subcommand dispatch schema.
	const mcpToolDefinitions = buildMcpToolDefinitions(mcpServerNames);
	if (mcpToolDefinitions.length > 0) {
		appContext.logger.info(
			`[mcp] Registered ${mcpToolDefinitions.length} server(s) for LLM: ${mcpToolDefinitions.map((t) => t.function.name).join(", ")}`,
		);
	}

	return { mcpClientsMap, mcpCommands, mcpServerNames, mcpToolDefinitions, confirmGates };
}
