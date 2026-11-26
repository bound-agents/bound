import type { LLMBackend, LLMMessage } from "@bound/llm";
import type { ContextDebugInfo } from "@bound/shared";
import type { ParsedResponse } from "./stream-parser";

export interface LoopLogger {
	debug(message: string, metadata?: Record<string, unknown>): void;
	info(message: string, metadata?: Record<string, unknown>): void;
	warn(message: string, metadata?: Record<string, unknown>): void;
	error(message: string, metadata?: Record<string, unknown>): void;
}

export interface LoopRuntime {
	logger: LoopLogger;
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
	/**
	 * Set on an error that is not fatal: the model exists but no route can serve
	 * it yet. The loop posts `notice` (when present) through `persistNotice` and
	 * returns outcome `model-unavailable`; `redrive` marks the result yielded so
	 * the thread executor re-runs the thread.
	 */
	unavailable?: { notice?: string; redrive: boolean };
	/** Set when an abort or cancel ended resolution; the loop returns `aborted` without an alert. */
	aborted?: boolean;
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
