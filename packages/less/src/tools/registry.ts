import { join } from "node:path";
import type { ToolDefinition } from "@bound/client";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import type { McpServerConfig } from "../config";
import type { McpServerManager } from "../mcp/manager";
import { proxyToolCall } from "../mcp/proxy";
import { createBashTool } from "./bash";
import { createCopyTool } from "./copy";
import { createEditTool } from "./edit";
import { createReadTool } from "./read";
import { type ResolvedShell, resolveShell } from "./shell";
import type { ToolHandler, ToolResult } from "./types";
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
	hostname: string,
	mcpTools?: Map<string, { tools: Tool[]; config: McpServerConfig }>,
	confirmFn?: (toolName: string) => Promise<boolean>,
	boundUrl?: string,
	shell?: ResolvedShell,
	mcpManager?: McpServerManager,
): BuildToolSetResult {
	const resolvedShell = shell ?? resolveShell(undefined);
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
				name: resolvedShell.toolName,
				description: `Execute a command via ${resolvedShell.label} with AbortSignal support`,
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
		{
			type: "function",
			function: {
				name: "boundless_copy",
				description:
					"Copy a file between the host filesystem (where boundless runs) and the bound runtime sandbox, without round-tripping bytes through the LLM context. Use this instead of read+write whenever you only need to move file contents from one filesystem to the other.",
				parameters: {
					type: "object",
					required: ["source", "source_path", "target", "target_path"],
					properties: {
						source: {
							type: "string",
							enum: ["host", "sandbox"],
							description: 'Source filesystem: "host" or "sandbox"',
						},
						source_path: {
							type: "string",
							description:
								"Path on the source filesystem. Host paths may be relative to the boundless cwd; sandbox paths must be absolute.",
						},
						target: {
							type: "string",
							enum: ["host", "sandbox"],
							description: 'Target filesystem: "host" or "sandbox"',
						},
						target_path: {
							type: "string",
							description:
								"Path on the target filesystem. Host paths may be relative to the boundless cwd; sandbox paths must be absolute. Parent directories are created on the host side.",
						},
					},
				},
			},
		},
	];

	toolDefinitions.push(...coreToolDefs);
	handlers.set("boundless_read", createReadTool(hostname));
	handlers.set("boundless_write", createWriteTool(hostname));
	handlers.set("boundless_edit", createEditTool(hostname));
	handlers.set(resolvedShell.toolName, createBashTool(hostname, resolvedShell));
	handlers.set(
		"boundless_copy",
		createCopyTool({
			hostname: hostname,
			boundUrl: boundUrl ?? "http://localhost:3001",
		}),
	);

	// Detect potential namespace collisions from underscore ambiguity
	// Example: server "a_b" with tool "c" -> "boundless_mcp_a_b_c"
	//          server "a" with tool "b_c"  -> "boundless_mcp_a_b_c" (collision!)
	function detectNamespaceCollision(
		mcpServersMap: Map<string, { tools: Tool[]; config: McpServerConfig }>,
	): {
		collision: boolean;
		servers: string[];
	} {
		const toolNamespacesToServers = new Map<string, string[]>();
		const collisionServers = new Set<string>();

		for (const [serverName, { tools }] of mcpServersMap) {
			for (const tool of tools) {
				const fullNamespace = `boundless_mcp_${serverName}_${tool.name}`;

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

		for (const [serverName, { tools, config }] of mcpTools) {
			// Skip servers that have collision issues
			if (collisionCheck.servers.includes(serverName)) {
				continue;
			}

			for (const tool of tools) {
				// Apply allowTools filtering (AC6.4)
				if (config.allowTools && !config.allowTools.includes(tool.name)) {
					continue;
				}

				const mcpToolName = `boundless_mcp_${serverName}_${tool.name}`;

				// Create a new tool definition with the namespaced name
				const mcpToolDef: ToolDefinition = {
					type: "function",
					function: {
						name: mcpToolName,
						description: tool.description ?? tool.name,
						parameters: tool.inputSchema as Record<string, unknown>,
					},
				};

				toolDefinitions.push(mcpToolDef);

				// Store reverse mapping for proxyToolCall lookup
				toolNameMapping.set(mcpToolName, {
					serverName,
					toolName: tool.name,
				});

				// Check if this tool requires confirmation (AC6.5)
				const requiresConfirmation = config.confirm?.includes(tool.name) ?? false;

				// MCP tools execute by proxying the call through the server
				// manager to the live MCP client. When no manager is wired (e.g.
				// a tool set built purely for definitions), fall back to a clear
				// error rather than silently dead-ending.
				const baseHandler: ToolHandler = async (
					args: Record<string, unknown>,
					signal: AbortSignal,
					_cwd: string,
				): Promise<ToolResult> => {
					if (!mcpManager) {
						return {
							content: [
								{
									type: "text",
									text: `MCP tool ${mcpToolName} not directly executable: no MCP server manager available`,
								},
							],
							isError: true,
						};
					}
					const blocks = await proxyToolCall(
						mcpManager,
						mcpToolName,
						args,
						signal,
						hostname,
						toolNameMapping,
					);
					return { content: blocks };
				};

				// Wrap with confirmation gate if needed (AC6.5)
				if (requiresConfirmation && confirmFn) {
					const handler: ToolHandler = async (
						args: Record<string, unknown>,
						signal: AbortSignal,
						cwd: string,
					): Promise<ToolResult> => {
						const confirmed = await confirmFn(mcpToolName);
						if (!confirmed) {
							return {
								content: [
									{
										type: "text",
										text: "Tool call declined by user",
									},
								],
								isError: true,
							};
						}
						return baseHandler(args, signal, cwd);
					};
					handlers.set(mcpToolName, handler);
				} else {
					handlers.set(mcpToolName, baseHandler);
				}
			}
		}
	}

	return {
		tools: toolDefinitions,
		handlers,
		toolNameMapping,
	};
}

/**
 * Collects git context (current branch + recent commits) from the given
 * working directory. Returns formatted context lines on success, or a
 * warning string if git is unavailable or the directory is not a repository.
 */
export async function collectGitContext(cwd: string): Promise<string> {
	try {
		const branchProc = Bun.spawn(["git", "-C", cwd, "branch", "--show-current"], {
			stdout: "pipe",
			stderr: "pipe",
		});
		const [branchOut, , branchExit] = await Promise.all([
			Bun.readableStreamToText(branchProc.stdout),
			Bun.readableStreamToText(branchProc.stderr),
			branchProc.exited,
		]);

		if (branchExit !== 0) {
			return "Git context: (not a git repository)";
		}

		const branch = branchOut.trim() || "(detached HEAD)";

		const logProc = Bun.spawn(["git", "-C", cwd, "log", "--oneline", "-10"], {
			stdout: "pipe",
			stderr: "pipe",
		});
		const [logOut, , logExit] = await Promise.all([
			Bun.readableStreamToText(logProc.stdout),
			Bun.readableStreamToText(logProc.stderr),
			logProc.exited,
		]);

		const commits = logExit === 0 && logOut.trim() ? logOut.trim() : "(no commits)";

		return `Git branch: ${branch}\nRecent commits:\n${commits}`;
	} catch {
		return "Git context: (git unavailable)";
	}
}

/**
 * The standard context files that boundless auto-injects when present in the
 * working directory. These are project-level instruction files for agents.
 */
const CONTEXT_FILE_CANDIDATES = ["README.md", "CONTRIBUTING.md", "AGENTS.md", "CLAUDE.md"] as const;

/**
 * Reads context files from the given working directory. Files that are absent
 * or unreadable are silently skipped. Returns a formatted block for all found
 * files, or an empty string if none are present.
 *
 * @param cwd - Working directory to search in
 * @param candidates - Files to look for. Defaults to CONTEXT_FILE_CANDIDATES.
 *   Pass a custom list (relative paths) to override the defaults.
 */
export async function collectContextFiles(cwd: string, candidates?: string[]): Promise<string> {
	const sections: string[] = [];

	for (const filename of candidates ?? CONTEXT_FILE_CANDIDATES) {
		const filepath = join(cwd, filename);
		try {
			const content = await Bun.file(filepath).text();
			if (content.trim()) {
				sections.push(`### ${filename}\n${content.trim()}`);
			}
		} catch {
			// File doesn't exist or can't be read — skip silently
		}
	}

	if (sections.length === 0) {
		return "";
	}

	return `Context files:\n\n${sections.join("\n\n")}`;
}

export async function buildSystemPromptAddition(
	cwd: string,
	hostname: string,
	mcpServers: string[],
	options?: { injectContextFiles?: string[]; shellToolName?: string },
): Promise<string> {
	const mcpNamespaces = mcpServers.map((s) => `boundless_mcp_${s}_*`).join(", ");
	const shellToolName = options?.shellToolName ?? "boundless_bash";
	const toolList = `boundless_read, boundless_write, boundless_edit, ${shellToolName}, boundless_copy${
		mcpNamespaces ? `, ${mcpNamespaces}` : ""
	}`;

	const gitContext = await collectGitContext(cwd);
	const contextFilesSection = await collectContextFiles(cwd, options?.injectContextFiles);
	const contextFilesBlock = contextFilesSection ? `${contextFilesSection}\n` : "";

	return `You are connected to a boundless terminal client.
Host: ${hostname}
Working directory: ${cwd}
${gitContext}
${contextFilesBlock}Available tool namespaces: ${toolList}

Tool results include provenance metadata showing which host and directory produced them.`;
}
