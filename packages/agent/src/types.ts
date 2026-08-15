export type {
	AgentLoopConfig,
	AgentLoopResult,
	AgentLoopState,
	BuiltInToolResult,
	ClientToolCallRequest,
	DeferredToolResult,
	DispatchSpanTracker,
	RegisteredTool,
	ToolAnnotations,
	ToolExecutionResult,
	ToolResultWithMetadata,
} from "@bound/loop";
export {
	VALID_TRANSITIONS,
	isClientToolCallRequest,
	isDeferredToolResult,
	isToolResultWithMetadata,
} from "@bound/loop";

/**
 * Context passed to native agent tool factories.
 * Extends the fields needed by all tool closures (db, siteId, eventBus, logger, threadId, taskId, modelRouter).
 * Uses inline import() types to avoid circular dependencies.
 */
export interface ToolContext {
	db: import("bun:sqlite").Database;
	siteId: string;
	eventBus: import("@bound/shared").TypedEventEmitter;
	logger: import("@bound/shared").Logger;
	threadId?: string;
	taskId?: string;
	modelRouter?: import("@bound/llm").ModelRouter;
	fs?: import("just-bash").IFileSystem;
	/**
	 * Caps on pinned-memory creation/promotion (issue #101). When absent the
	 * enforcement code falls back to DEFAULT_PINNED_COUNT_CAP /
	 * DEFAULT_PINNED_SIZE_CAP, so the feature is enabled by default even on
	 * ToolContext construction sites that do not wire config.
	 */
	memoryLimits?: { pinnedCountCap: number; pinnedSizeCap: number };
	/**
	 * Cluster topology role of this host (`"hub"` / `"spoke"`), or undefined when
	 * sync is not configured. Lets `hostinfo` name which node is the hub —
	 * resolution is gated on this (see `resolveHubSiteId`), because an ungated
	 * `sync_state` read misidentifies the hub as one of its own spokes.
	 */
	topologyRole?: import("./topology.js").TopologyRole;
	/**
	 * #201: auxiliary-agent namespace. NULL (or undefined) = main agent; a
	 * non-null value scopes all memory reads/writes to the aux identity's
	 * namespace. Set by the nested loop when running an aux thread.
	 */
	agentId?: string | null;
	/**
	 * #201 Car C: factory that constructs and runs an AuxAgentLoop for an aux
	 * invocation. Provided by agent-factory where AppContext/sandbox/ModelRouter
	 * are available. When absent, invoke creates + seeds the thread but cannot
	 * run the nested loop (returns the thread handle for later execution).
	 */
	auxLoopRunner?: (params: {
		threadId: string;
		agentId: string;
		persona: string;
		modelHint: string | null;
		allowlistedTools: string[] | null;
		instructions: string;
		userId: string;
		parentThreadId: string;
	}) => Promise<{ summary: string; error?: string }>;
	/**
	 * Yard: lazy accessor for the unified tool registry the current loop
	 * dispatches through. Set by agent-factory AFTER the registry is
	 * constructed (the registry contains the agent tools, so it cannot exist
	 * when the tool factories run — the closure breaks the cycle). When
	 * absent, the yard tool refuses to run rather than dispatching against a
	 * partial toolset.
	 */
	getToolRegistry?: () => Map<string, import("@bound/loop").RegisteredTool>;
	/**
	 * Yard seam for sandbox-kind tools (`bms_bash`, including MCP bridge
	 * subcommands). Registry entries intentionally carry no execute closure —
	 * the loop owns sandbox execution, timeout, and relay behavior — so Yard
	 * receives the SAME executor from agent-factory instead of growing a
	 * special-case command runner.
	 */
	executeSandboxTool?: (
		command: string,
		timeout?: number,
		cwd?: string,
	) => Promise<{
		stdout?: string;
		stderr?: string;
		exitCode?: number;
	}>;
}
