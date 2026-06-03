// Export types
export type {
	AgentLoopState,
	AgentLoopConfig,
	AgentLoopResult,
	ClientToolCallRequest,
	RegisteredTool,
	ToolContext,
} from "./types";
export { isClientToolCallRequest } from "./types";
export type { ContextParams } from "./context-assembly";
export type { ModelResolution } from "./model-resolution";

// Export RxJS utilities
export { fromEventBus, pollDb } from "./rx-utils.js";
export {
	createRelayStream$,
	type RelayStreamDeps,
	type RelayStreamOptions,
} from "./relay-stream$.js";
export {
	createRelayWait$,
	type RelayWaitDeps,
	type RelayWaitParams,
	type RelayWaitOptions,
} from "./relay-wait$.js";

// Export model resolution
export { resolveModel, resolveModelTier, resolveSameTierFallback } from "./model-resolution";

// Export delegation
export {
	getClientSessionDelegationTarget,
	getClientSessions,
	getDelegationTarget,
	getRecentToolCalls,
	hasLocalClientSession,
} from "./delegation";

// Export agent loop
export { AgentLoop } from "./agent-loop";
export {
	findPendingUserMessage,
	insertThreadMessage,
	calculateTurnCost,
	estimateMaxTurnCost,
} from "./agent-loop-utils";
export {
	HandleMessageTracker,
	DEFAULT_WATCHDOG_TIMEOUT_MS,
	DEFAULT_WATCHDOG_INTERVAL_MS,
} from "./handle-message-tracker";
export type { HandleMessageTrackerOptions } from "./handle-message-tracker";

// Export context assembly
export { assembleContext } from "./context-assembly";

// Export cache prediction
export { predictCacheState, selectCacheTtl, CACHE_TTL_MS } from "./cache-prediction";

// Export cache warm-poke (issue #10)
export {
	selectWarmPokeTargets,
	isWarmPokeNotificationPayload,
	WARM_POKE_MARKER,
	WARM_POKE_MAX_OUTPUT_TOKENS,
	type WarmPokeSelectionOptions,
} from "./cache-warm-poke";

// Export scheduler
export { Scheduler } from "./scheduler";

// Export relay processor
export { RelayProcessor } from "./relay-processor";
export type { ClientToolResolver } from "./relay-processor";
export { createRelayOutboxEntry } from "./relay-router";

// Export native tools
export { createAgentTools } from "./tools/index";
export { createSkillTool } from "./tools/skill";

// Export MCP client and bridge
export { MCPClient } from "./mcp-client";
export type {
	MCPServerConfig,
	Tool,
	Resource,
	Prompt,
	ToolResult,
	ResourceContent,
	PromptResult,
} from "./mcp-client";
export {
	generateMCPCommands,
	generateRemoteMCPProxyCommands,
	isRelayRequest,
	updateHostMCPInfo,
} from "./mcp-bridge";

// Export advisories
export {
	createAdvisory,
	approveAdvisory,
	dismissAdvisory,
	deferAdvisory,
	applyAdvisory,
	getPendingAdvisories,
} from "./advisories";

// Export redaction
export { redactMessage, redactThread, type RedactionResult } from "./redaction";

// Export title generation
export { generateThreadTitle } from "./title-generation";

// Export summary extraction
export type { ExtractionResult } from "./summary-extraction";
export { extractSummaryAndMemories, buildCrossThreadDigest } from "./summary-extraction";

// Export file-thread tracker
export {
	trackFilePath,
	getLastThreadForFile,
	getFileThreadNotificationMessage,
} from "./file-thread-tracker";

// Export task resolution
export {
	seedCronTasks,
	seedHeartbeat,
	computeNextRunAt,
	canRunHere,
	isDependencySatisfied,
} from "./task-resolution";

// Export skill seeding
export { seedBundledSkills } from "./seed-skills";

// Export skill utilities
export {
	parseFrontmatter,
	importSkillFromFiles,
	MAX_ACTIVE_SKILLS,
	MAX_SKILL_BODY_LINES,
	MAX_FILE_SIZE_BYTES,
	MAX_DESCRIPTION_LENGTH,
	SKILL_NAME_REGEX,
	MAX_SKILL_NAME_LENGTH,
} from "./tools/skill-utils";

// Export built-in tools
export { createBuiltInTools } from "./built-in-tools";
export type { BuiltInTool, BuiltInToolResult } from "./built-in-tools";

// Export introspect post-loop hook
export { runIntrospectResponseStamp } from "./tools/introspect";
