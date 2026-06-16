import type { Implementation } from "@agentclientprotocol/sdk";
import type { ToolDefinition } from "@bound/client";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import type { McpServerConfig } from "../config";
import type { McpServerManager } from "../mcp/manager";
import { proxyToolCall } from "../mcp/proxy";
import { type BashEventLogger, createBashTool } from "./bash";
import { CONTEXT_FILE_CANDIDATES, collectContextFiles } from "./context-files";
import { createCopyTool } from "./copy";
import { createEditTool } from "./edit";
import { createReadTool } from "./read";
import type { ResolvedSandboxConfig } from "./sandbox";
import { createSearchTool } from "./search";
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
	sandbox?: ResolvedSandboxConfig,
	logger?: BashEventLogger,
	contextFiles?: readonly string[],
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
				description: `Execute a command via ${resolvedShell.label} with AbortSignal support. Commands already run in the working directory shown in your context — do not prefix them with a \`cd\` into that same directory.`,
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
		{
			type: "function",
			function: {
				name: "boundless_search",
				description:
					"Search file contents under the working directory for a regex pattern. Returns grep-style path:line:preview matches with a result cap and bounded previews (long lines are windowed around the match), so it stays safe on large or minified files. Skips vendor/vcs dirs (node_modules, .git, dist, …) and binary files. Prefer this over piping grep through the shell — it returns identical results on host and sandbox.",
				parameters: {
					type: "object",
					required: ["pattern"],
					properties: {
						pattern: {
							type: "string",
							description:
								"Pattern to search for. Interpreted as a JavaScript regular expression unless fixed_strings is set.",
						},
						path: {
							type: "string",
							description:
								"Optional subdirectory to scope the search to (relative to cwd if not absolute). Defaults to the whole working directory.",
						},
						case_insensitive: {
							type: "boolean",
							description: "Match case-insensitively (default false).",
						},
						fixed_strings: {
							type: "boolean",
							description:
								"Treat the pattern as a literal string rather than a regex (default false).",
						},
					},
				},
			},
		},
	];

	toolDefinitions.push(...coreToolDefs);
	handlers.set("boundless_read", createReadTool(hostname));
	handlers.set(
		"boundless_write",
		createWriteTool(hostname, sandbox, contextFiles ?? CONTEXT_FILE_CANDIDATES),
	);
	handlers.set(
		"boundless_edit",
		createEditTool(hostname, sandbox, contextFiles ?? CONTEXT_FILE_CANDIDATES),
	);
	handlers.set("boundless_search", createSearchTool(hostname));
	handlers.set(resolvedShell.toolName, createBashTool(hostname, resolvedShell, sandbox, logger));
	handlers.set(
		"boundless_copy",
		createCopyTool({
			hostname: hostname,
			boundUrl: boundUrl ?? "http://localhost:3001",
			sandbox: sandbox,
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
/**
 * Explains, in the system prompt, why the injected git context does not change
 * when the agent commits mid-session. Like the context-file copies, this block
 * is captured once at session start and held frozen for prompt-cache stability;
 * the `head` attribute is the freshness key (analogous to a context-file mtime),
 * so a model can compare it against `git rev-parse HEAD` to see the staleness
 * directly rather than re-running `git log` to "confirm" a commit landed (#172).
 */
const GIT_CONTEXT_STALENESS_NOTE =
	"This git context (branch, HEAD, recent commits) was read when the session started and is held FROZEN for prompt-cache stability — it is NOT refreshed when you commit, branch, or pull during this session, so the head attribute and commit list below will NOT reflect commits you make now. After you commit, trust the commit command's own output; do not re-run git log or git rev-parse just to confirm a commit landed.";

export async function collectGitContext(cwd: string): Promise<string> {
	// Strip repository-location env vars so `git -C <cwd>` discovers the repo by
	// walking up from cwd rather than honoring an inherited GIT_DIR. Without this,
	// when collectGitContext runs inside a git hook (e.g. the pre-commit suite),
	// the hook's GIT_DIR / GIT_INDEX_FILE leak into the spawned git and override
	// `-C`, so a probe against an unrelated directory wrongly resolves to the
	// hook's repository. Forcing cwd-based discovery makes the reported context
	// match the working directory regardless of ambient git environment.
	const gitEnv = { ...process.env };
	for (const key of [
		"GIT_DIR",
		"GIT_WORK_TREE",
		"GIT_INDEX_FILE",
		"GIT_COMMON_DIR",
		"GIT_OBJECT_DIRECTORY",
		"GIT_NAMESPACE",
		"GIT_PREFIX",
	]) {
		delete gitEnv[key];
	}
	try {
		const branchProc = Bun.spawn(["git", "-C", cwd, "branch", "--show-current"], {
			stdout: "pipe",
			stderr: "pipe",
			env: gitEnv,
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
			env: gitEnv,
		});
		const [logOut, , logExit] = await Promise.all([
			Bun.readableStreamToText(logProc.stdout),
			Bun.readableStreamToText(logProc.stderr),
			logProc.exited,
		]);

		const hasCommits = logExit === 0 && logOut.trim().length > 0;
		const commits = hasCommits ? logOut.trim() : "(no commits)";
		// HEAD short SHA = first token of the first --oneline entry. This is the
		// freshness key; "none" when the repo has no commits yet.
		const head = hasCommits ? (logOut.trim().split("\n")[0]?.split(" ")[0] ?? "unknown") : "none";

		const body = `Git branch: ${branch}\nRecent commits:\n${commits}`;
		return `<git-context head="${head}" note="${GIT_CONTEXT_STALENESS_NOTE}">\n${body}\n</git-context>`;
	} catch {
		return "Git context: (git unavailable)";
	}
}

/**
 * The standard context files that boundless auto-injects when present in the
 * working directory, and the reader that wraps them for the system prompt, live
 * in ./context-files (shared with the write/edit tools' steering note, which
 * registry.ts cannot import from without a cycle). Re-exported here so callers
 * and tests that reach for them via registry keep resolving.
 */
export { CONTEXT_FILE_CANDIDATES, collectContextFiles };

export async function buildSystemPromptAddition(
	cwd: string,
	hostname: string,
	mcpServers: string[],
	options?: {
		injectContextFiles?: string[];
		shellToolName?: string;
		surface?: { type: "terminal" } | { type: "acp"; clientInfo: Implementation };
	},
): Promise<string> {
	const mcpNamespaces = mcpServers.map((s) => `boundless_mcp_${s}_*`).join(", ");
	const shellToolName = options?.shellToolName ?? "boundless_bash";
	const toolList = `boundless_read, boundless_write, boundless_edit, ${shellToolName}, boundless_copy, boundless_search${
		mcpNamespaces ? `, ${mcpNamespaces}` : ""
	}`;

	const gitContext = await collectGitContext(cwd);
	const contextFilesSection = await collectContextFiles(cwd, options?.injectContextFiles);
	const contextFilesBlock = contextFilesSection ? `${contextFilesSection}\n` : "";

	// The opening line tells the agent which surface is driving it. Over ACP the
	// editor renders reads/edits inline (diffs + a follow-along cursor) and gates
	// tool calls through its own permission modes — behavior the agent should
	// account for, e.g. it need not echo file contents back to describe an edit.
	const surfaceLine =
		options?.surface?.type === "acp"
			? `You are connected to a boundless session driving an ACP-compatible editor (${options.surface.clientInfo.title ?? options.surface.clientInfo.name} ${options.surface.clientInfo.version}). The editor renders your file reads and edits inline as diffs and follows its cursor to the locations you touch, so you do not need to echo file contents back to describe a change. Tool calls may be gated through the editor's permission modes (ask before each call, auto-accept edits, or bypass).`
			: "You are connected to a boundless terminal client.";

	return `${surfaceLine}
Host: ${hostname}
Working directory: ${cwd}
${gitContext}
${contextFilesBlock}Available tool namespaces: ${toolList}

Tool results include provenance metadata showing which host and directory produced them.`;
}
