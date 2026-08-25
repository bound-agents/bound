import type { ContentBlock, LLMBackend, LLMMessage, ModelRouter, ToolDefinition } from "@bound/llm";
import type { ContextDebugInfo } from "@bound/shared";
import type { ParsedResponse, ParsedToolCall } from "./stream-parser";
import type {
	AgentLoopConfig,
	AgentLoopResult,
	RegisteredTool,
	ToolExecutionResult,
} from "./types";

export interface LoopLogger {
	debug(message: string, metadata?: Record<string, unknown>): void;
	info(message: string, metadata?: Record<string, unknown>): void;
	warn(message: string, metadata?: Record<string, unknown>): void;
	error(message: string, metadata?: Record<string, unknown>): void;
}

export interface LoopHostContext {
	siteId: string;
	hostName: string;
	logger: LoopLogger;
}

export interface LoopContextAssemblyInput {
	config: AgentLoopConfig;
	modelId: string;
	contextWindow: number;
	tools: ToolDefinition[] | undefined;
}

export interface LoopContextAssemblyResult {
	messages: LLMMessage[];
	systemPrompt: string;
	debug: ContextDebugInfo;
}

export interface LoopModelResolution {
	kind: "local" | "remote" | "error";
	modelId?: string;
	backend?: LLMBackend;
	error?: string;
	// Context window for the resolved model, in tokens. When the base
	// prepareFrame runs it uses this instead of a hardcoded fallback.
	// undefined means "unknown" — the consumer applies its own default.
	max_context?: number;
}

export interface LoopTurnMetrics {
	threadId: string;
	taskId?: string;
	modelId: string;
	response: ParsedResponse;
	status?: "success" | "error" | "aborted";
	contextDebug?: ContextDebugInfo;
}

export interface LoopPersistenceHooks {
	recordTurn(metrics: LoopTurnMetrics): string | null | Promise<string | null>;
	persistAssistantResponse(content: string | ContentBlock[], modelId: string): Promise<void> | void;
	persistToolRoundTrip(input: {
		modelId: string;
		assistantBlocks: ContentBlock[];
		results: Array<{ toolCall: ParsedToolCall; result: ToolExecutionResult }>;
	}): Promise<void> | void;
	persistAlert(content: string): Promise<void> | void;
}

export interface LoopExtensions {
	context: LoopHostContext;
	modelRouter: ModelRouter;
	resolveModel(modelId: string | undefined): LoopModelResolution;
	assembleContext(input: LoopContextAssemblyInput): Promise<LoopContextAssemblyResult>;
	listTools(config: AgentLoopConfig): RegisteredTool[];
	executeTool(toolCall: ParsedToolCall): Promise<ToolExecutionResult>;
	persistence: LoopPersistenceHooks;
	afterRun?(result: AgentLoopResult): Promise<void> | void;
}
