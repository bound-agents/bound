/**
 * Agent loop factory: creates per-invocation MainAgentLoop instances with
 * isolated snapshot state and full sandbox/tool wiring.
 */

import {
	AuxAgentLoop,
	ConcurrentCap,
	MainAgentLoop,
	createAgentTools,
	createBuiltInTools,
} from "@bound/agent";
import type { AgentLoopConfig, RegisteredTool, ToolContext } from "@bound/agent";
import { isRelayRequest } from "@bound/agent";
import type { BuiltInTool } from "@bound/agent";
import type { AppContext } from "@bound/core";
import type { ModelRouter, ToolDefinition } from "@bound/llm";
import type { PlatformRegisteredTool } from "@bound/platforms";
import {
	type ClusterFsResult,
	createVfsRehydrator,
	diffWorkspace,
	loopContextStorage,
	persistWorkspaceChanges,
	snapshotWorkspace,
} from "@bound/sandbox";

/** The single bash tool definition shared by all agent loops. */
export const sandboxTool: ToolDefinition = {
	type: "function",
	function: {
		name: "bms_bash",
		description:
			"Execute a command in the sandboxed shell. MCP tools are available as commands. Run standard shell commands too. Every command starts in /home/user; to run in a different directory pass the `cwd` parameter instead of prefixing the command with a `cd` (an inline `cd` only lasts for that one command).",
		parameters: {
			type: "object",
			properties: {
				command: {
					type: "string",
					description: "The shell command to execute",
				},
				timeout: {
					type: "number",
					description: "Timeout in milliseconds (default 300000)",
				},
				cwd: {
					type: "string",
					description:
						"Working directory for this command, restored afterward (defaults to /home/user). Relative paths resolve against the current directory. Use this instead of a leading `cd`.",
				},
			},
			required: ["command"],
		},
	},
};

export type AgentLoopFactory = (config: AgentLoopConfig) => MainAgentLoop;

/**
 * Create a unified tool registry from all tool sources.
 * Assembles platform tools, client tools, agent tools, built-in file tools, and the sandbox bash tool
 * into a single Map keyed by tool name.
 *
 * Duplicate names are detected and logged as warnings; the first registration wins.
 */
export function createToolRegistry(
	builtInTools: Map<string, BuiltInTool> | undefined,
	clientTools: AgentLoopConfig["clientTools"],
	agentTools: RegisteredTool[],
	logger: AppContext["logger"],
	platformTools?: PlatformRegisteredTool[],
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
	registerTool("bms_bash", {
		kind: "sandbox",
		toolDefinition: sandboxTool,
	});

	// 2. Register client tools
	if (clientTools) {
		for (const [name, toolDef] of clientTools.entries()) {
			registerTool(name, {
				kind: "client",
				toolDefinition: toolDef,
			});
		}
	}

	// 3. Register platform tools (with execute closures intact for MCP dispatch)
	if (platformTools) {
		for (const tool of platformTools) {
			const name = tool.toolDefinition.function.name;
			// Map MCP-spec hints (per the wire schema) onto the agent's local
			// retry-policy fields. Explicit static idempotent/readOnly take
			// precedence over the MCP-style hints when both are present.
			const idempotent = tool.idempotent ?? tool.annotations?.idempotentHint;
			const readOnly = tool.readOnly ?? tool.annotations?.readOnlyHint;
			registerTool(name, {
				kind: "platform",
				toolDefinition: tool.toolDefinition,
				execute: tool.execute,
				idempotent,
				readOnly,
				resolveAnnotations: tool.resolveAnnotations,
			});
		}
	}

	// 4. Register agent tools
	for (const tool of agentTools) {
		const name = tool.toolDefinition.function.name;
		registerTool(name, tool);
	}

	// 5. Register built-in file tools
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
	// Process-lifetime VFS re-hydration closure, shared by every agent loop this
	// factory produces. The VFS (clusterFsObj.fs) is a per-host singleton, so the
	// re-hydration cursor — "what has already been pulled from the files table" —
	// is host-global, NOT per-invocation. Built once here, called from each loop's
	// HYDRATE_FS stage. Without this, post-boot uploads (web Files tab, synced peer
	// changes) never reach the live sandbox until a restart re-runs hydrateWorkspace.
	const rehydrateFs = clusterFsObj
		? createVfsRehydrator(clusterFsObj.fs, appContext.db)
		: undefined;

	return (config: AgentLoopConfig): MainAgentLoop => {
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
							mcpApp: undefined as import("@bound/sandbox").McpAppBinding | undefined,
						};
						const result = await loopContextStorage.run(store, () => sandbox.bash.exec(cmd, opts));
						if (store.relayRequest && isRelayRequest(store.relayRequest)) {
							const req = store.relayRequest;
							store.relayRequest = undefined;
							return req;
						}
						// Lift the MCP Apps binding (if a UI-bearing tool was dispatched)
						// onto the result so the agent loop can stamp it into metadata.
						// just-bash strips extra fields, so it rides the store side-channel.
						if (store.mcpApp) {
							return { ...(result as object), mcpApp: store.mcpApp };
						}
						return result;
					}
				: undefined,
			checkMemoryThreshold: sandbox ? () => sandbox.checkMemoryThreshold() : undefined,

			// Called at HYDRATE_FS, before capturePreSnapshot: pull files-table rows
			// written since the last turn into the live VFS (Invariant #5 ordering —
			// the re-pull becomes the OCC baseline, never mistaken for an agent edit).
			rehydrateFs,

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
		// sandboxTool (bash) is always included first; built-in file tools next;
		// then platform tools. Extract ToolDefinitions for LLM visibility.
		const platformToolDefs =
			config.platformTools?.map((tool) => ({
				type: "function" as const,
				function: {
					name: tool.toolDefinition.function.name,
					description: tool.toolDefinition.function.description,
					parameters: tool.toolDefinition.function.parameters,
				},
			})) ?? [];

		// Create ToolContext for native agent tools
		const memoryConfigResult = appContext.optionalConfig.memory;
		const memoryLimits =
			memoryConfigResult?.ok && memoryConfigResult.value
				? {
						pinnedCountCap: (memoryConfigResult.value as { pinned_count_cap: number })
							.pinned_count_cap,
						pinnedSizeCap: (memoryConfigResult.value as { pinned_size_cap: number })
							.pinned_size_cap,
					}
				: undefined;
		// Topology role: spoke when a hub URL is configured, hub otherwise
		// (mirrors agent-loop's topologyRole derivation for the orientation block).
		const syncResult = appContext.optionalConfig.sync;
		const syncConfig = syncResult?.ok ? (syncResult.value as { hub?: unknown }) : undefined;
		const topologyRole: "hub" | "spoke" = syncConfig?.hub ? "spoke" : "hub";
		// #201 Car C: aux loop runner — constructs and runs an AuxAgentLoop
		// for an auxiliary agent invocation. Shares the VFS and underlying
		// sandbox, but has its own snapshot state to avoid collision with
		// the parent loop's FS persist.
		const auxCap = new ConcurrentCap(20);

		const rawAuxLoopRunner: ToolContext["auxLoopRunner"] = async (params) => {
			let auxPreSnapshot: Map<string, string> | null = null;

			const auxSandbox = {
				exec: sandbox
					? async (cmd: string, opts?: Record<string, unknown>) => {
							const store = {
								threadId: params.threadId,
								taskId: undefined as string | undefined,
								relayRequest: undefined as unknown | undefined,
								mcpApp: undefined as import("@bound/sandbox").McpAppBinding | undefined,
							};
							const result = await loopContextStorage.run(store, () =>
								sandbox.bash.exec(cmd, opts),
							);
							if (store.relayRequest && isRelayRequest(store.relayRequest)) {
								const req = store.relayRequest;
								store.relayRequest = undefined;
								return req;
							}
							if (store.mcpApp) {
								return { ...(result as object), mcpApp: store.mcpApp };
							}
							return result;
						}
					: undefined,
				checkMemoryThreshold: sandbox ? () => sandbox.checkMemoryThreshold() : undefined,
				rehydrateFs,
				writeFile: clusterFsObj
					? async (path: string, content: string): Promise<void> => {
							await clusterFsObj.fs.writeFile(path, content);
						}
					: undefined,
				capturePreSnapshot: async (): Promise<void> => {
					if (!clusterFsObj) return;
					auxPreSnapshot = await snapshotWorkspace(clusterFsObj.fs, {
						paths: clusterFsObj.getInMemoryPaths(),
					});
				},
				persistFs: async (): Promise<{ changes: number; changedPaths?: string[] }> => {
					if (!clusterFsObj || !auxPreSnapshot) {
						return { changes: 0 };
					}
					const postSnapshot = await snapshotWorkspace(clusterFsObj.fs, {
						paths: clusterFsObj.getInMemoryPaths(),
					});
					const changedPaths = diffWorkspace(auxPreSnapshot, postSnapshot).map((c) => c.path);
					const result = await persistWorkspaceChanges(
						appContext.db,
						appContext.siteId,
						auxPreSnapshot,
						postSnapshot,
						appContext.eventBus,
						undefined,
						clusterFsObj.fs,
					);
					auxPreSnapshot = postSnapshot;
					if (!result.ok) {
						return { changes: 0 };
					}
					return { changes: result.value.changes, changedPaths };
				},
				builtInTools,
			};

			// Aux ToolContext with agentId set for memory namespace scoping
			const auxToolCtx: ToolContext = {
				db: appContext.db,
				siteId: appContext.siteId,
				eventBus: appContext.eventBus,
				logger: appContext.logger,
				threadId: params.threadId,
				modelRouter,
				fs: clusterFsObj?.fs,
				memoryLimits,
				topologyRole,
				agentId: params.agentId,
			};

			// Capability boundary — always excluded from aux toolset
			const EXCLUDED_TOOLS = new Set(["aux", "task", "cancel", "notify", "introspect"]);
			let filteredAgentTools = createAgentTools(auxToolCtx).filter(
				(t) => !EXCLUDED_TOOLS.has(t.toolDefinition.function.name),
			);
			if (params.allowlistedTools) {
				const allow = new Set(params.allowlistedTools);
				filteredAgentTools = filteredAgentTools.filter((t) =>
					allow.has(t.toolDefinition.function.name),
				);
			}

			const auxToolDefs = filteredAgentTools.map((t) => t.toolDefinition);
			const auxToolRegistry = createToolRegistry(
				builtInTools,
				undefined,
				filteredAgentTools,
				appContext.logger,
				undefined,
			);

			const auxLoop = new AuxAgentLoop(appContext, auxSandbox, modelRouter, {
				threadId: params.threadId,
				userId: params.userId,
				modelId: params.modelHint ?? undefined,
				systemPromptAddition: params.persona,
				platform: "aux",
				tools: [sandboxTool, ...builtInToolDefs, ...auxToolDefs],
				toolRegistry: auxToolRegistry,
			});

			const loopResult = await auxLoop.run();

			// Extract the last assistant message as the summary
			const lastAssistant = appContext.db
				.prepare(
					"SELECT content FROM messages WHERE thread_id = ? AND role = 'assistant' AND deleted = 0 ORDER BY created_at DESC LIMIT 1",
				)
				.get(params.threadId) as { content: string } | null;

			return {
				summary: lastAssistant?.content ?? "(no response)",
				error: loopResult.error,
			};
		};

		// #201: wrap the runner with a concurrent-invocation cap so an agent
		// cannot spawn unbounded nested loops. The cap lives in this closure
		// and is shared across all invocations on this host.
		const auxLoopRunner: ToolContext["auxLoopRunner"] = async (params) => {
			if (!auxCap.acquire()) {
				return {
					summary: `Error: concurrent auxiliary agent cap reached (${auxCap.capacity}). Wait for in-flight invocations to complete before invoking again.`,
					error: "concurrent-cap",
				};
			}
			try {
				return await rawAuxLoopRunner(params);
			} finally {
				auxCap.release();
			}
		};

		const toolCtx: ToolContext = {
			db: appContext.db,
			siteId: appContext.siteId,
			eventBus: appContext.eventBus,
			logger: appContext.logger,
			threadId: config.threadId,
			taskId: config.taskId,
			modelRouter,
			fs: clusterFsObj?.fs,
			memoryLimits,
			topologyRole,
			auxLoopRunner,
		};
		const agentTools = createAgentTools(toolCtx);

		// Create the unified tool registry for registry-based dispatch.
		// Platform tools are registered with their execute closures intact for MCP dispatch.
		const toolRegistry = createToolRegistry(
			builtInTools,
			config.clientTools,
			agentTools,
			appContext.logger,
			config.platformTools,
		);

		return new MainAgentLoop(appContext, loopSandbox, modelRouter, {
			...config,
			tools: [sandboxTool, ...builtInToolDefs, ...platformToolDefs],
			toolRegistry,
		});
	};
}
