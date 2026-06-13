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
import { randomUUID } from "node:crypto";

import { insertRow, updateRow, writeOutbox } from "@bound/core";
import type { CommandContext, CommandDefinition, CommandResult } from "@bound/sandbox";
import { loopContextStorage } from "@bound/sandbox";
import { formatError } from "@bound/shared";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";

import { coerceArgsFromSchema } from "./mcp-arg-coercion";
import type { MCPClient } from "./mcp-client";
import { type EligibleHost, createRelayOutboxEntry, findEligibleHosts } from "./relay-router";

/**
 * Cap a description string to maxLen characters, truncating with "…" if needed.
 */
function capDescription(s: string, maxLen = 80): string {
	return s.length <= maxLen ? s : `${s.slice(0, maxLen - 1)}…`;
}

const IMAGE_MIME_PREFIX = "image/";

/**
 * Format a single resource_link as a structured text annotation.
 *
 * MCP `resource_link` items point at a resource without inlining bytes, so
 * the model needs enough metadata to decide whether to dereference. The
 * `bash` shape `resource <uri> [--server <name>]` is intentionally
 * baked into the message — agents reading this should be able to copy
 * the command verbatim and run it.
 */
function formatResourceLink(link: {
	uri: string;
	name?: string;
	mimeType?: string;
	description?: string;
}): string {
	const parts = [`[Resource link: uri=${link.uri}`];
	if (link.name) parts.push(` name=${JSON.stringify(link.name)}`);
	if (link.mimeType) parts.push(` mimeType=${link.mimeType}`);
	if (link.description) parts.push(` description=${JSON.stringify(link.description)}`);
	parts.push("]");
	parts.push(`\nLoad with: resource ${JSON.stringify(link.uri)}`);
	return parts.join("");
}

/**
 * Persist a binary resource to the `files` table and return the inserted row's id.
 *
 * Used for MCP `resource` content with non-text payloads (PDFs, structured
 * binary blobs, etc.). The id flows back into a `file_ref` ContentBlock so
 * downstream context-assembly + the AI SDK bridge can resolve the bytes
 * lazily, mirroring the path used for user-uploaded files.
 *
 * Storage shape mirrors the existing inference-payload offload site
 * (agent-loop.ts): base64 in `content`, `is_binary=1`, host_origin = current
 * site, no `created_by` because MCP tool output isn't user-authored.
 */
function persistBinaryResource(
	db: Database,
	siteId: string,
	base64Data: string,
	uri?: string,
): string {
	const id = randomUUID();
	const now = new Date().toISOString();
	// Path is informational — we use a stable mcp-resource/ prefix plus the
	// id so the row is easy to identify in the files table without colliding
	// with user paths. URI hint goes in a comment-style suffix when present.
	const path = uri ? `mcp-resource/${id}#${uri.slice(0, 200)}` : `mcp-resource/${id}`;
	insertRow(
		db,
		"files",
		{
			id,
			path,
			content: base64Data,
			is_binary: 1,
			size_bytes: base64Data.length,
			created_at: now,
			modified_at: now,
			deleted: 0,
			// MCP tool output isn't user-authored, leave creator unset.
			created_by: null,
			host_origin: siteId,
		},
		siteId,
	);
	return id;
}

/**
 * Build the JSON ContentBlock[] payload for a tool that returned a mix of
 * text, images, binary documents, and resource links.
 *
 * The layout intentionally mirrors anthropic/openai mixed-content tool
 * results: text first, then media. Images use inline base64 image blocks
 * (small, hot path). Binary documents get persisted to the `files` table
 * and surface as `file_ref` document blocks so context-assembly can resolve
 * them on the next turn. Resource links are rendered as text annotations
 * naming the bash `resource` command — they are not pre-fetched.
 */
function buildToolResultContentBlocks(
	parts: {
		text?: string;
		images?: Array<{ media_type: string; data: string }>;
		documents?: Array<{ media_type: string; data: string; uri?: string }>;
		resourceLinks?: Array<{
			uri: string;
			name?: string;
			mimeType?: string;
			description?: string;
		}>;
	},
	db: Database,
	siteId: string,
): Array<Record<string, unknown>> {
	const blocks: Array<Record<string, unknown>> = [];
	const textChunks: string[] = [];

	if (parts.text) textChunks.push(parts.text);
	if (parts.resourceLinks) {
		for (const link of parts.resourceLinks) {
			textChunks.push(formatResourceLink(link));
		}
	}

	if (textChunks.length > 0) {
		blocks.push({ type: "text", text: textChunks.join("\n\n") });
	}

	if (parts.images) {
		for (const img of parts.images) {
			blocks.push({
				type: "image",
				source: { type: "base64", media_type: img.media_type, data: img.data },
			});
		}
	}

	if (parts.documents) {
		for (const doc of parts.documents) {
			const fileId = persistBinaryResource(db, siteId, doc.data, doc.uri);
			blocks.push({
				type: "document",
				source: { type: "file_ref", file_id: fileId, media_type: doc.media_type },
				...(doc.uri && { title: doc.uri }),
			});
		}
	}

	return blocks;
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
 * Format MCP help text from a tool list, identically regardless of caller.
 *
 * Shared by the local dispatch path (generateMCPCommands handler) and the relay
 * path (RelayProcessor answering a help request against a remote host's live
 * listTools), so `<server> --help` and `<server> <subcommand> --help` look the
 * same whether the server is local or reached over the relay. This is the
 * single source of truth for help rendering — neither path formats inline.
 *
 * @param serverName  Server/command name shown in usage lines.
 * @param tools       The server's advertised tools (from listTools or the dispatch table).
 * @param subcommand  When provided (and not "help"), render parameter-level help
 *                    for that one subcommand; otherwise render the server-level listing.
 */
export function formatMcpHelp(
	serverName: string,
	tools: Tool[],
	subcommand?: string,
): CommandResult {
	// Subcommand-level help: parameter detail for one tool.
	if (subcommand && subcommand !== "help") {
		const tool = tools.find((t) => t.name === subcommand);
		if (!tool) {
			const available = tools.map((t) => t.name).join(", ");
			return {
				stdout: "",
				stderr: `Unknown subcommand: ${subcommand}\nAvailable subcommands: ${available}\n`,
				exitCode: 1,
			};
		}
		const schema = tool.inputSchema as
			| { properties?: Record<string, unknown>; required?: string[] }
			| undefined;
		const props = schema?.properties ?? {};
		const required = new Set(schema?.required ?? []);
		let out = `${subcommand}`;
		if (tool.description) out += ` — ${tool.description}`;
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

	// Server-level help: enumerate every subcommand.
	let out = `${serverName} subcommands:\n\n`;
	for (const tool of tools) {
		const schema = tool.inputSchema as { required?: string[] } | undefined;
		const reqParams = schema?.required ?? [];
		out += `  ${tool.name}`;
		if (tool.description) out += ` — ${tool.description}`;
		if (reqParams.length > 0) out += ` (required: ${reqParams.join(", ")})`;
		out += "\n";
	}
	if (tools.length === 0) {
		out += "  (no subcommands available)\n";
	}
	out += `\nUsage: ${serverName} <subcommand> [--key value ...]\n`;
	out += `Run '${serverName} <subcommand> --help' for parameter details.\n`;
	return { stdout: out, stderr: "", exitCode: 0 };
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
			preserveRepeatedFlags: true,
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

				// Help requests — both subcommand-level (subcommand + --help) and
				// server-level (no subcommand, --help only, or subcommand="help").
				// "help" is a reserved keyword (the LLM ToolDefinition instructs the
				// model to send subcommand="help" for discovery), never dispatched to
				// the tool table. Rendered via the shared formatMcpHelp so this output
				// is byte-identical to the relay path's help (host-parity).
				if ((hasHelp && subcommand) || !subcommand || subcommand === "help") {
					const tools = Array.from(dispatchTable.values()).map((e) => e.tool);
					const helpTarget = hasHelp && subcommand ? subcommand : undefined;
					return formatMcpHelp(serverName, tools, helpTarget);
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

					// Convert mixed media to JSON ContentBlock[] so the agent loop
					// and context assembly can pass it through to the LLM. When the
					// result is text-only, keep the legacy plain-string contract so
					// nothing else has to parse unnecessarily.
					let stdout = result.content;
					const hasMedia =
						(result.images && result.images.length > 0) ||
						(result.documents && result.documents.length > 0) ||
						(result.resourceLinks && result.resourceLinks.length > 0);
					if (hasMedia) {
						const blocks = buildToolResultContentBlocks(
							{
								text: result.content,
								images: result.images,
								documents: result.documents,
								resourceLinks: result.resourceLinks,
							},
							ctx.db,
							ctx.siteId,
						);
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
						// Text resource: legacy plain-string contract. Trailing
						// newline preserved for shell-pipe friendliness.
						if (!content.isBinary) {
							return {
								stdout: `${content.content}\n`,
								stderr: "",
								exitCode: 0,
							};
						}
						// Binary resource: persist to the files table and emit a
						// JSON ContentBlock[] so the agent loop can route it
						// through context-assembly + the AI SDK bridge as a
						// proper file_ref (image when image-mime, document
						// otherwise). This matches the MCP-tool-result path so
						// the model sees the same shape regardless of how the
						// bytes were fetched.
						const mime = content.mimeType ?? "application/octet-stream";
						const blocks = mime.startsWith(IMAGE_MIME_PREFIX)
							? buildToolResultContentBlocks(
									{ images: [{ media_type: mime, data: content.content }] },
									ctx.db,
									ctx.siteId,
								)
							: buildToolResultContentBlocks(
									{
										documents: [{ media_type: mime, data: content.content, uri: content.uri }],
									},
									ctx.db,
									ctx.siteId,
								);
						return {
							stdout: JSON.stringify(blocks),
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
			preserveRepeatedFlags: true,
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

				// Route to eligible remote host. Help requests (no subcommand,
				// subcommand="help", or a --help flag) are relayed like any other
				// call so the remote host — where the server actually lives —
				// answers them from its live listTools via the shared formatMcpHelp.
				// That makes `<server> --help` and `<server> <sub> --help` look
				// byte-identical to the local dispatch path (host-parity). Only when
				// no host is reachable do we fall back to a static blurb so help is
				// still informative offline.
				const isHelpRequest = !subcommand || subcommand === "help" || args.help !== undefined;
				const routing = findEligibleHosts(ctx.db, serverName, ctx.siteId);
				if (!routing.ok) {
					if (isHelpRequest) {
						return {
							stdout: `${serverName} — remote MCP server (via relay)\n\nAvailable on:\n  (no reachable hosts)\n\nUsage: ${serverName} <subcommand> [--key value ...]\nCalls are forwarded to the remote host via relay.\n`,
							stderr: "",
							exitCode: 0,
						};
					}
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
	logger?: { warn: (msg: string) => void },
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

		// Full per-server capability inventory — the complete surface a server
		// exposes to agents (serverInfo from the initialize handshake, tools,
		// prompts, resources). Rendered by the web UI's Connections → MCP view.
		// Bounded so a single chatty server can't bloat the hosts row.
		const MAX_CAPABILITY_LIST = 200;
		const MAX_DESCRIPTION_CHARS = 500;
		const MAX_INSTRUCTIONS_CHARS = 2000;
		const truncate = (s: string, max: number): string => (s.length > max ? s.slice(0, max) : s);
		const mcp_capabilities: Record<
			string,
			{
				serverInfo?: {
					name?: string;
					title?: string;
					version?: string;
					description?: string;
					instructions?: string;
				};
				tools?: Array<{ name: string; description?: string }>;
				prompts?: Array<{ name: string; description?: string }>;
				resources?: Array<{ uri: string; name?: string; description?: string; mimeType?: string }>;
			}
		> = {};

		for (const [serverName, client] of clients) {
			if (!client.isConnected()) continue;
			mcp_tools.push(serverName);

			const capability: (typeof mcp_capabilities)[string] = {};

			// serverInfo getters can throw if a server's initialize state is
			// malformed — never let one server's bad handshake abort the whole
			// metadata update (which would leave every server's capabilities
			// stale and unwritten). Same best-effort posture as the list* calls.
			try {
				const info = client.getServerInfo?.();
				const description = client.getServerDescription?.();
				const instructions = client.getServerInstructions?.();
				const serverInfo: NonNullable<(typeof capability)["serverInfo"]> = {};
				if (info?.name) serverInfo.name = info.name;
				if (info?.title) serverInfo.title = info.title;
				if (info?.version) serverInfo.version = info.version;
				if (description) serverInfo.description = truncate(description, MAX_DESCRIPTION_CHARS);
				if (instructions) serverInfo.instructions = truncate(instructions, MAX_INSTRUCTIONS_CHARS);
				if (Object.keys(serverInfo).length > 0) capability.serverInfo = serverInfo;
			} catch {
				// serverInfo capture failed — leave it unset for this server.
			}

			// Best-effort listTools — never fail the metadata update on a
			// transient MCP error. A server with no captured annotations just
			// looks "unknown" to the retry policy, which falls back to the
			// strict no-info posture.
			try {
				const tools = await client.listTools();
				capability.tools = tools.slice(0, MAX_CAPABILITY_LIST).map((tool) => {
					// MCP Apps binding: a UI-bearing tool carries `_meta.ui.resourceUri`
					// pointing at a `ui://…;profile=mcp-app` resource. Preserve it so the
					// Connections page can show which tools render MCP Apps — name +
					// description alone would silently drop the binding.
					const uiResourceUri = (tool as { _meta?: { ui?: { resourceUri?: unknown } } })._meta?.ui
						?.resourceUri;
					return {
						name: tool.name,
						...(tool.description
							? { description: truncate(tool.description, MAX_DESCRIPTION_CHARS) }
							: {}),
						...(typeof uiResourceUri === "string" ? { uiResourceUri } : {}),
					};
				});
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

			// Prompts and resources are optional MCP capabilities — listing
			// throws when unsupported. Listing failed ≠ listed-and-empty: omit
			// the field on error so the UI can say "unavailable" vs "none".
			try {
				const prompts = await client.listPrompts();
				capability.prompts = prompts.slice(0, MAX_CAPABILITY_LIST).map((p) => ({
					name: p.name,
					...(p.description ? { description: truncate(p.description, MAX_DESCRIPTION_CHARS) } : {}),
				}));
			} catch {
				// prompts capability unsupported or listing failed
			}
			try {
				const resources = await client.listResources();
				capability.resources = resources.slice(0, MAX_CAPABILITY_LIST).map((r) => ({
					uri: r.uri,
					...(r.name ? { name: r.name } : {}),
					...(r.description ? { description: truncate(r.description, MAX_DESCRIPTION_CHARS) } : {}),
					...(r.mimeType ? { mimeType: r.mimeType } : {}),
				}));
			} catch {
				// resources capability unsupported or listing failed
			}

			mcp_capabilities[serverName] = capability;
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
				mcp_capabilities:
					Object.keys(mcp_capabilities).length > 0 ? JSON.stringify(mcp_capabilities) : null,
			},
			siteId,
		);
	} catch (err) {
		// Best-effort metadata update — don't let a failure here break startup.
		// But DON'T swallow silently: a thrown error here means no row was
		// written at all, leaving stale mcp_tools/annotations and null
		// mcp_capabilities, which is invisible without this log.
		logger?.warn(
			`updateHostMCPInfo failed; host MCP capability inventory not updated: ${
				err instanceof Error ? err.message : String(err)
			}`,
		);
	}
}
