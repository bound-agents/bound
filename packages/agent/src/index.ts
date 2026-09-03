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
export { compileDynamicPricing } from "./dynamic-pricing";
export { loadModelBackendsConfig } from "./model-backends-config";
export type { LoadedModelBackendsConfig } from "./model-backends-config";
export type { ContextParams, AssemblyClock, AssemblyContext } from "./context-assembly";
export { realTimeClock, frozenClock } from "./context-assembly";
export type { ModelResolution } from "./model-resolution";

// Export RxJS utilities
export { fromEventBus, pollDb } from "./rx-utils.js";
export {
	createRelayStream$,
	type RelayStreamDeps,
	type RelayStreamOptions,
} from "./relay-stream$.js";
export { createRelayInferenceStream } from "./relay-inference-stream.js";
export {
	createRelayWait$,
	type RelayWaitDeps,
	type RelayWaitParams,
	type RelayWaitOptions,
} from "./relay-wait$.js";
export {
	awaitPlatformRequestResponse,
	readUnionResponseEntry,
	type PlatformResponseAwaitDeps,
	type UnionResponseEntry,
} from "./relay-await-helpers.js";

// Export model resolution
export {
	MAX_MODEL_RECONNECT_WAIT_MS,
	resolveModel,
	resolveModelTier,
	resolveSameTierFallback,
	waitForModelResolution,
} from "./model-resolution";
export { createModelCommandSpec } from "./platform-command-handlers";
export type { PlatformCommandHandlerDeps } from "./platform-command-handlers";

// Export delegation / client-session helpers. Whole-loop delegation
// (getDelegationTarget / getClientSessionDelegationTarget / hasLocalClientSession)
// is gone under the single delegation path (R-UD1); what remains are the
// client-session liveness helpers used by hostinfo + notify/introspect warnings.
export {
	clientSessionWakeupWarning,
	getClientSessions,
	isClientSessionLive,
	resolveClientSessionHost,
} from "./delegation";
export { routeNotificationWakeup, deliverNotificationWakeup } from "./wakeup-routing";
export { dispatchAwaitableClientTool } from "./client-tool-dispatch";

// Export agent loop
export { MainAgentLoop } from "./agent-loop";
export { BoundAgentLoop } from "./bound-agent-loop";
export { AuxAgentLoop } from "./aux-agent-loop";
export { ConcurrentCap } from "./concurrent-cap";
export type { BoundPreparedFrame, BashLike } from "./bound-agent-loop";
export { persistImageBlocksAsFileRefs, persistBinaryResource } from "./tool-result-images";
export {
	findPendingUserMessage,
	insertThreadMessage,
	calculateTurnCost,
	estimateMaxTurnCost,
	createFileRefResolver,
	extractAssistantText,
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
export {
	serializeRelayTraceCarrier,
	routeRelayRequest,
	shouldRouteRelayDurable,
} from "./relay-router";
export type {
	RouteRelayRequestParams,
	RouteRelayRequestResult,
	RelayDurableRoutingContext,
} from "./relay-router";
export { resolveHubSiteId, resolveTopologyRole } from "./topology";
export type { TopologyRole } from "./topology";

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
export {
	extractSummaryAndMemories,
	buildCrossThreadDigest,
	renderCrossThreadSummaries,
	shouldInjectCrossThreadSummaries,
} from "./summary-extraction";

// Export file-thread tracker
export {
	trackFilePath,
	getLastThreadForFile,
	getFileThreadNotificationMessage,
} from "./file-thread-tracker";

// Export task resolution
export {
	seedHeartbeat,
	seedConsolidation,
	DEFAULT_CONSOLIDATION_INTERVAL_MS,
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
	deleteSkill,
	type DeleteSkillOptions,
	type DeleteSkillResult,
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
export {
	DURABLE_WORK_REGISTRY,
	DURABLE_WORK_KINDS,
	type DurableWorkRegistration,
} from "./durable-work-registry";
export { createWorkspoolCommand } from "./workspool-command";
