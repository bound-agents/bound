/**
 * MCP subsystem: client connections, command generation, and tool definitions.
 */

import {
	MCPClient,
	generateMCPCommands,
	generateRemoteMCPProxyCommands,
	getAllCommands,
	setCommandRegistry,
	updateHostMCPInfo,
} from "@bound/agent";
import type { AppContext } from "@bound/core";
import type { ToolDefinition } from "@bound/llm";
import { type CommandContext, type CommandDefinition, createDefineCommands } from "@bound/sandbox";
import { type McpConfig, formatError } from "@bound/shared";

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

/**
 * Result of diffing two MCP configurations.
 */
export interface McpServerDiff {
	added: McpConfig["servers"];
	removed: McpConfig["servers"];
	changed: McpConfig["servers"]; // new config for servers whose config changed
}

/**
 * Compare two MCP configs and return which servers were added, removed, or changed.
 * Servers are matched by name; any config field difference counts as "changed".
 */
export function diffMcpConfigs(oldConfig: McpConfig, newConfig: McpConfig): McpServerDiff {
	const oldByName = new Map(oldConfig.servers.map((s) => [s.name, s]));
	const newByName = new Map(newConfig.servers.map((s) => [s.name, s]));

	const added: McpConfig["servers"] = [];
	const removed: McpConfig["servers"] = [];
	const changed: McpConfig["servers"] = [];

	// Find added and changed
	for (const [name, newServer] of newByName) {
		const oldServer = oldByName.get(name);
		if (!oldServer) {
			added.push(newServer);
		} else if (JSON.stringify(oldServer) !== JSON.stringify(newServer)) {
			changed.push(newServer);
		}
	}

	// Find removed
	for (const [name, oldServer] of oldByName) {
		if (!newByName.has(name)) {
			removed.push(oldServer);
		}
	}

	return { added, removed, changed };
}

/**
 * Configuration for MCP hot-reload.
 */
export interface McpReloadConfig {
	appContext: AppContext;
	/** The shared mutable client map — mutated in place. */
	mcpClientsMap: Map<string, MCPClient>;
	/** The current server names set — mutated in place. */
	mcpServerNames: Set<string>;
	/** Confirm gates map — mutated in place. */
	confirmGates: Map<string, string[]>;
	/** The sandbox instance (for bash.registerCommand). */
	// biome-ignore lint/suspicious/noExplicitAny: sandbox type is opaque from createSandbox
	sandbox: any;
	/** Command context for createDefineCommands. */
	commandContext: CommandContext;
	/** Previous MCP config for diffing. */
	oldConfig: McpConfig;
	/** New MCP config to apply. */
	newConfig: McpConfig;
}

/**
 * Result of an MCP reload operation.
 */
export interface McpReloadResult {
	added: string[];
	removed: string[];
	changed: string[];
	failed: string[];
}

/**
 * Hot-reload MCP servers after a config change.
 *
 * Diffs old vs new config, then:
 * - Disconnects removed and changed servers
 * - Connects new and changed servers
 * - Re-registers bash commands for new/changed servers
 * - Updates setCommandRegistry (help system)
 * - Updates hosts.mcp_tools for relay routing
 *
 * The mcpClientsMap, mcpServerNames, and confirmGates are mutated in place
 * since they are shared references used by the rest of the system.
 */
export async function reloadMcpServers(config: McpReloadConfig): Promise<McpReloadResult> {
	const {
		appContext,
		mcpClientsMap,
		mcpServerNames,
		confirmGates,
		sandbox,
		commandContext,
		oldConfig,
		newConfig,
	} = config;
	const logger = appContext.logger;

	const diff = diffMcpConfigs(oldConfig, newConfig);
	const result: McpReloadResult = { added: [], removed: [], changed: [], failed: [] };

	if (diff.added.length === 0 && diff.removed.length === 0 && diff.changed.length === 0) {
		logger.info("[mcp-reload] No MCP server changes detected");
		return result;
	}

	logger.info("[mcp-reload] Reloading MCP servers", {
		added: diff.added.map((s) => s.name),
		removed: diff.removed.map((s) => s.name),
		changed: diff.changed.map((s) => s.name),
	});

	// Phase 1: Disconnect removed and changed servers
	for (const serverCfg of [...diff.removed, ...diff.changed]) {
		const client = mcpClientsMap.get(serverCfg.name);
		if (client) {
			try {
				await client.disconnect();
			} catch (error) {
				logger.warn(`[mcp-reload] Error disconnecting ${serverCfg.name}`, {
					error: formatError(error),
				});
			}
			mcpClientsMap.delete(serverCfg.name);
			mcpServerNames.delete(serverCfg.name);
			confirmGates.delete(serverCfg.name);
		}
		if (diff.removed.includes(serverCfg)) {
			result.removed.push(serverCfg.name);
		}
	}

	// Phase 2: Connect new and changed servers
	for (const serverCfg of [...diff.added, ...diff.changed]) {
		try {
			const client = new MCPClient(serverCfg);
			await client.connect();
			mcpClientsMap.set(serverCfg.name, client);
			mcpServerNames.add(serverCfg.name);

			const tools = await client.listTools();
			logger.info(
				`[mcp-reload] Connected to server: ${serverCfg.name} (${serverCfg.transport}), tools: ${tools.map((t) => t.name).join(", ") || "(none)"}`,
			);

			// Update confirm gates
			if (serverCfg.confirm && serverCfg.confirm.length > 0) {
				confirmGates.set(serverCfg.name, serverCfg.confirm);
			}

			if (diff.added.includes(serverCfg)) {
				result.added.push(serverCfg.name);
			} else {
				result.changed.push(serverCfg.name);
			}
		} catch (error) {
			logger.warn(`[mcp-reload] Failed to connect to ${serverCfg.name}`, {
				error: formatError(error),
			});
			result.failed.push(serverCfg.name);
		}
	}

	// Phase 3: Regenerate commands for new/changed servers and register in bash
	if (result.added.length > 0 || result.changed.length > 0) {
		// Generate commands from the full client map (includes all servers)
		const { commands: mcpCommands } = await generateMCPCommands(mcpClientsMap, confirmGates);

		// Register each command in bash — registerCommand replaces by name
		if (sandbox?.bash) {
			const registeredCommands = createDefineCommands(mcpCommands, commandContext);
			for (const cmd of registeredCommands) {
				sandbox.bash.registerCommand(cmd);
			}
		}

		// Rebuild command registry for help system
		const builtinCommands = getAllCommands();
		const { commands: remoteMcpCommands, remoteServerNames } = generateRemoteMCPProxyCommands(
			appContext.db,
			appContext.siteId,
			mcpServerNames,
		);
		const allDefinitions = [...builtinCommands, ...mcpCommands, ...remoteMcpCommands];
		setCommandRegistry(allDefinitions, mcpServerNames, remoteServerNames);
	}

	// Phase 4: Update hosts table
	await updateHostMCPInfo(appContext.db, appContext.siteId, mcpClientsMap);

	logger.info("[mcp-reload] MCP reload complete", {
		added: result.added,
		removed: result.removed,
		changed: result.changed,
		failed: result.failed,
		totalConnected: mcpClientsMap.size,
	});

	return result;
}
