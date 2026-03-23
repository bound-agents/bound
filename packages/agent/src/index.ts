// Export types
export type { AgentLoopState, AgentLoopConfig, AgentLoopResult } from "./types";
export type { ContextParams } from "./context-assembly";

// Export agent loop
export { AgentLoop } from "./agent-loop";

// Export context assembly
export { assembleContext } from "./context-assembly";

// Export scheduler and task resolution
export { Scheduler } from "./scheduler";
export {
	canRunHere,
	computeNextRunAt,
	isDependencySatisfied,
	seedCronTasks,
} from "./task-resolution";

// Export commands
export { getAllCommands, addMCPCommands } from "./commands/index";
export {
	query,
	memorize,
	forget,
	schedule,
	cancel,
	emit,
	purge,
	awaitCmd,
} from "./commands/index";

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

// Export file-thread tracking
export {
	trackFilePath,
	getLastThreadForFile,
	getFileThreadNotificationMessage,
} from "./file-thread-tracker";
