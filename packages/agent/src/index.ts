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

// Export model resolution
export { resolveModel, resolveModelTier, resolveSameTierFallback } from "./model-resolution";

// Export delegation
export { getDelegationTarget, getRecentToolCalls } from "./delegation";

// Export agent loop
export { AgentLoop } from "./agent-loop";
export { findPendingUserMessage } from "./agent-loop-utils";

// Export context assembly
export { assembleContext } from "./context-assembly";

// Export cache prediction
export { predictCacheState, selectCacheTtl, CACHE_TTL_MS } from "./cache-prediction";

// Export scheduler
export { Scheduler } from "./scheduler";

// Export relay processor
export { RelayProcessor } from "./relay-processor";
export { createRelayOutboxEntry } from "./relay-router";

// Export commands
export { setCommandRegistry, getCommandRegistry } from "./commands/index";

// Export native tools
export { createAgentTools } from "./tools/index";

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
export { seedSkillAuthoring } from "./seed-skills";

// Export skill utilities
export { parseFrontmatter } from "./tools/skill-utils";

// Export built-in tools
export { createBuiltInTools } from "./built-in-tools";
export type { BuiltInTool, BuiltInToolResult } from "./built-in-tools";
