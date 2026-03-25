// Export types
export type { AgentLoopState, AgentLoopConfig, AgentLoopResult } from "./types";
export type { ContextParams } from "./context-assembly";

// Export agent loop
export { AgentLoop } from "./agent-loop";

// Export context assembly
export { assembleContext } from "./context-assembly";

// Export scheduler
export { Scheduler } from "./scheduler";

// Export relay processor
export { RelayProcessor } from "./relay-processor";

// Export commands
export { getAllCommands, setCommandRegistry } from "./commands/index";

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
export { generateMCPCommands, updateHostMCPInfo } from "./mcp-bridge";
export type { MCPProxyConfig } from "./mcp-bridge";

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
	computeNextRunAt,
	canRunHere,
	isDependencySatisfied,
} from "./task-resolution";
