/**
 * Agent loop factory: creates per-invocation AgentLoop instances with
 * isolated snapshot state and full sandbox/tool wiring.
 */

import { AgentLoop } from "@bound/agent";
import type { AgentLoopConfig } from "@bound/agent";
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

		const loopSandbox = {
			// Delegate exec to the underlying sandbox, wrapping the call in
			// loopContextStorage.run so that command handlers can access the
			// per-loop threadId and taskId via ctx.threadId / ctx.taskId.
			exec: sandbox
				? (cmd: string, opts?: Record<string, unknown>) =>
						loopContextStorage.run({ threadId: config.threadId, taskId: config.taskId }, () =>
							sandbox.bash.exec(cmd, opts),
						)
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
				preSnapshot = null;
				if (!result.ok) {
					return { changes: 0 };
				}
				return { changes: result.value.changes, changedPaths };
			},
		};

		const platformToolDefs = config.platformTools
			? Array.from(config.platformTools.values()).map((t) => t.toolDefinition)
			: [];
		// sandboxTool (bash) is always included first; config.tools adds extra tools beyond bash.
		// If config.tools includes bash, dedupe it.
		const extraTools = config.tools?.filter((t) => t.function.name !== "bash") ?? [];
		return new AgentLoop(appContext, loopSandbox, modelRouter, {
			...config,
			tools: [sandboxTool, ...extraTools, ...platformToolDefs],
		});
	};
}
