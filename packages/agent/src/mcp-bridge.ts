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

import { updateRow, writeOutbox } from "@bound/core";
import type { CommandContext, CommandDefinition, CommandResult } from "@bound/sandbox";
import { loopContextStorage } from "@bound/sandbox";
import { formatError } from "@bound/shared";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";

import type { MCPClient } from "./mcp-client";
import { type EligibleHost, createRelayOutboxEntry, findEligibleHosts } from "./relay-router";

/**
 * Cap a description string to maxLen characters, truncating with "…" if needed.
 */
function capDescription(s: string, maxLen = 80): string {
	return s.length <= maxLen ? s : `${s.slice(0, maxLen - 1)}…`;
}

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
	/**
	 * Idempotency annotations resolved from the target host's
	 * mcp_tool_annotations at dispatch time. Used by the agent retry policy
	 * — present only for relay-routed tools where the target attests the
	 * tool is read-only or idempotent. `{}` means "no info" (target hasn't
	 * synced annotations, or the tool isn't annotated).
	 */
	annotations?: { idempotent?: boolean; readOnly?: boolean };
	// CommandResult fields (required for handler return type compatibility)
	stdout: string;
	stderr: string;
	exitCode: number;
}

/**
 * Type guard to check if a command result is actually a relay request.
 */
export function isRelayRequest(result: unknown): result is RelayToolCallRequest {
	return result != null && typeof result === "object" && "outboxEntryId" in result;
}

/**
 * MCP-spec tool annotations as captured from `listTools()` and synced via
 * the hosts table. Hint fields use the wire-protocol names. The agent's
 * retry policy maps these onto its bare `idempotent`/`readOnly` flags.
 *
 * Returns `{}` for missing host, missing column, parse errors, missing
 * server, or missing tool — the retry path treats any of those the same
 * as "no info".
 */
export function getRemoteMcpToolAnnotations(
	db: Database,
	siteId: string,
	serverName: string,
	toolName: string,
): { idempotentHint?: boolean; readOnlyHint?: boolean; destructiveHint?: boolean } {
	let row: { mcp_tool_annotations: string | null } | null;
	try {
		row = db
			.query("SELECT mcp_tool_annotations FROM hosts WHERE site_id = ? AND deleted = 0")
			.get(siteId) as { mcp_tool_annotations: string | null } | null;
	} catch {
		return {};
	}
	if (!row?.mcp_tool_annotations) return {};
	let parsed: Record<string, Record<string, Record<string, boolean>>>;
	try {
		parsed = JSON.parse(row.mcp_tool_annotations);
	} catch {
		return {};
	}
	const serverMap = parsed?.[serverName];
	if (!serverMap || typeof serverMap !== "object") return {};
	const toolMap = serverMap[toolName];
	if (!toolMap || typeof toolMap !== "object") return {};
	return toolMap as { idempotentHint?: boolean; readOnlyHint?: boolean; destructiveHint?: boolean };
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
		} catch (_error) {
			// Failed to list tools from MCP server during startup — skip this server
			// No logger available in this context, silently continue
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

		// Description sourcing: serverInfo.description -> instructions (first sentence) -> synthesized
		let serverDescription: string;
		const specDescription = client.getServerDescription();
		if (specDescription) {
			serverDescription = capDescription(specDescription);
		} else {
			const instructions = client.getServerInstructions();
			if (instructions) {
				// Take first sentence: up to first period+space, period+end, or newline
				const firstSentence = instructions.split(/(?<=\.)\s|\n/)[0] ?? instructions;
				serverDescription = capDescription(firstSentence);
			} else {
				// Synthesized fallback from tool names
				const toolNames = [...dispatchTable.keys()];
				const synthesized = `MCP server exposing ${toolNames.length} tools: ${toolNames.join(", ")}`;
				serverDescription = capDescription(synthesized);
			}
		}

		const command: CommandDefinition = {
			name: serverName,
			description: serverDescription,
			customHelp: true,
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
				// Dynamic client lookup: resolve client from the shared map at dispatch
				// time so that hot-reloaded clients are used without re-registering commands.
				const currentClient = clients.get(serverName);
				if (!currentClient || !currentClient.isConnected()) {
					return {
						stdout: "",
						stderr: `Server "${serverName}" is not connected. It may have been removed or failed to reconnect.\n`,
						exitCode: 1,
					};
				}

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
					const result = await currentClient.callTool(subcommand, toolArgs);

					// When images are present, serialize as JSON ContentBlock[] so
					// the agent loop and context assembly can pass them through to the LLM.
					let stdout = result.content;
					if (result.images && result.images.length > 0) {
						const blocks: Array<Record<string, unknown>> = [];
						if (result.content) {
							blocks.push({ type: "text", text: result.content });
						}
						for (const img of result.images) {
							blocks.push({
								type: "image",
								source: {
									type: "base64",
									media_type: img.media_type,
									data: img.data,
								},
							});
						}
						stdout = JSON.stringify(blocks);
					}

					return {
						stdout,
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
		description: "List all resources across MCP servers",
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
		description: "Read a specific resource by URI",
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
		description: "List all prompts across MCP servers",
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
		description: "Invoke a specific prompt by name",
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
 * Result type for generateRemoteMCPProxyCommands.
 */
export interface RemoteMCPCommandsResult {
	commands: CommandDefinition[];
	remoteServerNames: Set<string>;
}

/**
 * Generate proxy CommandDefinition entries for MCP servers available on remote hosts
 * but not locally. When the LLM invokes one of these commands, the handler writes a
 * `tool_call` relay outbox entry and returns a RelayToolCallRequest, causing the agent
 * loop to enter RELAY_WAIT until the remote host responds.
 *
 * @param db Database handle for querying hosts table
 * @param siteId This host's site ID (excluded from eligible hosts)
 * @param localServerNames Server names already registered locally (skipped)
 */
export function generateRemoteMCPProxyCommands(
	db: Database,
	siteId: string,
	localServerNames: Set<string>,
): RemoteMCPCommandsResult {
	const commands: CommandDefinition[] = [];
	const remoteServerNames = new Set<string>();

	// Discover remote MCP server names from the hosts table
	const remoteServers = new Map<string, { hostName: string; siteId: string }>();
	try {
		const rows = db
			.prepare(
				"SELECT site_id, host_name, mcp_tools FROM hosts WHERE deleted = 0 AND mcp_tools IS NOT NULL AND site_id != ?",
			)
			.all(siteId) as Array<{ site_id: string; host_name: string; mcp_tools: string }>;

		for (const row of rows) {
			try {
				const serverNames = JSON.parse(row.mcp_tools) as string[];
				for (const serverName of serverNames) {
					if (!localServerNames.has(serverName) && !remoteServers.has(serverName)) {
						remoteServers.set(serverName, {
							hostName: row.host_name,
							siteId: row.site_id,
						});
					}
				}
			} catch {
				// Skip unparseable hosts
			}
		}
	} catch {
		// hosts table may not exist yet — return empty
		return { commands, remoteServerNames };
	}

	// Create a proxy command for each remote server
	for (const [serverName, hostInfo] of remoteServers) {
		remoteServerNames.add(serverName);

		const command: CommandDefinition = {
			name: serverName,
			description: capDescription(`Remote MCP server on ${hostInfo.hostName}`),
			customHelp: true,
			args: [
				{
					name: "subcommand",
					required: false,
					description: "Subcommand to run on the remote MCP server",
				},
			],
			handler: async (
				args: Record<string, string>,
				ctx: CommandContext,
			): Promise<CommandResult> => {
				const subcommand = args.subcommand;

				// Help: show that this is a remote server
				if (!subcommand || subcommand === "help") {
					// Dynamically check which host(s) have this server
					const routing = findEligibleHosts(ctx.db, serverName, ctx.siteId);
					const hostList = routing.ok
						? routing.hosts.map((h) => `  ${h.host_name} (${h.site_id.slice(0, 8)}…)`).join("\n")
						: "  (no reachable hosts)";
					return {
						stdout: `${serverName} — remote MCP server (via relay)\n\nAvailable on:\n${hostList}\n\nUsage: ${serverName} <subcommand> [--key value ...]\nCalls are forwarded to the remote host via relay.\n`,
						stderr: "",
						exitCode: 0,
					};
				}

				// Route to eligible remote host
				const routing = findEligibleHosts(ctx.db, serverName, ctx.siteId);
				if (!routing.ok) {
					return {
						stdout: "",
						stderr: `No remote host with server "${serverName}" is reachable: ${routing.error}\n`,
						exitCode: 1,
					};
				}

				const eligibleHosts = routing.hosts;
				const targetHost = eligibleHosts[0];

				// Build relay payload — matches ToolCallPayload consumed by RelayProcessor.executeToolCall
				const payload = JSON.stringify({
					tool: serverName,
					args: args as Record<string, unknown>,
					timeout_ms: 30_000,
				});

				const outboxEntry = createRelayOutboxEntry(
					targetHost.site_id,
					ctx.siteId,
					"tool_call",
					payload,
					30_000, // 30s timeout
				);
				writeOutbox(ctx.db, outboxEntry);

				// Resolve target host's annotations for the dispatched subcommand
				// so the agent retry policy can consult them. Maps MCP-spec wire
				// names (idempotentHint/readOnlyHint) onto the agent's bare
				// fields. Returns `{}` for missing column, missing server, or
				// missing tool — retry treats that as "no info".
				const annotations: { idempotent?: boolean; readOnly?: boolean } = {};
				if (typeof subcommand === "string") {
					const hints = getRemoteMcpToolAnnotations(
						ctx.db,
						targetHost.site_id,
						serverName,
						subcommand,
					);
					if (hints.idempotentHint !== undefined) annotations.idempotent = hints.idempotentHint;
					if (hints.readOnlyHint !== undefined) annotations.readOnly = hints.readOnlyHint;
				}

				// Build RelayToolCallRequest. just-bash normalizes custom command
				// return values to { stdout, stderr, exitCode, env }, stripping
				// extra fields like outboxEntryId. Store the full request in
				// loopContextStorage so the agent loop can retrieve it after
				// sandbox.exec returns.
				const result: RelayToolCallRequest = {
					outboxEntryId: outboxEntry.id,
					targetSiteId: targetHost.site_id,
					targetHostName: targetHost.host_name,
					toolName: serverName,
					eligibleHosts,
					currentHostIndex: 0,
					annotations,
					stdout: "",
					stderr: "",
					exitCode: 0,
				};
				const store = loopContextStorage.getStore();
				if (store) {
					store.relayRequest = result;
				}
				return result;
			},
		};

		commands.push(command);
	}

	return { commands, remoteServerNames };
}

/**
 * Update host's MCP info in database.
 * Records the connected servers and their server names in the hosts table,
 * along with per-tool MCP-spec annotations captured from listTools().
 *
 * `mcp_tools`: server names only (the relay router matches on server name
 * under the new dispatch model).
 * `mcp_tool_annotations`: nested {serverName: {toolName: ToolAnnotations}}
 * — used by the agent retry policy to look up target idempotency for
 * relay-routed tool calls. Empty annotation objects are dropped to keep
 * the JSON compact.
 */
export async function updateHostMCPInfo(
	db: Database,
	siteId: string,
	clients: Map<string, MCPClient>,
): Promise<void> {
	try {
		const mcp_servers = Array.from(clients.keys());

		const mcp_tools: string[] = [];
		const mcp_tool_annotations: Record<
			string,
			Record<
				string,
				{ idempotentHint?: boolean; readOnlyHint?: boolean; destructiveHint?: boolean }
			>
		> = {};

		for (const [serverName, client] of clients) {
			if (!client.isConnected()) continue;
			mcp_tools.push(serverName);

			// Best-effort listTools — never fail the metadata update on a
			// transient MCP error. A server with no captured annotations just
			// looks "unknown" to the retry policy, which falls back to the
			// strict no-info posture.
			try {
				const tools = await client.listTools();
				const serverAnnotations: Record<string, Record<string, boolean | undefined>> = {};
				for (const tool of tools) {
					const ann = tool.annotations as
						| {
								idempotentHint?: boolean;
								readOnlyHint?: boolean;
								destructiveHint?: boolean;
						  }
						| undefined;
					if (!ann) continue;
					const compact: Record<string, boolean | undefined> = {};
					if (ann.idempotentHint !== undefined) compact.idempotentHint = ann.idempotentHint;
					if (ann.readOnlyHint !== undefined) compact.readOnlyHint = ann.readOnlyHint;
					if (ann.destructiveHint !== undefined) compact.destructiveHint = ann.destructiveHint;
					if (Object.keys(compact).length > 0) {
						serverAnnotations[tool.name] = compact;
					}
				}
				if (Object.keys(serverAnnotations).length > 0) {
					mcp_tool_annotations[serverName] = serverAnnotations;
				}
			} catch {
				// listTools failed for this server — leave annotations empty.
			}
		}

		updateRow(
			db,
			"hosts",
			siteId,
			{
				mcp_servers: JSON.stringify(mcp_servers),
				mcp_tools: JSON.stringify(mcp_tools),
				mcp_tool_annotations:
					Object.keys(mcp_tool_annotations).length > 0
						? JSON.stringify(mcp_tool_annotations)
						: null,
			},
			siteId,
		);
	} catch {
		// Silently ignore DB errors — this is a best-effort metadata update
	}
}
