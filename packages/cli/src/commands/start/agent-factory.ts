/**
 * Agent loop factory: creates per-invocation AgentLoop instances with
 * isolated snapshot state and full sandbox/tool wiring.
 */

import { AgentLoop, createBuiltInTools } from "@bound/agent";
import type { AgentLoopConfig, RegisteredTool } from "@bound/agent";
import { isRelayRequest } from "@bound/agent";
import type { BuiltInTool } from "@bound/agent";
import type { AppContext } from "@bound/core";
import type { ModelRouter, ToolDefinition } from "@bound/llm";
import {
	type ClusterFsResult,
	diffWorkspace,
	loopContextStorage,
	persistWorkspaceChanges,
	snapshotWorkspace,
} from "@bound/sandbox";

/** The single bash tool definition shared by all agent loops. */
export const sandboxTool: ToolDefinition = {
	type: "function",
	function: {
		name: "bash",
		description:
			"Execute a command in the sandboxed shell. Built-in commands: query, memorize, forget, schedule, cancel, emit, purge, await, cache-warm, cache-pin, cache-unpin, cache-evict, model-hint, archive, hostinfo. MCP tools are also available as commands. Run standard shell commands too.",
		parameters: {
			type: "object",
			properties: {
				command: {
					type: "string",
					description: "The shell command to execute",
				},
			},
			required: ["command"],
		},
	},
};

export type AgentLoopFactory = (config: AgentLoopConfig) => AgentLoop;

/**
 * Create a unified tool registry from all tool sources.
 * Assembles platform tools, client tools, built-in file tools, and the sandbox bash tool
 * into a single Map keyed by tool name.
 *
 * Duplicate names are detected and logged as warnings; the first registration wins.
 */
export function createToolRegistry(
	builtInTools: Map<string, BuiltInTool> | undefined,
	platformTools: AgentLoopConfig["platformTools"],
	clientTools: AgentLoopConfig["clientTools"],
	logger: AppContext["logger"],
): Map<string, RegisteredTool> {
	const registry = new Map<string, RegisteredTool>();

	// Helper to register a tool and detect duplicates
	const registerTool = (name: string, tool: RegisteredTool): void => {
		if (registry.has(name)) {
			logger.warn(`[agent-factory] Duplicate tool registration: "${name}", keeping first`, {
				kind: tool.kind,
			});
			return;
		}
		registry.set(name, tool);
	};

	// 1. Register the sandbox (bash) tool first
	registerTool("bash", {
		kind: "sandbox",
		toolDefinition: sandboxTool,
	});

	// 2. Register platform tools
	if (platformTools) {
		for (const [name, tool] of platformTools.entries()) {
			registerTool(name, {
				kind: "platform",
				toolDefinition: tool.toolDefinition,
				execute: tool.execute,
			});
		}
	}

	// 3. Register client tools
	if (clientTools) {
		for (const [name, toolDef] of clientTools.entries()) {
			registerTool(name, {
				kind: "client",
				toolDefinition: toolDef,
			});
		}
	}

	// 4. Register built-in file tools
	if (builtInTools) {
		for (const [name, tool] of builtInTools.entries()) {
			registerTool(name, {
				kind: "builtin",
				toolDefinition: tool.toolDefinition,
				execute: tool.execute,
			});
		}
	}

	return registry;
}

export function createAgentLoopFactory(
	appContext: AppContext,
	modelRouter: ModelRouter,
	// biome-ignore lint/suspicious/noExplicitAny: sandbox type is opaque from @bound/sandbox createSandbox
	sandbox: any,
	clusterFsObj: ClusterFsResult | null,
): AgentLoopFactory {
	return (config: AgentLoopConfig): AgentLoop => {
		// Per-invocation snapshot state. Each call gets its own
		// closure so concurrent agent loops do not share preSnapshot.
		let preSnapshot: Map<string, string> | null = null;

		// Built-in file tools (read, write, edit) operating on the VFS.
		// Created from the same IFileSystem handle wrapped by wrapWithMemoryTracking,
		// so writes through these tools flow through memory tracking + FS_PERSIST.
		const builtInTools = clusterFsObj ? createBuiltInTools(clusterFsObj.fs) : undefined;

		const loopSandbox = {
			// Delegate exec to the underlying sandbox, wrapping the call in
			// loopContextStorage.run so that command handlers can access the
			// per-loop threadId and taskId via ctx.threadId / ctx.taskId.
			// The store object is checked after .run() returns: if a command
			// handler set store.relayRequest (remote MCP proxy commands do this),
			// return the relay request instead of the stripped just-bash result.
			// just-bash normalizes return values to {stdout, stderr, exitCode, env},
			// discarding extra fields like outboxEntryId that isRelayRequest() needs.
			exec: sandbox
				? async (cmd: string, opts?: Record<string, unknown>) => {
						const store = {
							threadId: config.threadId,
							taskId: config.taskId,
							relayRequest: undefined as unknown | undefined,
						};
						const result = await loopContextStorage.run(store, () => sandbox.bash.exec(cmd, opts));
						if (store.relayRequest && isRelayRequest(store.relayRequest)) {
							const req = store.relayRequest;
							store.relayRequest = undefined;
							return req;
						}
						return result;
					}
				: undefined,
			checkMemoryThreshold: sandbox ? () => sandbox.checkMemoryThreshold() : undefined,

			// Write a file to the VFS (used for tool result offloading).
			writeFile: clusterFsObj
				? async (path: string, content: string): Promise<void> => {
						await clusterFsObj.fs.writeFile(path, content);
					}
				: undefined,

			// Called at HYDRATE_FS: record the filesystem state before any tool calls.
			capturePreSnapshot: async (): Promise<void> => {
				if (!clusterFsObj) return;
				preSnapshot = await snapshotWorkspace(clusterFsObj.fs, {
					paths: clusterFsObj.getInMemoryPaths(),
				});
			},

			// Called at FS_PERSIST: diff pre vs post, persist changes, return count.
			persistFs: async (): Promise<{ changes: number; changedPaths?: string[] }> => {
				if (!clusterFsObj || !preSnapshot) {
					return { changes: 0 };
				}
				const postSnapshot = await snapshotWorkspace(clusterFsObj.fs, {
					paths: clusterFsObj.getInMemoryPaths(),
				});
				// Compute changedPaths synchronously for file-thread tracking.
				const changedPaths = diffWorkspace(preSnapshot, postSnapshot).map((c) => c.path);
				const result = await persistWorkspaceChanges(
					appContext.db,
					appContext.siteId,
					preSnapshot,
					postSnapshot,
					appContext.eventBus,
					undefined,
					clusterFsObj.fs,
				);
				preSnapshot = postSnapshot;
				if (!result.ok) {
					return { changes: 0 };
				}
				return { changes: result.value.changes, changedPaths };
			},

			builtInTools,
		};

		const builtInToolDefs = builtInTools
			? Array.from(builtInTools.values(), (t) => t.toolDefinition)
			: [];
		const platformToolDefs = config.platformTools
			? Array.from(config.platformTools.values()).map((t) => t.toolDefinition)
			: [];
		// sandboxTool (bash) is always included first; built-in file tools next;
		// then extra tools; then platform tools.
		// If config.tools includes bash, dedupe it.
		const extraTools = config.tools?.filter((t) => t.function.name !== "bash") ?? [];

		// Create the unified tool registry for registry-based dispatch
		const toolRegistry = createToolRegistry(
			builtInTools,
			config.platformTools,
			config.clientTools,
			appContext.logger,
		);

		return new AgentLoop(appContext, loopSandbox, modelRouter, {
			...config,
			tools: [sandboxTool, ...builtInToolDefs, ...extraTools, ...platformToolDefs],
			toolRegistry,
		});
	};
}
