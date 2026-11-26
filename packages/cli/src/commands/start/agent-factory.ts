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
	dispatchAwaitableClientTool,
	extractAssistantText,
	resolveClientSessionHost,
} from "@bound/agent";
import type { AgentLoopConfig, RegisteredTool, ToolContext } from "@bound/agent";
import { isRelayRequest, resolveTopologyRole } from "@bound/agent";
import type { BuiltInTool } from "@bound/agent";
import { listClientSessionSiteIdsByThreadId } from "@bound/core";
import type { AppContext } from "@bound/core";
import type { ModelRouter, ToolDefinition } from "@bound/llm";
import type { PlatformRegisteredTool } from "@bound/platforms";
import {
	type ClusterFsResult,
	type McpAppBinding,
	createVfsRehydrator,
	diffWorkspace,
	loopContextStorage,
	persistWorkspaceChanges,
	snapshotWorkspace,
} from "@bound/sandbox";
import type { SandboxResult } from "./sandbox.js";

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

export interface AuxLoopParentContext {
	clientTools?: AgentLoopConfig["clientTools"];
	connectionId?: string;
	/** Surface tag inherited from the dispatching loop (web, boundless, discord, ...). */
	platform?: string;
	/** Full per-session context block (boundless cwd/git/context files, when present). */
	systemPromptAddition?: string;
	/** Connector/platform-authored instructions from the dispatching loop. */
	platformInstructions?: string;
	/**
	 * The dispatching loop's abort signal. A synchronous aux invocation blocks
	 * the parent in `await auxLoop.run()`, so the parent cannot observe its own
	 * abort until the child returns — the child must share the brake line.
	 * Without this, `agent:cancel` aborted the parent's controller while the
	 * nested aux kept issuing LLM calls for its full natural lifetime
	 * (observed live: ten minutes past three operator cancels).
	 */
	abortSignal?: AbortSignal;
}

export interface AgentLoopFactory {
	(config: AgentLoopConfig): MainAgentLoop;
	createAuxLoopRunner(parent: AuxLoopParentContext): NonNullable<ToolContext["auxLoopRunner"]>;
}

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

type SandboxExecResult = Awaited<ReturnType<NonNullable<SandboxResult["sandbox"]>["bash"]["exec"]>>;

/** bash first, then the built-in VFS file tools. */
function baseToolDefinitions(builtInTools: Map<string, BuiltInTool> | undefined): ToolDefinition[] {
	return [
		sandboxTool,
		...(builtInTools ? Array.from(builtInTools.values(), (t) => t.toolDefinition) : []),
	];
}

function resolveMemoryLimits(appContext: AppContext): ToolContext["memoryLimits"] {
	const result = appContext.optionalConfig.memory;
	if (!result?.ok || !result.value) return undefined;
	const memory = result.value as { pinned_count_cap: number; pinned_size_cap: number };
	return { pinnedCountCap: memory.pinned_count_cap, pinnedSizeCap: memory.pinned_size_cap };
}

export function createAgentLoopFactory(
	appContext: AppContext,
	modelRouter: ModelRouter,
	sandbox: SandboxResult["sandbox"],
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

	/**
	 * The sandbox adapter one agent loop drives. Each call owns its
	 * pre-snapshot, so concurrent loops (and an aux nested in a main loop) never
	 * share FS-persist baselines.
	 */
	const createLoopSandbox = (store: { threadId: string; taskId?: string }) => {
		let preSnapshot: Map<string, string> | null = null;
		// Built from the same VFS handle the memory tracker wraps, so writes
		// through these tools reach FS_PERSIST.
		const builtInTools = clusterFsObj ? createBuiltInTools(clusterFsObj.fs) : undefined;
		return {
			// Runs inside loopContextStorage so command handlers see the loop's
			// threadId/taskId. just-bash normalizes results to
			// {stdout, stderr, exitCode, env}, so a relay request (remote MCP proxy
			// commands) or an MCP Apps binding rides the store side-channel and is
			// lifted back onto the result here.
			exec: sandbox
				? async (cmd: string, opts?: Record<string, unknown>): Promise<SandboxExecResult> => {
						const loopStore = {
							threadId: store.threadId,
							taskId: store.taskId,
							relayRequest: undefined as unknown | undefined,
							mcpApp: undefined as McpAppBinding | undefined,
						};
						const result = await loopContextStorage.run(loopStore, () =>
							sandbox.bash.exec(cmd, opts),
						);
						if (loopStore.relayRequest && isRelayRequest(loopStore.relayRequest)) {
							const req = loopStore.relayRequest;
							loopStore.relayRequest = undefined;
							// The agent loop detects the relay request by shape (isRelayRequest).
							return req as unknown as SandboxExecResult;
						}
						if (loopStore.mcpApp) {
							return { ...result, mcpApp: loopStore.mcpApp } as SandboxExecResult;
						}
						return result;
					}
				: undefined,
			checkMemoryThreshold: sandbox ? () => sandbox.checkMemoryThreshold() : undefined,
			// Runs at HYDRATE_FS before capturePreSnapshot, so the re-pull becomes
			// the OCC baseline and is never mistaken for an agent edit (invariant #5).
			rehydrateFs,
			writeFile: clusterFsObj
				? async (path: string, content: string): Promise<void> => {
						await clusterFsObj.fs.writeFile(path, content);
					}
				: undefined,
			capturePreSnapshot: async (): Promise<void> => {
				if (!clusterFsObj) return;
				preSnapshot = await snapshotWorkspace(clusterFsObj.fs, {
					paths: clusterFsObj.getInMemoryPaths(),
				});
			},
			persistFs: async (): Promise<{ changes: number; changedPaths?: string[] }> => {
				if (!clusterFsObj || !preSnapshot) {
					return { changes: 0 };
				}
				const postSnapshot = await snapshotWorkspace(clusterFsObj.fs, {
					paths: clusterFsObj.getInMemoryPaths(),
				});
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
	};

	const createAuxLoopRunner = (
		parent: AuxLoopParentContext,
	): NonNullable<ToolContext["auxLoopRunner"]> => {
		const builtInTools = clusterFsObj ? createBuiltInTools(clusterFsObj.fs) : undefined;
		const memoryLimits = resolveMemoryLimits(appContext);
		const topologyRole = resolveTopologyRole(appContext.optionalConfig) ?? "hub";
		// #201: an aux loop shares the VFS and sandbox but keeps its own
		// snapshot state so its FS persist cannot collide with the parent's.
		const auxCap = new ConcurrentCap(20);

		const rawAuxLoopRunner: ToolContext["auxLoopRunner"] = async (params) => {
			const auxSandbox = createLoopSandbox({ threadId: params.threadId });

			// Aux ToolContext with agentId set for memory namespace scoping.
			// Same lazy-registry pattern as the main path below: yard dispatches
			// yielded tool effects through the registry that is built FROM these
			// tools, so the accessor closes over a let-binding assigned after
			// construction. The aux registry already encodes the capability
			// boundary (EXCLUDED_TOOLS + allowlist), so a yard run inside an aux
			// sees exactly the aux's effective toolset — nested calls cannot
			// escalate back to the main agent's tools.
			// biome-ignore lint/style/useConst: assigned below, after the accessor closure that captures it is constructed
			let auxToolRegistry: Map<string, RegisteredTool> | undefined;
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
				executeSandboxTool: async (command, timeout, cwd) => {
					if (!auxSandbox.exec) throw new Error("sandbox execution not available");
					return auxSandbox.exec(command, { timeout, cwd });
				},
				executeClientTool: (name, args, timeoutMs, signal) =>
					dispatchAwaitableClientTool({
						db: appContext.db,
						eventBus: appContext.eventBus,
						siteId: appContext.siteId,
						threadId: params.threadId,
						toolName: name,
						args,
						connectionId: parent.connectionId,
						// No session of its own: relay through the parent's (#295).
						sessionThreadId: params.parentThreadId,
						timeoutMs,
						signal,
						topologyRole,
					}),
				getToolRegistry: () => {
					if (!auxToolRegistry) throw new Error("aux tool registry accessed before construction");
					return auxToolRegistry;
				},
			};

			// Capability boundary — always excluded from aux toolset
			const EXCLUDED_TOOLS = new Set(["aux", "task", "cancel", "notify", "introspect"]);
			const allAgentTools = createAgentTools(auxToolCtx);
			let filteredAgentTools = allAgentTools.filter(
				(t) => !EXCLUDED_TOOLS.has(t.toolDefinition.function.name),
			);
			if (params.allowlistedTools) {
				const allow = new Set(params.allowlistedTools);
				filteredAgentTools = filteredAgentTools.filter((t) =>
					allow.has(t.toolDefinition.function.name),
				);
			}

			// Inherit the dispatching thread's client (WS) tools so an aux running
			// under a boundless session can actually reach the operator's working
			// directory. Without this an aux only ever sees the sandboxed VFS and
			// cannot read the repo it was asked to investigate. Delivery works
			// because the WS layer falls back to the PARENT thread's subscriptions
			// (nothing ever subscribes to an aux thread), and AuxAgentLoop resolves
			// these inline instead of deferring — a nested loop has no re-wake path.
			const parentClientTools = parent.clientTools;
			const auxClientTools = (() => {
				if (!parentClientTools) return undefined;
				if (!params.allowlistedTools) return parentClientTools;
				const allow = new Set(params.allowlistedTools);
				const scoped = new Map(
					Array.from(parentClientTools.entries()).filter(([name]) => allow.has(name)),
				);
				return scoped.size > 0 ? scoped : undefined;
			})();
			const auxClientToolDefs = auxClientTools ? Array.from(auxClientTools.values()) : [];

			// Fail at dispatch rather than run an errand that cannot do its job
			// (#295): the parent is attached to a client session, the aux needs
			// client tools (no allowlist, or an allowlist naming a tool no server
			// path provides), and no session can serve them — no client tools
			// reached this loop, or there is neither a local connection nor a live
			// remote session host to relay to (invariant #21).
			const serverToolNames = new Set([
				sandboxTool.function.name,
				...(builtInTools ? builtInTools.keys() : []),
				...allAgentTools.map((t) => t.toolDefinition.function.name),
			]);
			const needsClientTools =
				!params.allowlistedTools ||
				params.allowlistedTools.some((name) => !serverToolNames.has(name));
			if (
				needsClientTools &&
				listClientSessionSiteIdsByThreadId(appContext.db, params.parentThreadId).length > 0
			) {
				const bindable =
					auxClientTools !== undefined &&
					(parent.connectionId !== undefined ||
						resolveClientSessionHost(appContext.db, params.parentThreadId, appContext.siteId) !==
							null);
				if (!bindable) {
					const reason = `client session unavailable for aux dispatch: parent thread ${params.parentThreadId} is attached to a client session, but no live session can serve this errand's client tools`;
					appContext.logger.warn("[aux] Rejected dispatch without a bindable client session", {
						threadId: params.threadId,
						parentThreadId: params.parentThreadId,
					});
					return { summary: `Error: ${reason}`, error: reason, rejected: true };
				}
			}

			const auxToolDefs = filteredAgentTools.map((t) => t.toolDefinition);
			auxToolRegistry = createToolRegistry(
				builtInTools,
				auxClientTools,
				filteredAgentTools,
				appContext.logger,
				undefined,
			);

			const auxLoop = new AuxAgentLoop(appContext, auxSandbox, modelRouter, {
				threadId: params.threadId,
				userId: params.userId,
				modelId: params.modelHint ?? undefined,
				// Preserve the parent surface's complete injected context verbatim —
				// notably boundless cwd/git/context-file blocks.
				systemPromptAddition: parent.systemPromptAddition,
				// The aux identity replaces the main persona in the stable prefix.
				personaOverride: params.persona,
				platformInstructions: parent.platformInstructions,
				platform: parent.platform ?? "aux",
				tools: [...baseToolDefinitions(builtInTools), ...auxToolDefs, ...auxClientToolDefs],
				toolRegistry: auxToolRegistry,
				clientTools: auxClientTools,
				// Carries the parent's WS connection so the inline client-tool
				// dispatch takes the local path rather than resolving a relay host.
				connectionId: parent.connectionId,
				// Couple the parent's brake line: agent:cancel aborts the parent's
				// controller, and a synchronous aux blocks the parent until it
				// returns — so the nested loop must observe the same signal.
				abortSignal: parent.abortSignal,
			});

			const loopResult = await auxLoop.run();

			// Extended-thinking and tool-use turns persist a ContentBlock[] transcript
			// for provider replay. An aux result is its final visible assistant text,
			// not that private/internal persistence representation.
			const lastAssistant = appContext.db
				.prepare(
					"SELECT content FROM messages WHERE thread_id = ? AND role = 'assistant' AND deleted = 0 ORDER BY created_at DESC LIMIT 1",
				)
				.get(params.threadId) as { content: string } | null;

			return {
				summary: lastAssistant ? extractAssistantText(lastAssistant.content) : "(no response)",
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

		return auxLoopRunner;
	};

	const factory = (config: AgentLoopConfig): MainAgentLoop => {
		const loopSandbox = createLoopSandbox({ threadId: config.threadId, taskId: config.taskId });
		const builtInTools = loopSandbox.builtInTools;

		const platformToolDefs =
			config.platformTools?.map((tool) => ({
				type: "function" as const,
				function: {
					name: tool.toolDefinition.function.name,
					description: tool.toolDefinition.function.description,
					parameters: tool.toolDefinition.function.parameters,
				},
			})) ?? [];

		const memoryLimits = resolveMemoryLimits(appContext);
		const topologyRole = resolveTopologyRole(appContext.optionalConfig) ?? "hub";
		const auxLoopRunner = createAuxLoopRunner({
			clientTools: config.clientTools,
			connectionId: config.connectionId,
			platform: config.platform,
			systemPromptAddition: config.systemPromptAddition,
			platformInstructions: config.platformInstructions,
			abortSignal: config.abortSignal,
		});

		// Yard dispatches yielded tool effects through the same unified registry
		// the loop uses, but the registry is built FROM the agent tools — so the
		// yard factory receives a lazy accessor over a let-binding assigned below.
		// biome-ignore lint/style/useConst: assigned below, after the accessor closure that captures it is constructed
		let toolRegistry: Map<string, RegisteredTool> | undefined;
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
			executeSandboxTool: async (command, timeout, cwd) => {
				if (!loopSandbox.exec) throw new Error("sandbox execution not available");
				return loopSandbox.exec(command, { timeout, cwd });
			},
			executeClientTool: (name, args, timeoutMs, signal) =>
				dispatchAwaitableClientTool({
					db: appContext.db,
					eventBus: appContext.eventBus,
					siteId: appContext.siteId,
					threadId: config.threadId,
					toolName: name,
					args,
					connectionId: config.connectionId,
					timeoutMs,
					signal,
					topologyRole,
				}),
			getToolRegistry: () => {
				if (!toolRegistry) throw new Error("tool registry accessed before construction");
				return toolRegistry;
			},
		};
		const agentTools = createAgentTools(toolCtx);

		// Create the unified tool registry for registry-based dispatch.
		// Platform tools are registered with their execute closures intact for MCP dispatch.
		toolRegistry = createToolRegistry(
			builtInTools,
			config.clientTools,
			agentTools,
			appContext.logger,
			config.platformTools,
		);

		return new MainAgentLoop(appContext, loopSandbox, modelRouter, {
			...config,
			tools: [...baseToolDefinitions(builtInTools), ...platformToolDefs],
			toolRegistry,
		});
	};
	factory.createAuxLoopRunner = createAuxLoopRunner;
	return factory;
}
