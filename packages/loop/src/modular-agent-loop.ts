import type { ContentBlock, LLMMessage, StreamChunk, ToolDefinition } from "@bound/llm";
import { type Span, SpanStatusCode, context, trace } from "@opentelemetry/api";
import { getLlmStatusCode, isRateLimitStatus, isTransientLLMError } from "./error-classification";
import type {
	LoopContextAssemblyInput,
	LoopContextAssemblyResult,
	LoopExtensions,
	LoopModelResolution,
	LoopTurnMetrics,
} from "./extensions";
import {
	DEFAULT_LOOP_GUARD_THRESHOLDS,
	type LoopGuardThresholds,
	toolCallSignature,
	toolErrorSignature,
	truncateForNudge,
} from "./loop-guards";
import { withSilenceTimeout } from "./silence-timeout";
import { type ParsedResponse, type ParsedToolCall, parseResponseChunks } from "./stream-parser";
import {
	type AgentLoopConfig,
	type AgentLoopResult,
	type AgentLoopState,
	type ToolExecutionResult,
	VALID_TRANSITIONS,
} from "./types";

export interface ModularAgentLoopOptions {
	/** Hard guard against unbounded tool-call loops. */
	maxTurns?: number;
	/** Per-chunk silence timeout for local backend streams. */
	silenceTimeoutMs?: number;
	/** Max transient-error retries (with backoff) in the base handleModelError. */
	maxTransientRetries?: number;
	/** Max retries when finishReason="length" truncates a thinking-only turn. */
	lengthRetryMax?: number;
	/** Hard ceiling for the bumped output-token budget on length retry. */
	lengthRetryCap?: number;
	/** First bumped output-token budget when no prior max is known. */
	lengthRetryStart?: number;
	/** Tool-call circuit-breaker thresholds (defaults from loop-guards). */
	loopGuards?: Partial<LoopGuardThresholds>;
}

const DEFAULT_MAX_TURNS = 16;
const DEFAULT_SILENCE_TIMEOUT_MS = 600_000;
const DEFAULT_MAX_TRANSIENT_RETRIES = 3;
const DEFAULT_LENGTH_RETRY_MAX = 2;
const DEFAULT_LENGTH_RETRY_CAP = 65_536;
const DEFAULT_LENGTH_RETRY_START = 32_768;

/** Reason codes for a tripped loop-guard, surfaced to onLoopGuardTripped. */
export type LoopGuardReason = "truncated" | "duplicate" | "identical-error" | "routing-error";

/** Classification of a tool result for the error-chain circuit breakers. */
export type ToolResultErrorKind = "routing" | "generic" | null;

export interface PreparedLoopFrame {
	resolution: Exclude<LoopModelResolution, { kind: "error" }> & {
		backend?: LoopModelResolution["backend"];
		modelId: string;
	};
	assembled: LoopContextAssemblyResult;
	messages: LLMMessage[];
	toolDefinitions: ToolDefinition[];
}

export type LoopTurnDecision =
	| { action: "continue" }
	| { action: "retry" }
	| { action: "stop" }
	| { action: "yield" }
	| { action: "error"; error: string };

export interface LoopToolResult {
	toolCall: ParsedToolCall;
	result: ToolExecutionResult;
}

export interface LoopDeferredToolCall {
	toolCall: ParsedToolCall;
	value?: unknown;
}

export interface LoopToolExecutionBatch {
	results: LoopToolResult[];
	deferred: LoopDeferredToolCall[];
}

export interface LoopModelStream {
	chunks: AsyncIterable<StreamChunk>;
	silenceTimeoutMs?: number;
	onSilenceHeartbeat?: () => void;
	useSilenceTimeout?: boolean;
}

type LoopDecisionOutcome =
	| { action: "continue" }
	| { action: "retry" }
	| { action: "return"; result: AgentLoopResult };

interface LoopDecisionSpans {
	loopSpan?: Span;
	turnSpan?: Span;
}

function textFromToolResult(result: ToolExecutionResult): string {
	return result.content;
}

export function buildAssistantToolCallBlocks(
	textContent: string,
	thinking: {
		thinking: string | null;
		signature: string | null;
		redactedData: string | null;
		encryptedContent: string | null;
	},
	toolCalls: Array<{ id: string; name: string; input: Record<string, unknown> }>,
): ContentBlock[] {
	const blocks: ContentBlock[] = [];
	if (thinking.thinking || thinking.redactedData || thinking.encryptedContent) {
		const thinkingBlock: ContentBlock = {
			type: "thinking",
			thinking: thinking.thinking ?? "",
		};
		if (thinking.signature) thinkingBlock.signature = thinking.signature;
		if (thinking.redactedData) thinkingBlock.redacted_data = thinking.redactedData;
		if (thinking.encryptedContent) {
			thinkingBlock.reasoning_encrypted_content = thinking.encryptedContent;
		}
		blocks.push(thinkingBlock);
	}
	if (textContent) {
		blocks.push({ type: "text", text: textContent });
	}
	for (const toolCall of toolCalls) {
		blocks.push({
			type: "tool_use",
			id: toolCall.id,
			name: toolCall.name,
			input: toolCall.input,
		});
	}
	return blocks;
}

/**
 * Minimal reusable multi-turn loop for non-main agents.
 *
 * It owns the LLM/tool response cycle and tracing shape, while callers provide
 * context assembly, model resolution, tool execution, and persistence hooks.
 * The Bound main agent still uses its richer adapter in `@bound/agent`, but
 * this runner gives extension agents a concrete loop without depending on the
 * main agent's database, context pipeline, scheduler, or native tools.
 */
export class ModularAgentLoop {
	protected aborted = false;
	protected messagesCreated = 0;
	protected toolCallsMade = 0;
	protected phase: AgentLoopState = "IDLE";

	// Resilience state — reset per run() in resetResilienceState().
	protected transportRetries = 0;
	protected lengthRetries = 0;
	protected outputTokenOverride: number | null = null;
	protected consecutiveTruncatedTurns = 0;
	protected lastTruncatedToolName: string | null = null;
	protected consecutiveDuplicateToolCalls = 0;
	protected lastToolCallSignature: string | null = null;
	protected consecutiveErrorSignature = 0;
	protected lastErrorSignature: string | null = null;
	protected errorNudgeInjected = false;
	protected consecutiveRoutingErrorSignature = 0;
	protected lastRoutingErrorSignature: string | null = null;

	protected readonly guardThresholds: LoopGuardThresholds;

	constructor(
		protected readonly loopExtensions: LoopExtensions,
		protected readonly loopConfig: AgentLoopConfig,
		protected readonly loopOptions: ModularAgentLoopOptions = {},
	) {
		this.guardThresholds = { ...DEFAULT_LOOP_GUARD_THRESHOLDS, ...loopOptions.loopGuards };
		loopConfig.abortSignal?.addEventListener("abort", () => {
			this.aborted = true;
		});
	}

	/**
	 * Reset per-run resilience counters so a reused loop instance starts each
	 * run cold. Called from run() before beforeRun(); subclasses that override
	 * beforeRun must not duplicate this.
	 */
	protected resetResilienceState(): void {
		this.transportRetries = 0;
		this.lengthRetries = 0;
		this.outputTokenOverride = null;
		this.consecutiveTruncatedTurns = 0;
		this.lastTruncatedToolName = null;
		this.consecutiveDuplicateToolCalls = 0;
		this.lastToolCallSignature = null;
		this.consecutiveErrorSignature = 0;
		this.lastErrorSignature = null;
		this.errorNudgeInjected = false;
		this.consecutiveRoutingErrorSignature = 0;
		this.lastRoutingErrorSignature = null;
	}

	/** Output-token budget for the next model call, honoring any length-retry bump. */
	protected effectiveMaxOutputTokens(): number | undefined {
		return this.outputTokenOverride ?? this.loopConfig.maxOutputTokens;
	}

	async run(): Promise<AgentLoopResult> {
		const tracer = trace.getTracer("bound.loop");
		const loopSpan = tracer.startSpan("loop.run", {
			attributes: {
				"thread.id": this.loopConfig.threadId,
				"task.id": this.loopConfig.taskId ?? "",
			},
		});
		const loopCtx = trace.setSpan(context.active(), loopSpan);
		try {
			this.resetResilienceState();
			await this.beforeRun();
			const resolution = await this.resolveModel();
			if (resolution.kind === "error" || !resolution.modelId) {
				const error = resolution.error ?? "model resolution failed";
				await this.persistAlert(`Loop error: ${error}`);
				loopSpan.setStatus({ code: SpanStatusCode.ERROR, message: error });
				return this.result({ error });
			}

			const frame: PreparedLoopFrame = {
				resolution: {
					...resolution,
					backend: resolution.backend,
					modelId: resolution.modelId,
				},
				...(await this.prepareFrame({
					resolution: {
						...resolution,
						backend: resolution.backend,
						modelId: resolution.modelId,
					},
				})),
			};
			let currentDebug = frame.assembled.debug;
			const maxTurns = this.loopOptions.maxTurns ?? DEFAULT_MAX_TURNS;

			for (let turn = 1; turn <= maxTurns; turn++) {
				const turnOutcome = await this.runTurn({
					turn,
					frame,
					currentDebug,
					tracer,
					loopCtx,
					loopSpan,
				});
				if (turnOutcome.action === "retry") {
					turn--;
					continue;
				}
				if (turnOutcome.action === "return") {
					return turnOutcome.result;
				}
				currentDebug = { ...currentDebug, totalEstimated: currentDebug.totalEstimated };
			}

			const error = `Loop exceeded maxTurns=${maxTurns}`;
			await this.persistAlert(error);
			loopSpan.setStatus({ code: SpanStatusCode.ERROR, message: error });
			return this.result({ error });
		} finally {
			await this.afterRun();
			loopSpan.end();
		}
	}

	cancel(): void {
		this.aborted = true;
	}

	protected setPhase(next: AgentLoopState, options: { validate?: boolean } = {}): void {
		const previous = this.phase;
		const validate = options.validate !== false;
		if (validate) {
			const allowed = VALID_TRANSITIONS[previous];
			if (!allowed.includes(next)) {
				this.onInvalidPhaseTransition(previous, next, allowed);
			}
		}
		this.phase = next;
		this.onPhaseChange(previous, next);
	}

	protected enterPhaseOverlay(overlay: AgentLoopState): AgentLoopState {
		const previous = this.phase;
		this.setPhase(overlay, { validate: false });
		return previous;
	}

	protected restorePhase(previous: AgentLoopState): void {
		this.setPhase(previous, { validate: false });
	}

	protected onPhaseChange(_previous: AgentLoopState, _next: AgentLoopState): void {}

	protected onInvalidPhaseTransition(
		_previous: AgentLoopState,
		_next: AgentLoopState,
		_allowed: readonly AgentLoopState[],
	): void {}

	protected beforeRun(): Promise<void> | void {}

	protected afterRun(): Promise<void> | void {}

	protected async runTurn(input: {
		turn: number;
		frame: PreparedLoopFrame;
		currentDebug: LoopContextAssemblyResult["debug"];
		tracer: ReturnType<typeof trace.getTracer>;
		loopCtx: ReturnType<typeof context.active>;
		loopSpan: Span;
	}): Promise<LoopDecisionOutcome> {
		const { turn, frame, currentDebug, tracer, loopCtx, loopSpan } = input;
		if (this.shouldAbort()) {
			await this.recordTurn({
				threadId: this.loopConfig.threadId,
				taskId: this.loopConfig.taskId,
				modelId: frame.resolution.modelId,
				response: this.parseResponseChunks([]),
				status: "aborted",
				contextDebug: currentDebug,
			});
			return {
				action: "return",
				result: this.result({ yielded: this.shouldYield() || undefined }),
			};
		}
		if (this.shouldYield()) {
			return { action: "return", result: this.result({ yielded: true }) };
		}

		const turnSpan = tracer.startSpan(
			"loop.turn",
			{
				attributes: {
					"thread.id": this.loopConfig.threadId,
					"task.id": this.loopConfig.taskId ?? "",
					"model.id": frame.resolution.modelId,
					"loop.turn": turn,
				},
			},
			loopCtx,
		);
		const chunks: StreamChunk[] = [];
		// Activate the turn span as the current context for the whole turn body so
		// downstream spans (model call, tool dispatch) nest under loop.turn.
		const turnCtx = trace.setSpan(loopCtx, turnSpan);
		try {
			return await context.with(turnCtx, async (): Promise<LoopDecisionOutcome> => {
				await this.beforeTurn(turn, frame);
				const callOutcome = await this.callModelForTurn(frame, chunks, turn, currentDebug, {
					loopSpan,
					turnSpan,
				});
				if (callOutcome.action !== "continue") {
					return callOutcome;
				}

				const parsed = this.parseResponseChunks(chunks);
				const parseDecision = await this.afterParse(parsed, frame, turn);
				const turnId = await this.recordParsedTurn(parsed, frame, currentDebug, turnSpan);
				const recordDecision = await this.afterRecord(parsed, frame, turnId, turn);
				const lengthDecision = this.checkLengthRetry(parsed);
				const decision =
					recordDecision.action !== "continue"
						? recordDecision
						: lengthDecision.action !== "continue"
							? lengthDecision
							: parseDecision;
				const decisionOutcome = await this.applyTurnDecision(decision, { loopSpan, turnSpan });
				if (decisionOutcome.action !== "continue") {
					return decisionOutcome;
				}

				if (parsed.toolCalls.length === 0) {
					await this.handleFinalResponse(parsed, frame);
					turnSpan.setStatus({ code: SpanStatusCode.OK });
					turnSpan.end();
					return { action: "return", result: this.result() };
				}

				const toolDecision = await this.handleToolCalls(parsed, frame, turn);
				const toolOutcome = await this.applyTurnDecision(toolDecision, { loopSpan, turnSpan });
				if (toolOutcome.action !== "continue") {
					return toolOutcome;
				}
				turnSpan.setStatus({ code: SpanStatusCode.OK });
				turnSpan.end();
				return { action: "continue" };
			});
		} catch (error) {
			return {
				action: "return",
				result: await this.handleTurnError(error, frame, chunks, currentDebug, {
					loopSpan,
					turnSpan,
				}),
			};
		}
	}

	protected async callModelForTurn(
		frame: PreparedLoopFrame,
		chunks: StreamChunk[],
		turn: number,
		currentDebug: LoopContextAssemblyResult["debug"],
		spans: LoopDecisionSpans,
	): Promise<LoopDecisionOutcome> {
		try {
			chunks.push(...(await this.callModel(frame, turn)));
			return { action: "continue" };
		} catch (error) {
			const decision = await this.handleModelError(error, frame, chunks, turn);
			if (decision.action === "continue") {
				throw error;
			}
			// A handled terminal model error (e.g. a host that salvaged a partial
			// response and returned { action: "error" }) still bypasses
			// handleTurnError, so record the failed/aborted turn here for
			// observability. Parses any partial chunks for token attribution.
			if (decision.action === "error") {
				await this.recordTurn({
					threadId: this.loopConfig.threadId,
					taskId: this.loopConfig.taskId,
					modelId: frame.resolution.modelId,
					response: this.parseResponseChunks(chunks),
					status: this.aborted ? "aborted" : "error",
					contextDebug: currentDebug,
				});
			}
			return this.applyTurnDecision(decision, spans);
		}
	}

	protected async recordParsedTurn(
		parsed: ParsedResponse,
		frame: PreparedLoopFrame,
		currentDebug: LoopContextAssemblyResult["debug"],
		turnSpan: Span,
	): Promise<string | null> {
		const turnId = await this.recordTurn({
			threadId: this.loopConfig.threadId,
			taskId: this.loopConfig.taskId,
			modelId: frame.resolution.modelId,
			response: parsed,
			// A mid-stream abort breaks collection before the done chunk, leaving a
			// 0/0 parse. Recording that as success pollutes status='ok' metrics, so
			// mark it aborted; afterParse still runs to emit any cancel notice.
			status: this.shouldAbort() ? "aborted" : "success",
			contextDebug: currentDebug,
		});
		const thinkingChars = parsed.thinking?.length ?? 0;
		turnSpan.setAttributes({
			"turn.id": turnId ?? "",
			"llm.input_tokens": parsed.usage.inputTokens,
			"llm.output_tokens": parsed.usage.outputTokens,
			"llm.cache_read_tokens": parsed.usage.cacheReadTokens ?? 0,
			"llm.cache_write_tokens": parsed.usage.cacheWriteTokens ?? 0,
			"llm.thinking_chars": thinkingChars,
			"context.messages_in_flight": frame.messages.length,
		});
		return turnId;
	}

	protected async handleTurnError(
		error: unknown,
		frame: PreparedLoopFrame,
		chunks: StreamChunk[],
		currentDebug: LoopContextAssemblyResult["debug"],
		spans: Required<LoopDecisionSpans>,
	): Promise<AgentLoopResult> {
		const message = error instanceof Error ? error.message : String(error);
		await this.recordTurn({
			threadId: this.loopConfig.threadId,
			taskId: this.loopConfig.taskId,
			modelId: frame.resolution.modelId,
			response: this.parseResponseChunks(chunks),
			status: this.aborted ? "aborted" : "error",
			contextDebug: currentDebug,
		});
		await this.persistAlert(`Loop error: ${message}`);
		spans.turnSpan.setStatus({ code: SpanStatusCode.ERROR, message });
		spans.turnSpan.end();
		spans.loopSpan.setStatus({ code: SpanStatusCode.ERROR, message });
		return this.result({ error: message });
	}

	protected async applyTurnDecision(
		decision: LoopTurnDecision,
		spans: LoopDecisionSpans = {},
	): Promise<LoopDecisionOutcome> {
		switch (decision.action) {
			case "continue":
				return { action: "continue" };
			case "retry":
				spans.turnSpan?.setStatus({ code: SpanStatusCode.OK });
				spans.turnSpan?.end();
				return { action: "retry" };
			case "yield":
				spans.turnSpan?.setStatus({ code: SpanStatusCode.OK });
				spans.turnSpan?.end();
				return { action: "return", result: this.result({ yielded: true }) };
			case "stop":
				spans.turnSpan?.setStatus({ code: SpanStatusCode.OK });
				spans.turnSpan?.end();
				return { action: "return", result: this.result() };
			case "error":
				spans.turnSpan?.setStatus({ code: SpanStatusCode.ERROR, message: decision.error });
				spans.turnSpan?.end();
				spans.loopSpan?.setStatus({ code: SpanStatusCode.ERROR, message: decision.error });
				return { action: "return", result: this.result({ error: decision.error }) };
		}
	}

	protected beforeTurn(_turn: number, _frame: PreparedLoopFrame): Promise<void> | void {}

	protected afterParse(
		_parsed: ParsedResponse,
		_frame: PreparedLoopFrame,
		_turn: number,
	): Promise<LoopTurnDecision> | LoopTurnDecision {
		return { action: "continue" };
	}

	protected afterRecord(
		_parsed: ParsedResponse,
		_frame: PreparedLoopFrame,
		_turnId: string | null,
		_turn: number,
	): Promise<LoopTurnDecision> | LoopTurnDecision {
		return { action: "continue" };
	}

	protected resolveModel(): LoopModelResolution | Promise<LoopModelResolution> {
		return this.loopExtensions.resolveModel(this.loopConfig.modelId);
	}

	protected async prepareFrame(input: {
		resolution: PreparedLoopFrame["resolution"];
	}): Promise<Omit<PreparedLoopFrame, "resolution">> {
		const registeredTools = this.loopConfig.noTools
			? []
			: this.loopExtensions.listTools(this.loopConfig);
		const toolDefinitions: ToolDefinition[] = registeredTools.map((tool) => tool.toolDefinition);
		const assembled = await this.assembleContext({
			config: this.loopConfig,
			modelId: input.resolution.modelId,
			contextWindow: input.resolution.max_context ?? 200_000,
			tools: toolDefinitions.length > 0 ? toolDefinitions : undefined,
		});
		return {
			assembled,
			messages: [...assembled.messages],
			toolDefinitions,
		};
	}

	protected assembleContext(input: LoopContextAssemblyInput): Promise<LoopContextAssemblyResult> {
		return this.loopExtensions.assembleContext(input);
	}

	protected async callModel(frame: PreparedLoopFrame, _turn: number): Promise<StreamChunk[]> {
		const chunks: StreamChunk[] = [];
		let attempt = 0;
		for (;;) {
			await this.beforeModelStreamAttempt(frame, _turn, attempt);
			try {
				const stream = await this.openModelStream(frame, _turn, attempt);
				await this.collectModelStream(stream, chunks, frame, _turn, attempt);
				await this.afterModelStreamComplete(chunks, frame, _turn, attempt);
				return chunks;
			} catch (error) {
				await this.afterModelStreamError(error, chunks, frame, _turn, attempt);
				if (await this.shouldRetryModelStreamError(error, chunks, frame, _turn, attempt)) {
					attempt++;
					chunks.length = 0;
					continue;
				}
				throw error;
			}
		}
	}

	protected beforeModelStreamAttempt(
		_frame: PreparedLoopFrame,
		_turn: number,
		_attempt: number,
	): Promise<void> | void {}

	protected async openModelStream(
		frame: PreparedLoopFrame,
		_turn: number,
		_attempt: number,
	): Promise<LoopModelStream> {
		if (!frame.resolution.backend) {
			throw new Error("Loop model resolution did not provide a backend");
		}
		return {
			chunks: frame.resolution.backend.chat({
				messages: frame.messages,
				system: frame.assembled.systemPrompt || undefined,
				tools: frame.toolDefinitions.length > 0 ? frame.toolDefinitions : undefined,
				max_tokens: this.effectiveMaxOutputTokens(),
				signal: this.loopConfig.abortSignal,
			}),
			silenceTimeoutMs: this.loopOptions.silenceTimeoutMs ?? DEFAULT_SILENCE_TIMEOUT_MS,
			onSilenceHeartbeat: this.loopConfig.onActivity,
		};
	}

	protected async collectModelStream(
		stream: LoopModelStream,
		chunks: StreamChunk[],
		frame: PreparedLoopFrame,
		turn: number,
		attempt: number,
	): Promise<void> {
		const source =
			stream.useSilenceTimeout === false
				? stream.chunks
				: this.withSilenceTimeout(
						stream.chunks,
						stream.silenceTimeoutMs ??
							this.loopOptions.silenceTimeoutMs ??
							DEFAULT_SILENCE_TIMEOUT_MS,
						stream.onSilenceHeartbeat ?? this.loopConfig.onActivity,
					);
		for await (const chunk of source) {
			if (this.shouldAbort()) break;
			if (this.shouldYield()) {
				this.onModelStreamYield(frame, turn, attempt);
				this.aborted = true;
				break;
			}
			if (chunk.type === "heartbeat") {
				this.loopConfig.onActivity?.();
				continue;
			}
			await this.afterModelStreamChunk(chunk, chunks, frame, turn, attempt);
			this.loopConfig.onStreamChunk?.(chunk);
			chunks.push(chunk);
		}
	}

	protected afterModelStreamChunk(
		_chunk: StreamChunk,
		_chunks: StreamChunk[],
		_frame: PreparedLoopFrame,
		_turn: number,
		_attempt: number,
	): Promise<void> | void {}

	protected afterModelStreamComplete(
		_chunks: StreamChunk[],
		_frame: PreparedLoopFrame,
		_turn: number,
		_attempt: number,
	): Promise<void> | void {}

	protected afterModelStreamError(
		_error: unknown,
		_chunks: StreamChunk[],
		_frame: PreparedLoopFrame,
		_turn: number,
		_attempt: number,
	): Promise<void> | void {}

	protected shouldRetryModelStreamError(
		_error: unknown,
		_chunks: StreamChunk[],
		_frame: PreparedLoopFrame,
		_turn: number,
		_attempt: number,
	): Promise<boolean> | boolean {
		return false;
	}

	protected onModelStreamYield(_frame: PreparedLoopFrame, _turn: number, _attempt: number): void {}

	/**
	 * Generic model-error recovery. First retries transient transport faults with
	 * exponential backoff (5xx) or no backoff (timeouts), bounded by
	 * maxTransientRetries. On a rate-limit/quota condition, delegates to the
	 * overridable onRateLimitError hook (host model-router fallback policy).
	 * Everything else is terminal via onModelErrorTerminal.
	 *
	 * Returning { action: "continue" } means "I did not handle this" — the base
	 * turn loop then rethrows the original error so it surfaces as a turn failure.
	 */
	protected async handleModelError(
		error: unknown,
		frame: PreparedLoopFrame,
		chunks: StreamChunk[],
		_turn: number,
	): Promise<LoopTurnDecision> {
		const maxTransientRetries =
			this.loopOptions.maxTransientRetries ?? DEFAULT_MAX_TRANSIENT_RETRIES;
		if (isTransientLLMError(error) && this.transportRetries < maxTransientRetries) {
			this.transportRetries++;
			const statusCode = getLlmStatusCode(error);
			const isServerFault = statusCode !== undefined && statusCode >= 500;
			const backoffMs = isServerFault ? 1000 * 2 ** (this.transportRetries - 1) : 0;
			this.loopExtensions.context.logger.warn("[loop] Transient model error, retrying", {
				attempt: this.transportRetries,
				max: maxTransientRetries,
				backoffMs,
				statusCode: statusCode ?? null,
				error: error instanceof Error ? error.message : String(error),
			});
			if (backoffMs > 0) {
				await new Promise((resolve) => setTimeout(resolve, backoffMs));
			}
			return { action: "retry" };
		}

		const message = error instanceof Error ? error.message : String(error);
		if (isRateLimitStatus(getLlmStatusCode(error), message)) {
			const rateLimitDecision = await this.onRateLimitError(error, frame);
			if (rateLimitDecision) {
				return rateLimitDecision;
			}
		}

		return this.onModelErrorTerminal(error, chunks, frame);
	}

	/**
	 * Host hook for rate-limit / quota / payment errors. Return a decision
	 * (typically { action: "retry" } after swapping to a fallback backend) to
	 * recover, or null to fall through to terminal handling. Default: no
	 * fallback available.
	 */
	protected onRateLimitError(
		_error: unknown,
		_frame: PreparedLoopFrame,
	): Promise<LoopTurnDecision | null> | LoopTurnDecision | null {
		return null;
	}

	/**
	 * Terminal model-error handling once retries and fallback are exhausted.
	 * Default returns { action: "continue" }, signalling "not specially handled"
	 * — the base turn loop then rethrows the original error into handleTurnError,
	 * which records the failed turn and persists a "Loop error: …" alert. Hosts
	 * override to salvage partial responses, emit richer alerts, and return an
	 * explicit { action: "error" } to take over terminal handling.
	 */
	protected onModelErrorTerminal(
		_error: unknown,
		_chunks: StreamChunk[],
		_frame: PreparedLoopFrame,
	): Promise<LoopTurnDecision> | LoopTurnDecision {
		return { action: "continue" };
	}

	/**
	 * Length-retry mechanism: when a turn truncates at the output-token limit
	 * (finishReason="length") having produced only thinking — no text, no tool
	 * calls — the model never got to its answer. Bump the output-token budget and
	 * retry, bounded by lengthRetryMax. Generic: pure token-budget math, no host
	 * dependencies.
	 */
	protected checkLengthRetry(parsed: ParsedResponse): LoopTurnDecision {
		const lengthRetryMax = this.loopOptions.lengthRetryMax ?? DEFAULT_LENGTH_RETRY_MAX;
		const onlyThinking =
			parsed.finishReason === "length" &&
			parsed.toolCalls.length === 0 &&
			!parsed.textContent &&
			Boolean(parsed.thinking || parsed.thinkingRedactedData || parsed.thinkingEncryptedContent);
		if (!onlyThinking || this.lengthRetries >= lengthRetryMax) {
			return { action: "continue" };
		}
		this.lengthRetries++;
		const cap = this.loopOptions.lengthRetryCap ?? DEFAULT_LENGTH_RETRY_CAP;
		const start = this.loopOptions.lengthRetryStart ?? DEFAULT_LENGTH_RETRY_START;
		const prevMax = this.effectiveMaxOutputTokens();
		this.outputTokenOverride = prevMax ? Math.min(prevMax * 2, cap) : start;
		this.loopExtensions.context.logger.warn(
			"[loop] Output token limit hit during thinking, retrying with larger budget",
			{
				previousMaxTokens: prevMax ?? null,
				newMaxTokens: this.outputTokenOverride,
				retry: this.lengthRetries,
				maxRetries: lengthRetryMax,
			},
		);
		return { action: "retry" };
	}

	protected async handleFinalResponse(
		parsed: ParsedResponse,
		frame: PreparedLoopFrame,
	): Promise<void> {
		if (parsed.textContent || parsed.thinking || parsed.thinkingEncryptedContent) {
			const content = this.buildAssistantToolCallBlocks(
				parsed.textContent,
				{
					thinking: parsed.thinking,
					signature: parsed.thinkingSignature,
					redactedData: parsed.thinkingRedactedData,
					encryptedContent: parsed.thinkingEncryptedContent,
				},
				[],
			);
			await this.persistAssistantResponse(
				content.length > 0 ? content : parsed.textContent,
				frame.resolution.modelId,
			);
			this.messagesCreated++;
		}
	}

	protected async handleToolCalls(
		parsed: ParsedResponse,
		frame: PreparedLoopFrame,
		turn: number,
	): Promise<LoopTurnDecision> {
		const preGuardDecision = this.runPreExecutionGuards(parsed);
		if (preGuardDecision.action !== "continue") {
			return preGuardDecision;
		}

		const beforeDecision = await this.beforeToolRoundTrip(parsed, frame, turn);
		if (beforeDecision.action !== "continue") {
			return beforeDecision;
		}

		const batch = await this.executeToolRoundTrip(parsed, frame, turn);
		this.recordToolErrorSignatures(batch);
		const executionDecision = await this.afterToolExecution(parsed, frame, batch, turn);
		if (executionDecision.action !== "continue") {
			return executionDecision;
		}

		await this.persistToolMessages(parsed, frame, batch, turn);
		const persistenceDecision = await this.afterToolPersistence(parsed, frame, batch, turn);
		if (persistenceDecision.action !== "continue") {
			return persistenceDecision;
		}
		return this.runPostExecutionGuards(batch, frame);
	}

	/**
	 * Pre-execution circuit breakers: abort runaway loops where the model keeps
	 * emitting truncated tool calls or byte-identical calls turn after turn.
	 * Runs before any tool executes, so it costs nothing when it fires.
	 */
	protected runPreExecutionGuards(parsed: ParsedResponse): LoopTurnDecision {
		const firstTruncated = parsed.toolCalls.find((tc) => tc.truncated);
		if (firstTruncated) {
			if (this.lastTruncatedToolName === firstTruncated.name) {
				this.consecutiveTruncatedTurns++;
			} else {
				this.consecutiveTruncatedTurns = 1;
				this.lastTruncatedToolName = firstTruncated.name;
			}
			if (this.consecutiveTruncatedTurns >= this.guardThresholds.maxConsecutiveTruncatedTurns) {
				this.onLoopGuardTripped(
					"truncated",
					`[Agent loop aborted] Detected ${this.consecutiveTruncatedTurns} consecutive turns with truncated "${firstTruncated.name}" tool calls. Aborting to prevent runaway token usage.`,
				);
				return { action: "stop" };
			}
		} else {
			this.consecutiveTruncatedTurns = 0;
			this.lastTruncatedToolName = null;
		}

		const turnSignature = toolCallSignature(parsed.toolCalls);
		if (this.lastToolCallSignature === turnSignature) {
			this.consecutiveDuplicateToolCalls++;
		} else {
			this.consecutiveDuplicateToolCalls = 1;
			this.lastToolCallSignature = turnSignature;
		}
		if (
			this.consecutiveDuplicateToolCalls >= this.guardThresholds.maxConsecutiveDuplicateToolCalls
		) {
			const dupToolNames = [...new Set(parsed.toolCalls.map((tc) => tc.name))].join(", ");
			this.onLoopGuardTripped(
				"duplicate",
				`[Agent loop aborted] Detected ${this.consecutiveDuplicateToolCalls} consecutive turns issuing the identical tool call(s) ("${dupToolNames}"). Aborting to prevent runaway token usage.`,
			);
			return { action: "stop" };
		}

		return { action: "continue" };
	}

	/**
	 * Update the identical-error and routing-error signature chains from a
	 * completed tool batch. The routing chain only advances for results the host
	 * classifies as routing errors (classifyToolResultError); the base classifier
	 * never returns "routing", so the routing breaker is inert unless overridden.
	 */
	protected recordToolErrorSignatures(batch: LoopToolExecutionBatch): void {
		const results = batch.results;
		const turnErrorSignature = toolErrorSignature(results);
		if (turnErrorSignature !== null && turnErrorSignature === this.lastErrorSignature) {
			this.consecutiveErrorSignature++;
		} else {
			this.consecutiveErrorSignature = turnErrorSignature !== null ? 1 : 0;
			this.lastErrorSignature = turnErrorSignature;
			this.errorNudgeInjected = false;
		}

		const allRoutingErrors =
			results.length > 0 &&
			results.every((r) => this.classifyToolResultError(r.result) === "routing");
		const turnRoutingErrorSignature = allRoutingErrors ? toolErrorSignature(results) : null;
		if (
			turnRoutingErrorSignature !== null &&
			turnRoutingErrorSignature === this.lastRoutingErrorSignature
		) {
			this.consecutiveRoutingErrorSignature++;
		} else {
			this.consecutiveRoutingErrorSignature = turnRoutingErrorSignature !== null ? 1 : 0;
			this.lastRoutingErrorSignature = turnRoutingErrorSignature;
		}
	}

	/**
	 * Post-execution circuit breakers: hard-abort on a routing-error or
	 * identical-error chain, and inject a single corrective nudge before the
	 * generic error abort. Runs after persistence so tool results are recorded.
	 */
	protected runPostExecutionGuards(
		batch: LoopToolExecutionBatch,
		frame: PreparedLoopFrame,
	): LoopTurnDecision {
		const results = batch.results;
		if (
			this.consecutiveRoutingErrorSignature >=
			this.guardThresholds.maxConsecutiveRoutingErrorToolCalls
		) {
			const lastResult = results[results.length - 1];
			const errToolNames = [...new Set(results.map((r) => r.toolCall.name))].join(", ");
			this.onLoopGuardTripped(
				"routing-error",
				`[Agent loop aborted] The "${errToolNames}" tool returned a cross-tool routing error ${this.consecutiveRoutingErrorSignature} turns in a row. Last error: ${truncateForNudge(lastResult?.result.content ?? "")}`,
			);
			return { action: "stop" };
		}
		if (this.consecutiveErrorSignature >= this.guardThresholds.maxConsecutiveErrorToolCalls) {
			const lastResult = results[results.length - 1];
			const errToolNames = [...new Set(results.map((r) => r.toolCall.name))].join(", ");
			this.onLoopGuardTripped(
				"identical-error",
				`[Agent loop aborted] The "${errToolNames}" tool returned the identical error ${this.consecutiveErrorSignature} turns in a row. Last error: ${truncateForNudge(lastResult?.result.content ?? "")}`,
			);
			return { action: "stop" };
		}
		if (
			!this.errorNudgeInjected &&
			this.consecutiveErrorSignature >= this.guardThresholds.errorSignatureNudgeAt
		) {
			const lastResult = results[results.length - 1];
			const errToolNames = [...new Set(results.map((r) => r.toolCall.name))].join(", ");
			const nudge = `[Loop guard] The "${errToolNames}" tool has returned the same error ${this.consecutiveErrorSignature} times in a row. Stop and re-read the error. Error: ${truncateForNudge(lastResult?.result.content ?? "")}`;
			this.emitLoopGuardNudge(nudge);
			// Inject into the live message array too, so the model actually reads
			// the corrective nudge on the next turn — not just the persisted log.
			frame.messages.push({ role: "developer", content: nudge });
			this.errorNudgeInjected = true;
		}
		return { action: "continue" };
	}

	/**
	 * Notify that a circuit breaker tripped and the loop is stopping. Default
	 * surfaces the message as an alert so resilient extension agents see trips
	 * without extra wiring; hosts override to persist a developer message, etc.
	 */
	protected onLoopGuardTripped(_reason: LoopGuardReason, detail: string): void {
		void this.persistAlert(detail);
	}

	/**
	 * Emit the one-shot corrective nudge before a hard error abort. Default
	 * surfaces it as an alert; hosts override to inject a developer message into
	 * the conversation so the model actually sees it next turn.
	 */
	protected emitLoopGuardNudge(detail: string): void {
		void this.persistAlert(detail);
	}

	/**
	 * Classify a tool result for the error-chain breakers. The base loop has no
	 * cross-tool routing knowledge, so it only distinguishes generic errors from
	 * success. Hosts override to detect routing/redirect errors and arm the
	 * short-fuse routing breaker.
	 */
	protected classifyToolResultError(result: ToolExecutionResult): ToolResultErrorKind {
		return result.exitCode !== 0 ? "generic" : null;
	}

	protected beforeToolRoundTrip(
		_parsed: ParsedResponse,
		_frame: PreparedLoopFrame,
		_turn: number,
	): Promise<LoopTurnDecision> | LoopTurnDecision {
		return { action: "continue" };
	}

	protected async executeToolRoundTrip(
		parsed: ParsedResponse,
		_frame: PreparedLoopFrame,
		_turn: number,
	): Promise<LoopToolExecutionBatch> {
		const results: LoopToolResult[] = [];
		for (const toolCall of parsed.toolCalls) {
			this.toolCallsMade++;
			const result = await this.executeTool(toolCall);
			results.push({ toolCall, result });
		}
		return { results, deferred: [] };
	}

	protected afterToolExecution(
		_parsed: ParsedResponse,
		_frame: PreparedLoopFrame,
		_batch: LoopToolExecutionBatch,
		_turn: number,
	): Promise<LoopTurnDecision> | LoopTurnDecision {
		return { action: "continue" };
	}

	protected async persistToolMessages(
		parsed: ParsedResponse,
		frame: PreparedLoopFrame,
		batch: LoopToolExecutionBatch,
		_turn: number,
	): Promise<void> {
		const assistantBlocks = this.buildAssistantToolCallBlocks(
			parsed.textContent,
			{
				thinking: parsed.thinking,
				signature: parsed.thinkingSignature,
				redactedData: parsed.thinkingRedactedData,
				encryptedContent: parsed.thinkingEncryptedContent,
			},
			parsed.toolCalls,
		);
		frame.messages.push({ role: "tool_call", content: assistantBlocks });

		await this.persistToolRoundTrip({
			modelId: frame.resolution.modelId,
			assistantBlocks,
			results: batch.results,
		});
		this.messagesCreated++;
		for (const { toolCall, result } of batch.results) {
			frame.messages.push({
				role: "tool_result",
				content: textFromToolResult(result),
				tool_use_id: toolCall.id,
			});
			this.messagesCreated++;
		}
	}

	protected afterToolPersistence(
		_parsed: ParsedResponse,
		_frame: PreparedLoopFrame,
		_batch: LoopToolExecutionBatch,
		_turn: number,
	): Promise<LoopTurnDecision> | LoopTurnDecision {
		return { action: "continue" };
	}

	protected executeTool(toolCall: ParsedToolCall): Promise<ToolExecutionResult> {
		return this.loopExtensions.executeTool(toolCall);
	}

	protected recordTurn(metrics: LoopTurnMetrics): Promise<string | null> | string | null {
		return this.loopExtensions.persistence.recordTurn(metrics);
	}

	protected persistAssistantResponse(
		content: string | ContentBlock[],
		modelId: string,
	): Promise<void> | void {
		return this.loopExtensions.persistence.persistAssistantResponse(content, modelId);
	}

	protected persistToolRoundTrip(input: {
		modelId: string;
		assistantBlocks: ContentBlock[];
		results: Array<{ toolCall: ParsedToolCall; result: ToolExecutionResult }>;
	}): Promise<void> | void {
		return this.loopExtensions.persistence.persistToolRoundTrip(input);
	}

	protected persistAlert(content: string): Promise<void> | void {
		return this.loopExtensions.persistence.persistAlert(content);
	}

	protected shouldAbort(): boolean {
		return this.aborted;
	}

	protected shouldYield(): boolean {
		return this.loopConfig.shouldYield?.() === true;
	}

	protected parseResponseChunks(chunks: StreamChunk[]) {
		return parseResponseChunks(chunks, { logger: this.loopExtensions.context.logger });
	}

	protected withSilenceTimeout<T>(
		source: AsyncIterable<T>,
		timeoutMs: number,
		onHeartbeat?: () => void,
	): AsyncGenerator<T> {
		return withSilenceTimeout(source, timeoutMs, onHeartbeat);
	}

	protected buildAssistantToolCallBlocks(
		textContent: string,
		thinking: {
			thinking: string | null;
			signature: string | null;
			redactedData: string | null;
			encryptedContent: string | null;
		},
		toolCalls: Array<{ id: string; name: string; input: Record<string, unknown> }>,
	): ContentBlock[] {
		return buildAssistantToolCallBlocks(textContent, thinking, toolCalls);
	}

	protected result(extra: Partial<AgentLoopResult> = {}): AgentLoopResult {
		const result = {
			messagesCreated: this.messagesCreated,
			toolCallsMade: this.toolCallsMade,
			filesChanged: 0,
			...extra,
		};
		void this.loopExtensions.afterRun?.(result);
		return result;
	}
}
