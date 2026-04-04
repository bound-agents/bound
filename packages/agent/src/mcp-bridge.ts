/**
 * MCP Bridge for auto-generating defineCommands from MCP tools.
 * Implements MCP tool discovery and command generation per spec §7.3.
 *
 * NOTE: URL filtering for outbound requests should be enforced at the tool handler level.
 * The sandbox's urlFilter (from createSandbox) should be checked before making any
 * outbound HTTP requests from MCP tools. This is currently the responsibility of
 * the caller (e.g., agent loop or MCP tool implementations).
 */

import type { Database } from "bun:sqlite";

import { updateRow } from "@bound/core";
import type { CommandContext, CommandDefinition, CommandResult } from "@bound/sandbox";
import { formatError } from "@bound/shared";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";

import type { MCPClient } from "./mcp-client";
import type { EligibleHost } from "./relay-router";

/**
 * Coerce string argument values to the types declared in an MCP tool's input schema.
 * The bash --key value parser produces strings for all values; MCP servers validate
 * against their JSON Schema and reject e.g. "10" when number is expected. This function
 * uses the schema's property types and enum values to convert args in place.
 */
function coerceArgsFromSchema(
	args: Record<string, unknown>,
	inputSchema: Tool["inputSchema"],
): Record<string, unknown> {
	if (!inputSchema || typeof inputSchema !== "object") return args;
	const schema = inputSchema as {
		properties?: Record<string, { type?: string; enum?: string[] }>;
	};
	const props = schema.properties;
	if (!props) return args;

	const coerced: Record<string, unknown> = { ...args };
	for (const [key, value] of Object.entries(coerced)) {
		if (typeof value !== "string") continue;
		const propSchema = props[key];
		if (!propSchema) continue;

		// Number coercion
		if (propSchema.type === "number" || propSchema.type === "integer") {
			const n = Number(value);
			if (!Number.isNaN(n)) coerced[key] = n;
			continue;
		}

		// Boolean coercion
		if (propSchema.type === "boolean") {
			if (value === "true") coerced[key] = true;
			else if (value === "false") coerced[key] = false;
			continue;
		}

		// Enum case normalization: find case-insensitive match
		if (propSchema.enum && propSchema.enum.length > 0) {
			const match = propSchema.enum.find((e) => e.toLowerCase() === value.toLowerCase());
			if (match) coerced[key] = match;
		}
	}
	return coerced;
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
 * Return type for generateMCPCommands.
 * Carries both the command definitions and a registry of server names
 * for use by help.ts and start.ts.
 */
export interface MCPCommandsResult {
	commands: CommandDefinition[];
	serverNames: Set<string>; // names of server-level MCP commands (excludes meta-commands)
}

/**
 * Generate defineCommands from MCP tools discovered on connected servers.
 * Returns one CommandDefinition per connected server with internal subcommand dispatch,
 * plus 4 meta-commands for resources and prompts.
 *
 * Calls listTools() on each connected client to enumerate tools.
 */
export async function generateMCPCommands(
	clients: Map<string, MCPClient>,
	confirmGates: Map<string, string[]> = new Map(),
): Promise<MCPCommandsResult> {
	const commands: CommandDefinition[] = [];
	const serverNames = new Set<string>();

	for (const [serverName, client] of clients) {
		if (!client.isConnected()) {
			continue;
		}

		const config = client.getConfig();
		const allowTools = config.allow_tools;

		let toolsList: Tool[] = [];
		try {
			toolsList = await client.listTools();
		} catch {
			continue;
		}

		const serverConfirms = confirmGates.get(serverName) ?? [];

		// Build dispatch table with allow_tools filtering applied
		type DispatchEntry = { tool: Tool; isConfirmed: boolean };
		const dispatchTable = new Map<string, DispatchEntry>();
		for (const tool of toolsList) {
			if (allowTools && !allowTools.includes(tool.name)) {
				continue;
			}
			dispatchTable.set(tool.name, {
				tool,
				isConfirmed: serverConfirms.includes(tool.name),
			});
		}

		const command: CommandDefinition = {
			name: serverName,
			args: [
				{
					name: "subcommand",
					required: false,
					description: "Subcommand to run, or omit for usage listing",
				},
			],
			handler: async (
				args: Record<string, string>,
				ctx: CommandContext,
			): Promise<CommandResult> => {
				const subcommand = args.subcommand;
				const hasHelp = args.help !== undefined;

				// Subcommand-level help: subcommand provided + help flag
				if (hasHelp && subcommand) {
					const entry = dispatchTable.get(subcommand);
					if (!entry) {
						const available = Array.from(dispatchTable.keys()).join(", ");
						return {
							stdout: "",
							stderr: `Unknown subcommand: ${subcommand}\nAvailable subcommands: ${available}\n`,
							exitCode: 1,
						};
					}
					const schema = entry.tool.inputSchema as
						| { properties?: Record<string, unknown>; required?: string[] }
						| undefined;
					const props = schema?.properties ?? {};
					const required = new Set(schema?.required ?? []);
					let out = `${subcommand}`;
					if (entry.tool.description) out += ` — ${entry.tool.description}`;
					out += "\n\nParameters:\n";
					for (const [param, def] of Object.entries(props)) {
						const propDef = def as { description?: string };
						const req = required.has(param) ? "(required)" : "(optional)";
						out += `  ${param} ${req}`;
						if (propDef.description) out += ` — ${propDef.description}`;
						out += "\n";
					}
					if (Object.keys(props).length === 0) {
						out += "  (no parameters)\n";
					}
					return { stdout: out, stderr: "", exitCode: 0 };
				}

				// Server-level help: no subcommand, --help only, or subcommand="help" (LLM convention).
				// The LLM ToolDefinition instructs the model to send subcommand="help" for discovery.
				// "help" is therefore a reserved keyword — not dispatched to the tool dispatch table.
				// Covers: no-args (AC2.3), --help only (AC2.1), and subcommand="help" (LLM path).
				if (!subcommand || subcommand === "help") {
					let out = `${serverName} subcommands:\n\n`;
					for (const [name, entry] of dispatchTable) {
						const schema = entry.tool.inputSchema as { required?: string[] } | undefined;
						const reqParams = schema?.required ?? [];
						out += `  ${name}`;
						if (entry.tool.description) out += ` — ${entry.tool.description}`;
						if (reqParams.length > 0) out += ` (required: ${reqParams.join(", ")})`;
						out += "\n";
					}
					if (dispatchTable.size === 0) {
						out += "  (no subcommands available)\n";
					}
					out += `\nUsage: ${serverName} <subcommand> [--key value ...]\n`;
					out += `Run '${serverName} <subcommand> --help' for parameter details.\n`;
					return { stdout: out, stderr: "", exitCode: 0 };
				}

				// Dispatch: subcommand provided, no help flag
				const entry = dispatchTable.get(subcommand);
				if (!entry) {
					const available = Array.from(dispatchTable.keys()).join(", ");
					return {
						stdout: "",
						stderr: `Unknown subcommand: ${subcommand}\nAvailable subcommands: ${available}\n`,
						exitCode: 1,
					};
				}

				// confirmGates check
				if (entry.isConfirmed && ctx.taskId && !ctx.taskId.startsWith("interactive-")) {
					return {
						stdout: "",
						stderr: `Subcommand ${subcommand} requires confirmation and cannot be used in autonomous mode\n`,
						exitCode: 1,
					};
				}

				try {
					// Pass all args except 'subcommand' to callTool, with type coercion.
					// Args arrive as strings from the bash --key value parser. MCP servers
					// validate against their input schema, so "10" when number is expected
					// or "true" when boolean is expected causes validation failures.
					// Coerce values using the tool's input schema before dispatch.
					const { subcommand: _, ...rawArgs } = args as Record<string, unknown>;
					const toolArgs = coerceArgsFromSchema(rawArgs, entry.tool.inputSchema);
					const result = await client.callTool(subcommand, toolArgs);
					return {
						stdout: result.content,
						stderr: result.isError ? result.content : "",
						exitCode: result.isError ? 1 : 0,
					};
				} catch (error) {
					const message = formatError(error);
					return {
						stdout: "",
						stderr: `Failed to call tool ${subcommand}: ${message}\n`,
						exitCode: 1,
					};
				}
			},
		};

		commands.push(command);
		serverNames.add(serverName);
	}

	// Meta-commands remain unchanged
	commands.push(createResourcesCommand(clients));
	commands.push(createResourceCommand(clients));
	commands.push(createPromptsCommand(clients));
	commands.push(createPromptCommand(clients));

	return { commands, serverNames };
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
 * Records the connected servers and their server names in the hosts table.
 * Under the new dispatch model, mcp_tools stores server names only (not individual tool names).
 */
export async function updateHostMCPInfo(
	db: Database,
	siteId: string,
	clients: Map<string, MCPClient>,
): Promise<void> {
	try {
		const mcp_servers = Array.from(clients.keys());

		// Store server names only — no listTools() call needed.
		// The relay router matches on server name (e.g. "github") rather than
		// individual tool names (e.g. "github-create_issue") under the new dispatch model.
		const mcp_tools: string[] = [];
		for (const [serverName, client] of clients) {
			if (client.isConnected()) {
				mcp_tools.push(serverName);
			}
		}

		updateRow(
			db,
			"hosts",
			siteId,
			{
				mcp_servers: JSON.stringify(mcp_servers),
				mcp_tools: JSON.stringify(mcp_tools),
			},
			siteId,
		);
	} catch {
		// Silently ignore DB errors — this is a best-effort metadata update
	}
}
