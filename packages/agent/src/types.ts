export type {
	AgentLoopConfig,
	AgentLoopResult,
	AgentLoopState,
	BuiltInToolResult,
	ClientToolCallRequest,
	DispatchSpanTracker,
	RegisteredTool,
	ToolAnnotations,
	ToolExecutionResult,
} from "@bound/loop";
export { VALID_TRANSITIONS, isClientToolCallRequest } from "@bound/loop";

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
}
