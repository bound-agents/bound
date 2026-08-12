import type { AppContext } from "@bound/core";
import {
	countBackgroundToolCallsByThread,
	enqueueClientToolCall,
	enqueueToolResult,
	findMessageById,
	getLatestChangeLogHlcForRows,
	listLiveMessageProjectionByThreadNewestFirst,
	markProcessed,
	readInboxByRefId,
	recordContextDebug,
	recordTurn,
	recordTurnRelayMetrics,
	resolveRelayConfig,
	updateRow,
	writeMessageMetadata,
	writeOutbox,
} from "@bound/core";
import type {
	ContentBlock,
	LLMBackend,
	ModelRouter,
	StreamChunk,
	ToolDefinition,
} from "@bound/llm";
import type { InferenceRequestPayload } from "@bound/llm";
import {
	type LoopExtensions,
	type LoopGuardReason,
	type LoopModelStream,
	type LoopToolExecutionBatch,
	type LoopTurnDecision,
	ModularAgentLoop,
	type ParsedResponse,
	type ParsedToolCall,
	type PreparedLoopFrame,
	SILENCE_HEARTBEAT_INTERVAL_MS,
	type ToolExecutionResult,
	type ToolResultErrorKind,
	getLlmRetryAfterMs,
	getLlmStatusCode,
	scaledMaxRetries,
	scaledSilenceTimeout,
	shouldRetryRelayCall,
} from "@bound/loop";
import type { McpAppBinding } from "@bound/sandbox";
import type { ClientToolPayload, ContextDebugInfo, EventMap, SyncConfig } from "@bound/shared";
import {
	HLC_ZERO,
	appendToolDuration,
	capToolResultContent,
	clientResultPayloadSchema,
	errorPayloadSchema,
	formatError,
	injectTraceContext,
	parseJsonSafe,
} from "@bound/shared";
import { getConfirmedSyncWatermark } from "@bound/sync";
import type { Context, Span } from "@opentelemetry/api";
import { SpanStatusCode, context, trace } from "@opentelemetry/api";

import {
	Observable,
	Subject,
	TimeoutError,
	catchError,
	defer,
	filter,
	firstValueFrom,
	map,
	merge,
	of,
	race,
	take,
	throwError,
	timeout,
} from "rxjs";

import {
	buildCommandOutput,
	calculateTurnCost,
	clampMaxOutputTokens,
	createFileRefResolver,
	deriveCapabilityRequirements,
	getResolvedModelId,
	insertThreadMessage,
	parseContentBlocks,
} from "./agent-loop-utils";
import type { selectCacheTtl } from "./cache-prediction";
import { applyActualUsageToContextDebug } from "./context-assembly";
import { resolveClientSessionHost } from "./delegation";
import { segmentAssembledMessages } from "./delegation-segments";
import { trackFilePath } from "./file-thread-tracker";
import { type RelayToolCallRequest, isRelayRequest } from "./mcp-bridge";
import { type ModelResolution, resolveModel, resolveSameTierFallback } from "./model-resolution";
import { createRelayBackend } from "./relay-backend";
import { type EligibleHost, createRelayOutboxEntry } from "./relay-router";
import { createRelayStream$ } from "./relay-stream$";
import { type RelayWaitResult, createRelayWait$ } from "./relay-wait$";
import { fromEventBus } from "./rx-utils";
import { persistImageBlocksAsFileRefs } from "./tool-result-images";
import {
	TOOL_RESULT_OFFLOAD_THRESHOLD,
	buildOffloadMessage,
	offloadToolResultPath,
} from "./tool-result-offload";
import { suggestCorrectTool } from "./tools/tool-suggestion";
import type {
	AgentLoopConfig,
	AgentLoopResult,
	AgentLoopState,
	ClientToolCallRequest,
	DeferredToolResult,
} from "./types";
import { isClientToolCallRequest, isDeferredToolResult, isToolResultWithMetadata } from "./types";
// Thinking-block compaction now lives exclusively in context-assembly.ts (Stage 1.7).
// The warm path no longer mutates stored messages — see agent-loop.ts step 3a comment.

export const SILENCE_TIMEOUT_MS = 600_000;
export const MAX_SILENCE_RETRIES = 3;

export const THINK_TOOL_DEFINITION: ToolDefinition = {
	type: "function",
	function: {
		name: "think",
		description:
			"Use this optional scratchpad to reason through a problem before acting. " +
			"It has no external effect; put the reasoning in `thought`.",
		parameters: {
			type: "object",
			properties: { thought: { type: "string" } },
			required: ["thought"],
			additionalProperties: false,
		},
	},
};
export const THINK_TOOL_RESULT = "Thinking complete - please continue your work.";

/**
 * Max retries for a degenerate turn — one producing no actionable output (no
 * tool call and no text), whether truncated at the output-token limit
 * (finishReason "length") or cut off by a dropped stream.
 */
export const MAX_DEGENERATE_RETRIES = 2;

/** Lazily get the tracer to ensure tests can register their provider first */
function getTracer() {
	return trace.getTracer("bound.agent-loop");
}

// Tool-call circuit-breaker thresholds now live in @bound/loop (loop-guards.ts)
// so any agent on the base loop inherits them. Re-exported here for the agent
// test suite and external callers that import them from this module.
export {
	MAX_CONSECUTIVE_TRUNCATED_TURNS,
	MAX_CONSECUTIVE_DUPLICATE_TOOL_CALLS,
	MAX_CONSECUTIVE_ERROR_TOOL_CALLS,
	ERROR_SIGNATURE_NUDGE_AT,
	MAX_CONSECUTIVE_ROUTING_ERROR_TOOL_CALLS,
} from "@bound/loop";

/**
 * Matches the cross-tool routing suggestion produced by `suggestCorrectTool`
 * (e.g. calling `connector` with `action: "activate"`, which belongs to
 * `skill`). When the suggester names the correct tool, the model is not just
 * stuck — it is ignoring explicit corrective guidance, so the base loop's
 * routing-error breaker (short fuse) should arm. Bound-specific: the marker
 * string is defined by this repo's tool-suggestion text.
 */
const ROUTING_SUGGESTION_MARKER = /is valid for the "[^"]+" tool, not "[^"]+"\. Call /;

function createBoundLoopExtensions(
	ctx: AppContext,
	modelRouter: ModelRouter,
	config: AgentLoopConfig,
): LoopExtensions {
	return {
		context: {
			siteId: ctx.siteId,
			hostName: ctx.hostName,
			logger: ctx.logger,
		},
		modelRouter,
		resolveModel: () => ({ kind: "error", error: "BoundAgentLoop uses adapter model resolution" }),
		assembleContext: async () => {
			throw new Error("BoundAgentLoop uses adapter context assembly");
		},
		listTools: () => [],
		executeTool: async () => {
			throw new Error("BoundAgentLoop uses adapter tool dispatch");
		},
		persistence: {
			recordTurn: async () => null,
			persistAssistantResponse: async () => {},
			persistToolRoundTrip: async () => {},
			persistAlert: async (content) => {
				ctx.logger.warn("[agent-loop] Base loop alert hook invoked by Bound adapter", {
					threadId: config.threadId,
					content,
				});
			},
		},
	};
}

function containsRoutingSuggestion(content: string): boolean {
	return ROUTING_SUGGESTION_MARKER.test(content);
}

function observableToAsyncIterable<T>(source: Observable<T>): AsyncIterable<T> {
	return {
		async *[Symbol.asyncIterator]() {
			const queue: T[] = [];
			let completed = false;
			let error: unknown;
			let wake: (() => void) | undefined;
			const notify = () => {
				wake?.();
				wake = undefined;
			};
			const subscription = source.subscribe({
				next(value) {
					queue.push(value);
					notify();
				},
				error(err) {
					error = err;
					completed = true;
					notify();
				},
				complete() {
					completed = true;
					notify();
				},
			});
			try {
				while (!completed || queue.length > 0) {
					if (queue.length > 0) {
						const value = queue.shift();
						if (value !== undefined) {
							yield value;
						}
						continue;
					}
					await new Promise<void>((resolve) => {
						wake = resolve;
					});
					if (error !== undefined) {
						throw error;
					}
				}
				if (error !== undefined) {
					throw error;
				}
			} finally {
				subscription.unsubscribe();
			}
		},
	};
}

/**
 * Default wall-clock ceiling for a single bms_bash (sandbox) command, in ms.
 * Mirrors boundless_bash's DEFAULT_TIMEOUT_MS (packages/less/src/tools/bash.ts)
 * so the two bash tools expose the same `timeout` contract and default. NOTE on
 * the residual difference: boundless_bash runs a subprocess and enforces the
 * timeout with SIGTERM/SIGKILL, whereas the sandbox is an in-process just-bash
 * interpreter — the timeout fires an AbortSignal that stops execution at the
 * next statement boundary (cooperative). It reliably bounds shell-level loops,
 * but a single synchronous python3/js-exec worker call runs to completion.
 */
const DEFAULT_SANDBOX_EXEC_TIMEOUT_MS = 300_000;

export interface BashLike {
	exec?: (
		cmd: string,
		options?: Record<string, unknown>,
	) => Promise<{ stdout: string; stderr: string; exitCode: number }>;
	writeFile?: (path: string, content: string) => Promise<void>;
	persistFs?: () => Promise<{ changes: number; changedPaths?: string[] }>;
	checkMemoryThreshold?: () => {
		overThreshold: boolean;
		usageBytes: number;
		thresholdBytes: number;
	};
	rehydrateFs?: () => Promise<void>;
	capturePreSnapshot?: () => Promise<void>;
	builtInTools?: Map<
		string,
		{
			toolDefinition: {
				type: "function";
				function: { name: string; description: string; parameters: Record<string, unknown> };
			};
			execute: (input: Record<string, unknown>) => Promise<string | ContentBlock[]>;
		}
	>;
}

export interface BoundPreparedFrame extends PreparedLoopFrame {
	resolution: Exclude<ModelResolution, { kind: "error" }> & {
		backend?: LLMBackend;
		modelId: string;
	};
	assembled: {
		messages: import("@bound/llm").LLMMessage[];
		systemPrompt: string;
		debug: ContextDebugInfo;
		/**
		 * The AssemblyClock instant (epoch ms) this frame was assembled with. The
		 * producer puts it on the inference relay payload so the consumer's
		 * `resolveSegments` annotates range segments with the identical "now",
		 * reproducing the producer's bytes (R-UD4).
		 */
		assemblyNowMs: number;
	};
	messages: import("@bound/llm").LLMMessage[];
	toolDefinitions: ToolDefinition[];
	mergedTools: ToolDefinition[] | undefined;
	relayInfo: { remoteHost: string; localHost: string; model: string; provider: string } | undefined;
	resolvedModelForDebug: string | undefined;
	resolvedCaps: ReturnType<ModelRouter["getEffectiveCapabilities"]> | undefined;
	cacheMarkerCaps:
		| ReturnType<ModelRouter["getEffectiveCapabilities"]>
		| Exclude<ModelResolution, { kind: "local" | "error" }>["hosts"][number]["capabilities"]
		| undefined;
	contextWindow: number;
	toolTokenEstimate: number;
	truncationTargetTokens: number;
	measuredInflation: number | null;
	cacheTtl: ReturnType<typeof selectCacheTtl>;
}

export class BoundAgentLoop extends ModularAgentLoop {
	private filesChanged = 0;
	private yielded = false;
	protected lastModelResolution: ModelResolution | null = null;
	protected lastContextDebug?: ContextDebugInfo;
	private loopStartTime = 0;
	private prevCacheReadTokens = 0;
	// Loop-guard state (consecutive*/last*Signature), length-retry, and
	// transport-retry counters are owned and reset by ModularAgentLoop.
	private requirements: ReturnType<typeof deriveCapabilityRequirements> | undefined;
	protected currentTurnId: string | null = null;
	protected relayMetadataRef: { hostName?: string; firstChunkLatencyMs?: number } = {};
	private latestResult: AgentLoopResult | null = null;
	private currentDriverSpan: Span | null = null;
	private currentDriverTtftRecorded = false;

	protected override onInvalidPhaseTransition(
		previous: AgentLoopState,
		next: AgentLoopState,
		allowed: readonly AgentLoopState[],
	): void {
		this.ctx.logger.warn("[agent-loop] Invalid state transition", {
			from: previous,
			to: next,
			allowed,
			threadId: this.config.threadId,
		});
	}

	/** Resolved inference relay timeout from sync.relay config, cached on first access. */
	private _inferenceTimeoutMs: number | null = null;

	constructor(
		protected ctx: AppContext,
		protected sandbox: BashLike,
		protected modelRouter: ModelRouter,
		protected config: AgentLoopConfig,
	) {
		super(createBoundLoopExtensions(ctx, modelRouter, config), config, {
			silenceTimeoutMs: SILENCE_TIMEOUT_MS,
			maxTransientRetries: MAX_SILENCE_RETRIES,
			degenerateRetryMax: MAX_DEGENERATE_RETRIES,
		});
	}

	/**
	 * Output budget used by BOTH context assembly and the wire request.
	 * Backend caps win over the provider-default fallback; remote resolutions
	 * have no cap in their synced descriptor today, so they use the explicit
	 * conservative fallback rather than omitting max_tokens.
	 */
	protected resolvedMaxOutputTokens(resolution: BoundPreparedFrame["resolution"]): number {
		const backendCap = resolution.kind === "local" ? resolution.maxOutputTokens : undefined;
		return clampMaxOutputTokens(this.effectiveMaxOutputTokens(), backendCap);
	}

	protected override beforeRun(): void {
		// Base resetResilienceState() clears loop-guard, length-retry, and
		// transport-retry counters before this runs. Reset only Bound-local state.
		this.loopStartTime = Date.now();
		this.prevCacheReadTokens = 0;
		this.requirements = undefined;
		this.currentTurnId = null;
		this.relayMetadataRef = {};
		this.latestResult = null;

		this.ctx.logger.info("[agent-loop] Starting", {
			threadId: this.config.threadId,
			taskId: this.config.taskId ?? null,
			userId: this.config.userId,
			modelHint: this.config.modelId ?? "default",
			platform: this.config.platform ?? null,
			toolCount: this.config.tools?.length ?? 0,
		});
	}

	protected override async afterRun(): Promise<void> {
		this.setPhase("FS_PERSIST");
		const fsPersistSpan = getTracer().startSpan("agent-loop.fs-persist");
		try {
			if (this.sandbox.persistFs) {
				const persistResult = await this.sandbox.persistFs();
				if (persistResult && typeof persistResult.changes === "number") {
					this.filesChanged += persistResult.changes;
					if (this.latestResult) {
						this.latestResult.filesChanged = this.filesChanged;
					}
					if (persistResult.changedPaths) {
						for (const filePath of persistResult.changedPaths) {
							try {
								trackFilePath(this.ctx.db, filePath, this.config.threadId, this.ctx.siteId);
							} catch (error) {
								this.ctx.logger.warn("Failed to track file path", {
									filePath,
									threadId: this.config.threadId,
									error: error instanceof Error ? error.message : String(error),
								});
							}
						}
					}
					if (persistResult.changes > 0) {
						this.ctx.logger.info("[agent-loop] FS persisted", {
							filesChanged: persistResult.changes,
							paths: persistResult.changedPaths?.slice(0, 10) ?? [],
						});
					}
				}
			}
		} finally {
			fsPersistSpan.end();
		}

		this.setPhase("QUEUE_CHECK");
		try {
			updateRow(
				this.ctx.db,
				"threads",
				this.config.threadId,
				{ last_message_at: new Date().toISOString() },
				this.ctx.siteId,
			);
		} catch (error) {
			this.ctx.logger.warn("Failed to update thread last_message_at", {
				threadId: this.config.threadId,
				error: error instanceof Error ? error.message : String(error),
			});
		}
		this.setPhase("IDLE");

		const totalDurationMs = Date.now() - this.loopStartTime;
		this.ctx.logger.info("[agent-loop] Completed", {
			threadId: this.config.threadId,
			taskId: this.config.taskId ?? null,
			messagesCreated: this.messagesCreated,
			toolCallsMade: this.toolCallsMade,
			filesChanged: this.filesChanged,
			totalDurationMs,
			yielded: this.yielded || false,
			aborted: this.aborted,
		});

		// Summary/memory extraction is MainAgentLoop-specific.
	}

	protected override async resolveModel(): Promise<
		BoundPreparedFrame["resolution"] | { kind: "error"; error: string }
	> {
		this.setPhase("HYDRATE_FS");
		const hydrateSpan = getTracer().startSpan("agent-loop.hydrate-fs");
		try {
			if (this.sandbox.rehydrateFs) {
				await this.sandbox.rehydrateFs();
			}
			if (this.sandbox.capturePreSnapshot) {
				await this.sandbox.capturePreSnapshot();
			}
		} finally {
			hydrateSpan.end();
		}

		this.setPhase("ASSEMBLE_CONTEXT");
		const hasTools = !!(this.config.tools && this.config.tools.length > 0);
		this.requirements = deriveCapabilityRequirements(this.ctx.db, this.config.threadId, hasTools);
		this.lastModelResolution = resolveModel(
			this.config.modelId,
			this.modelRouter,
			this.ctx.db,
			this.ctx.siteId,
			this.requirements,
		);

		if (this.lastModelResolution.kind === "error" && this.config.modelId !== undefined) {
			if (this.config.modelTier !== undefined) {
				const tierFallback = resolveSameTierFallback(
					this.config.modelId,
					this.modelRouter,
					this.ctx.db,
					this.ctx.siteId,
					this.config.modelTier,
					this.requirements,
				);
				if (tierFallback) {
					const fallbackModelId = tierFallback.kind !== "error" ? tierFallback.modelId : undefined;
					this.emitAlert(
						`Model "${this.config.modelId}" unavailable. Using same-tier (${this.config.modelTier}) alternative "${fallbackModelId}".`,
					);
					this.ctx.eventBus.emit("model:fallback", {
						requested_model: this.config.modelId,
						fallback_model: fallbackModelId ?? "unknown",
						tier: this.config.modelTier,
						thread_id: this.config.threadId,
						task_id: this.config.taskId,
						reason: this.lastModelResolution.error,
					});
					this.lastModelResolution = tierFallback;
				}
			}
			if (this.lastModelResolution.kind === "error") {
				return {
					kind: "error",
					error: `Failed to resolve requested model "${this.config.modelId}": ${this.lastModelResolution.error}`,
				};
			}
		}

		this.ctx.logger.info("[agent-loop] Model resolved", {
			kind: this.lastModelResolution.kind,
			modelId: this.lastModelResolution.kind !== "error" ? this.lastModelResolution.modelId : null,
			error: this.lastModelResolution.kind === "error" ? this.lastModelResolution.error : null,
			remoteHosts:
				this.lastModelResolution.kind === "remote" ? this.lastModelResolution.hosts.length : 0,
		});

		if (this.lastModelResolution.kind === "error") {
			return { kind: "error", error: this.lastModelResolution.error };
		}
		return this.lastModelResolution;
	}

	protected override persistAlert(content: string): void {
		this.emitAlert(content);
	}

	protected override result(extra: Partial<AgentLoopResult> = {}): AgentLoopResult {
		const result = {
			messagesCreated: this.messagesCreated,
			toolCallsMade: this.toolCallsMade,
			filesChanged: this.filesChanged,
			...extra,
		};
		this.latestResult = result;
		return result;
	}

	protected override beforeModelStreamAttempt(
		frame: BoundPreparedFrame,
		turn: number,
		attempt: number,
	): void {
		const resolution = this.lastModelResolution;
		if (!resolution || resolution.kind === "error") {
			return;
		}
		if (attempt === 0) {
			this.ctx.logger.info("[agent-loop] LLM call starting", {
				turn,
				model: getResolvedModelId(this.lastModelResolution, this.config.modelId || "unknown"),
				messageCount: frame.messages.length,
				kind: resolution.kind,
			});
		}
		this.currentDriverSpan = null;
		this.currentDriverTtftRecorded = false;
		this.config.onActivity?.();
	}

	protected override async openModelStream(
		frame: BoundPreparedFrame,
		_turn: number,
	): Promise<LoopModelStream> {
		const resolution = this.lastModelResolution;
		if (!resolution || resolution.kind === "error") {
			throw new Error(resolution?.error ?? "Model resolution not available");
		}
		if (resolution.kind === "remote") {
			// Single delegation wire format (R-UD3): ship the assembled context as
			// SEGMENTS, never raw `messages` and never a `files`-table offload. The
			// producer emits at most one range-pointer over the confirmed-synced
			// history prefix plus inline segments for the tail; a range-pointer is
			// kilobytes regardless of token count, so the >2MB offload race is gone
			// (R-UD14). A row is range-coverable only if its latest change_log HLC
			// is <= the confirmed watermark for EVERY candidate target host — the
			// conservative gate guarantees the consumer holds the row whichever host
			// the relay stream lands on (R-UD6).
			const candidateWatermarks = resolution.hosts.map((h) =>
				getConfirmedSyncWatermark(this.ctx.db, h.site_id),
			);
			const minConfirmedWatermark =
				candidateWatermarks.length > 0
					? candidateWatermarks.reduce((min, w) => (w < min ? w : min))
					: HLC_ZERO;
			const rowIds = listLiveMessageProjectionByThreadNewestFirst(
				this.ctx.db,
				this.config.threadId,
				100_000,
			).map((m) => m.id);
			const latestHlcByRow = getLatestChangeLogHlcForRows(this.ctx.db, rowIds);
			const segments = segmentAssembledMessages({
				db: this.ctx.db,
				threadId: this.config.threadId,
				producerMessages: frame.messages,
				nowMs: frame.assembled.assemblyNowMs,
				isRangeCoverable: (row) => {
					const hlc = latestHlcByRow.get(row.id);
					// No change_log row => not confirmed-synced => not coverable.
					return hlc !== undefined && hlc <= minConfirmedWatermark;
				},
			});

			const inferencePayload: InferenceRequestPayload = {
				model: resolution.modelId,
				segments,
				nowMs: frame.assembled.assemblyNowMs,
				tools: frame.mergedTools,
				system: frame.assembled.systemPrompt || undefined,
				max_tokens: this.resolvedMaxOutputTokens(resolution),
				temperature: undefined,
				...(resolution.thinkingConfig && { thinking: resolution.thinkingConfig }),
				timeout_ms: this.inferenceTimeoutMs,
			};

			const previousState = this.enterPhaseOverlay("RELAY_STREAM");
			const aborted$ = new Observable<void>((subscriber) => {
				if (this.aborted) {
					subscriber.next();
					subscriber.complete();
					return;
				}
				const onAbort = () => {
					subscriber.next();
					subscriber.complete();
				};
				const checkAbortInterval = setInterval(() => {
					if (this.aborted) {
						clearInterval(checkAbortInterval);
						subscriber.next();
						subscriber.complete();
					}
				}, 100);
				this.config.abortSignal?.addEventListener("abort", onAbort);
				return () => {
					clearInterval(checkAbortInterval);
					this.config.abortSignal?.removeEventListener("abort", onAbort);
				};
			});
			const relayStream = createRelayStream$(
				{
					db: this.ctx.db,
					eventBus: this.ctx.eventBus,
					siteId: this.ctx.siteId,
					logger: this.ctx.logger,
				},
				inferencePayload,
				resolution.hosts,
				aborted$,
				this.relayMetadataRef,
				{
					perHostTimeoutMs: this.inferenceTimeoutMs,
					firstChunkTimeoutMs: this.firstChunkTimeoutMs,
				},
			);
			return {
				chunks: this.withRestoredPhase(observableToAsyncIterable(relayStream), previousState),
				useSilenceTimeout: false,
			};
		}

		const totalEstimatedTokens =
			(this.lastContextDebug?.totalEstimated ?? 0) + frame.toolTokenEstimate;
		const effectiveSilenceTimeout = scaledSilenceTimeout(SILENCE_TIMEOUT_MS, totalEstimatedTokens);
		this.currentDriverSpan = getTracer().startSpan("llm-driver.chat", {
			attributes: {
				"llm.model": getResolvedModelId(this.lastModelResolution, this.config.modelId || "unknown"),
				"llm.provider": "local",
			},
		});
		return {
			chunks: resolution.backend.chat({
				messages: frame.messages,
				system: frame.assembled.systemPrompt || undefined,
				tools: frame.mergedTools,
				max_tokens: this.resolvedMaxOutputTokens(resolution),
				thinking: resolution.thinkingConfig,
				effort: resolution.effort,
				cache_ttl: resolution.cacheTtl,
				resolveFileRef: createFileRefResolver(this.ctx.db),
				signal: this.config.abortSignal,
			}),
			silenceTimeoutMs: effectiveSilenceTimeout,
			onSilenceHeartbeat: () => this.config.onActivity?.(),
		};
	}

	private async *withRestoredPhase<T>(
		source: AsyncIterable<T>,
		previousState: AgentLoopState,
	): AsyncGenerator<T> {
		try {
			yield* source;
		} finally {
			this.restorePhase(previousState);
		}
	}

	protected override afterModelStreamChunk(): void {
		this.config.onActivity?.();
		if (!this.currentDriverSpan || this.currentDriverTtftRecorded) return;
		this.currentDriverSpan.addEvent("time-to-first-token");
		this.currentDriverTtftRecorded = true;
	}

	protected override afterModelStreamComplete(chunks: StreamChunk[]): void {
		if (!this.currentDriverSpan) return;
		const doneChunk = chunks.find((c) => c.type === "done");
		if (doneChunk && doneChunk.type === "done") {
			const thinkingChars = chunks.reduce(
				(sum, c) => sum + (c.type === "thinking" ? c.content.length : 0),
				0,
			);
			this.currentDriverSpan.addEvent("completion", {
				"llm.input_tokens": doneChunk.usage.input_tokens,
				"llm.output_tokens": doneChunk.usage.output_tokens,
				"llm.thinking_chars": thinkingChars,
			});
		}
		this.currentDriverSpan.setStatus({ code: SpanStatusCode.OK });
		this.currentDriverSpan.end();
		this.currentDriverSpan = null;
	}

	protected override afterModelStreamError(error: unknown): void {
		if (!this.currentDriverSpan) return;
		this.currentDriverSpan.setStatus({
			code: SpanStatusCode.ERROR,
			message: error instanceof Error ? error.message : String(error),
		});
		this.currentDriverSpan.end();
		this.currentDriverSpan = null;
	}

	protected override shouldRetryModelStreamError(
		error: unknown,
		_chunks: StreamChunk[],
		frame: BoundPreparedFrame,
		_turn: number,
		attempt: number,
	): boolean {
		const isSilenceTimeout = error instanceof Error && error.message.includes("silence timeout");
		const totalEstimatedTokens =
			(this.lastContextDebug?.totalEstimated ?? 0) + frame.toolTokenEstimate;
		const effectiveMaxRetries = scaledMaxRetries(totalEstimatedTokens, MAX_SILENCE_RETRIES);
		if (isSilenceTimeout && attempt < effectiveMaxRetries) {
			this.config.onActivity?.();
			this.ctx.logger.warn("[agent-loop] Silence timeout, retrying", {
				attempt: attempt + 1,
				max: effectiveMaxRetries,
			});
			return true;
		}
		return false;
	}

	protected override onModelStreamYield(): void {
		this.yielded = true;
	}

	/**
	 * Bound rate-limit fallback policy. The base loop already handled transient
	 * transport retries and detected the rate-limit/quota condition; here we mark
	 * the backend rate-limited and try a same-tier (then any-capable) fallback
	 * via the model router. Return a retry decision when a fallback is found, or
	 * null to fall through to terminal handling.
	 */
	protected override onRateLimitError(
		error: unknown,
		frame: BoundPreparedFrame,
	): LoopTurnDecision | null {
		const statusCode = getLlmStatusCode(error);
		const backendId =
			this.lastModelResolution?.kind === "local" ? this.lastModelResolution.modelId : null;
		if (!backendId) {
			return null;
		}
		this.modelRouter.markRateLimited(backendId, getLlmRetryAfterMs(error) || 60_000);
		const failedTier = this.modelRouter.getBackendTier(backendId);
		const sameTierFallback =
			failedTier !== null
				? resolveSameTierFallback(
						backendId,
						this.modelRouter,
						this.ctx.db,
						this.ctx.siteId,
						failedTier,
						this.requirements,
					)
				: null;
		if (sameTierFallback && sameTierFallback.kind !== "error") {
			this.lastModelResolution = sameTierFallback;
			frame.resolution = sameTierFallback;
			this.transportRetries = 0;
			return { action: "retry" };
		}
		if ((statusCode === 429 || statusCode === 529) && this.requirements) {
			const newResolution = resolveModel(
				undefined,
				this.modelRouter,
				this.ctx.db,
				this.ctx.siteId,
				this.requirements,
			);
			if (newResolution.kind !== "error") {
				this.lastModelResolution = newResolution;
				frame.resolution = newResolution;
				this.transportRetries = 0;
				return { action: "retry" };
			}
		}
		return null;
	}

	/**
	 * Bound terminal model-error handling: salvage any partial streamed text into
	 * a developer message so work isn't lost, then emit an alert and end the turn
	 * with an error. Runs once base retries + rate-limit fallback are exhausted.
	 */
	protected override onModelErrorTerminal(error: unknown, chunks: StreamChunk[]): LoopTurnDecision {
		const errMsg = error instanceof Error ? error.message : String(error);
		if (chunks.length > 0) {
			try {
				const partial = this.parseResponseChunks(chunks);
				if (partial.textContent.length > 0) {
					const MAX_PARTIAL_CHARS = 2000;
					const truncated =
						partial.textContent.length > MAX_PARTIAL_CHARS
							? `${partial.textContent.slice(0, MAX_PARTIAL_CHARS)}... [truncated]`
							: partial.textContent;
					const partialId = insertThreadMessage(
						this.ctx.db,
						{
							threadId: this.config.threadId,
							role: "developer",
							content: `[Partial response - stream failed before completion] ${truncated}`,
							hostOrigin: this.ctx.siteId,
						},
						this.ctx.siteId,
					);
					this.broadcastMessage(partialId);
					this.messagesCreated++;
				}
			} catch (persistError) {
				this.ctx.logger.warn("[agent-loop] Failed to persist partial response after stream error", {
					error: persistError instanceof Error ? persistError.message : String(persistError),
					threadId: this.config.threadId,
				});
			}
		}
		this.setPhase("ERROR_PERSIST");
		this.ctx.logger.error("[agent-loop] LLM call failed (non-retryable)", {
			error: errMsg,
			statusCode: getLlmStatusCode(error) ?? null,
			model: getResolvedModelId(this.lastModelResolution, this.config.modelId || "unknown"),
		});
		this.emitAlert(`Error: ${formatError(error)}`);
		return { action: "error", error: formatError(error) };
	}

	protected override afterParse(
		parsed: ParsedResponse,
		_frame: BoundPreparedFrame,
		turn: number,
	): LoopTurnDecision {
		this.setPhase("PARSE_RESPONSE");
		this.ctx.logger.info("[agent-loop] LLM response received", {
			turn,
			inputTokens: parsed.usage.inputTokens,
			outputTokens: parsed.usage.outputTokens,
			cacheRead: parsed.usage.cacheReadTokens,
			cacheWrite: parsed.usage.cacheWriteTokens,
			estimated: parsed.usage.usageEstimated,
			toolCalls: parsed.toolCalls.length,
			toolNames:
				parsed.toolCalls.length > 0 ? parsed.toolCalls.map((tc) => tc.name).join(", ") : null,
			textLength: parsed.textContent.length,
			thinkingLength: parsed.thinking?.length ?? 0,
		});
		if (this.aborted && parsed.usage.inputTokens === 0 && parsed.usage.outputTokens === 0) {
			if (!this.yielded) {
				const cancelId = insertThreadMessage(
					this.ctx.db,
					{
						threadId: this.config.threadId,
						role: "developer",
						content:
							"[Turn cancelled] The previous inference was cancelled before it could complete. " +
							"No response was generated for the last user message.",
						hostOrigin: this.ctx.siteId,
					},
					this.ctx.siteId,
				);
				this.broadcastMessage(cancelId);
				this.messagesCreated++;
			}
			return { action: this.yielded ? "yield" : "stop" };
		}
		return { action: "continue" };
	}

	protected override recordTurn(metrics: {
		threadId: string;
		taskId?: string;
		modelId: string;
		response: ParsedResponse;
		status?: "success" | "error" | "aborted";
		contextDebug?: ContextDebugInfo;
	}): string | null {
		try {
			const resolvedModelId = getResolvedModelId(
				this.lastModelResolution,
				this.config.modelId || metrics.modelId || "unknown",
			);
			const backends = this.ctx.config?.modelBackends?.backends ?? [];
			const cost_usd =
				metrics.response.costUsdFromHub ??
				calculateTurnCost(resolvedModelId, metrics.response.usage, backends);
			const turnId = recordTurn(
				this.ctx.db,
				{
					thread_id: this.config.threadId,
					task_id: this.config.taskId || undefined,
					dag_root_id: undefined,
					model_id: resolvedModelId,
					tokens_in: metrics.response.usage.inputTokens,
					tokens_out: metrics.response.usage.outputTokens,
					tokens_cache_write: metrics.response.usage.cacheWriteTokens,
					tokens_cache_read: metrics.response.usage.cacheReadTokens,
					cost_usd,
					status: metrics.status === "success" ? "ok" : metrics.status,
					created_at: new Date().toISOString(),
				},
				this.ctx.siteId,
			);
			this.currentTurnId = turnId;
			return turnId;
		} catch (error) {
			this.ctx.logger.warn("Failed to record turn metrics", {
				threadId: this.config.threadId,
				error: error instanceof Error ? error.message : String(error),
			});
			return null;
		}
	}

	protected override afterRecord(
		parsed: ParsedResponse,
		_frame: BoundPreparedFrame,
		turnId: string | null,
	): LoopTurnDecision {
		if (
			turnId !== null &&
			this.relayMetadataRef.hostName !== undefined &&
			this.relayMetadataRef.firstChunkLatencyMs !== undefined
		) {
			try {
				recordTurnRelayMetrics(
					this.ctx.db,
					turnId,
					this.relayMetadataRef.hostName,
					this.relayMetadataRef.firstChunkLatencyMs,
					this.ctx.siteId,
				);
			} catch (error) {
				this.ctx.logger.warn("Failed to record turn relay metrics", {
					threadId: this.config.threadId,
					turnId,
					error: error instanceof Error ? error.message : String(error),
				});
			}
		}

		const actualTotalTokens =
			parsed.usage.inputTokens +
			(parsed.usage.cacheReadTokens ?? 0) +
			(parsed.usage.cacheWriteTokens ?? 0);
		if (this.lastContextDebug && actualTotalTokens > 0) {
			this.lastContextDebug = applyActualUsageToContextDebug(
				this.lastContextDebug,
				actualTotalTokens,
			);
		}
		if (this.lastContextDebug) {
			if (parsed.finishReason) {
				this.lastContextDebug.finishReason = parsed.finishReason;
			}
			const effectiveMaxOutputTokens = this.effectiveMaxOutputTokens();
			if (typeof effectiveMaxOutputTokens === "number") {
				this.lastContextDebug.maxOutputTokens = effectiveMaxOutputTokens;
			}
		}
		if (turnId !== null && this.lastContextDebug) {
			try {
				recordContextDebug(this.ctx.db, turnId, this.lastContextDebug, this.ctx.siteId);
				this.ctx.eventBus.emit("context:debug", {
					thread_id: this.config.threadId,
					turn_id: turnId,
					debug: this.lastContextDebug,
				});
			} catch (error) {
				this.ctx.logger.warn("Failed to record context debug", {
					threadId: this.config.threadId,
					turnId,
					error: error instanceof Error ? error.message : String(error),
				});
			}
		}

		const cacheRead = parsed.usage.cacheReadTokens ?? 0;
		const cacheWrite = parsed.usage.cacheWriteTokens ?? 0;
		this.prevCacheReadTokens =
			cacheRead > 0 ? cacheRead : cacheWrite > 0 ? cacheWrite : this.prevCacheReadTokens;

		// Degenerate-turn recovery (no tool call and no text, from either an
		// output-token truncation or a dropped stream) is handled by the base
		// loop's checkDegenerateRetry, evaluated after this hook returns. It calls
		// notifyDegenerateTurn (overridden below) to persist the notification.
		return { action: "continue" };
	}

	protected override notifyDegenerateTurn(parsed: ParsedResponse): void {
		const wasTruncated = parsed.finishReason === "length";
		const content = wasTruncated
			? "[System] Your previous response was cut off at the output-token limit before " +
				"producing any answer or tool call. Please respond again, more concisely, so the " +
				"full response fits."
			: "[System] Your previous response produced no answer or tool call (the inference " +
				"stream ended early). Please respond to the last message now.";
		try {
			this.emitDeveloperNotice(content);
		} catch (error) {
			this.ctx.logger.warn("Failed to persist degenerate-turn notification", {
				threadId: this.config.threadId,
				error: error instanceof Error ? error.message : String(error),
			});
		}
	}

	protected override async handleFinalResponse(
		parsed: ParsedResponse,
		frame: BoundPreparedFrame,
	): Promise<void> {
		if (parsed.finishReason === "length") {
			this.ctx.logger.warn(
				"[agent-loop] Final response truncated at output-token limit (finishReason=length)",
				{
					threadId: this.config.threadId,
					taskId: this.config.taskId ?? null,
					model: frame.resolution.modelId,
					outputTokens: parsed.usage.outputTokens,
					maxOutputTokens: this.effectiveMaxOutputTokens() ?? null,
					hadText: Boolean(parsed.textContent),
					hadThinking: Boolean(
						parsed.thinking || parsed.thinkingRedactedData || parsed.thinkingEncryptedContent,
					),
				},
			);
		}
		this.setPhase("RESPONSE_PERSIST");
		let assistantContent: string;
		if (parsed.thinking || parsed.thinkingRedactedData || parsed.thinkingEncryptedContent) {
			assistantContent = JSON.stringify(
				this.buildAssistantToolCallBlocks(
					parsed.textContent,
					{
						thinking: parsed.thinking,
						signature: parsed.thinkingSignature,
						redactedData: parsed.thinkingRedactedData,
						encryptedContent: parsed.thinkingEncryptedContent,
					},
					[],
				),
			);
		} else {
			assistantContent = parsed.textContent || "";
		}
		if (assistantContent) {
			const assistantMsgId = insertThreadMessage(
				this.ctx.db,
				{
					threadId: this.config.threadId,
					role: "assistant",
					content: assistantContent,
					hostOrigin: this.ctx.siteId,
					modelId: frame.resolution.modelId,
				},
				this.ctx.siteId,
			);
			this.broadcastMessage(assistantMsgId);
			this.messagesCreated++;
		}
		if (parsed.finishReason === "content-filter") {
			this.emitAlert(
				"Model safety filter stopped generation (finishReason=content-filter). " +
					"Any partial output above was persisted; the turn was not retried.",
			);
		}
	}

	protected override beforeToolRoundTrip(
		_parsed: ParsedResponse,
		_frame: BoundPreparedFrame,
		_turn: number,
	): LoopTurnDecision {
		// Truncation and duplicate-call circuit breakers run in the base loop's
		// runPreExecutionGuards before this hook; here we only handle Bound's
		// cooperative yield checkpoint.
		if (this.config.shouldYield?.()) {
			this.yielded = true;
			return { action: "yield" };
		}

		return { action: "continue" };
	}

	/**
	 * Route loop-guard trips and nudges through Bound's developer-message channel
	 * (persisted + broadcast) so the model sees them, rather than the base alert.
	 */
	protected override onLoopGuardTripped(_reason: LoopGuardReason, detail: string): void {
		this.emitDeveloperNotice(detail);
	}

	protected override emitLoopGuardNudge(detail: string): void {
		this.emitDeveloperNotice(detail);
	}

	/**
	 * Classify a tool error for the base error-chain breakers. A cross-tool
	 * routing suggestion (from suggestCorrectTool) arms the short-fuse routing
	 * breaker; any other non-zero exit is a generic error.
	 */
	protected override classifyToolResultError(result: ToolExecutionResult): ToolResultErrorKind {
		if (result.exitCode === 0) return null;
		return containsRoutingSuggestion(result.content) ? "routing" : "generic";
	}

	protected override async executeToolRoundTrip(
		parsed: ParsedResponse,
		_frame: BoundPreparedFrame,
		turn: number,
	): Promise<LoopToolExecutionBatch> {
		this.setPhase("TOOL_EXECUTE");
		const results: LoopToolExecutionBatch["results"] = [];
		const deferred: LoopToolExecutionBatch["deferred"] = [];

		for (const toolCall of parsed.toolCalls) {
			if (toolCall.name === "think" && _frame.resolution.thinkingTool) {
				this.toolCallsMade++;
				results.push({
					toolCall,
					result: { content: THINK_TOOL_RESULT, exitCode: 0, durationMs: 0 },
				});
				continue;
			}
			this.toolCallsMade++;
			let resultContent = "";
			let exitCode = 0;
			let mcpAppBinding: McpAppBinding | undefined;
			let deferredPlaceholder = false;
			let toolMetadata: Record<string, unknown> | undefined;
			const toolStartTime = Date.now();

			if (toolCall.truncated) {
				results.push({
					toolCall,
					result: {
						content: `Error: tool call arguments were truncated (output exceeded max_tokens limit). The "${toolCall.name}" call was cut off before the full arguments could be generated. Try breaking the operation into smaller parts, or reduce the size of the arguments.`,
						exitCode: 1,
						durationMs: 0,
					},
				});
				continue;
			}

			try {
				const toolHeartbeat = this.config.onActivity
					? setInterval(() => {
							try {
								this.config.onActivity?.();
							} catch (activityError) {
								this.ctx.logger.debug("[agent-loop] onActivity heartbeat callback threw", {
									error:
										activityError instanceof Error ? activityError.message : String(activityError),
									threadId: this.config.threadId,
								});
							}
						}, SILENCE_HEARTBEAT_INTERVAL_MS)
					: null;
				try {
					const MAX_RELAY_RETRIES = 1;
					let retryAttempt = 0;
					let dispatchResult = await this.executeToolCall(toolCall, context.active());
					for (;;) {
						if ("outboxEntryId" in dispatchResult) {
							const previousRelayState = this.enterPhaseOverlay("RELAY_WAIT");
							const aborted$ = new Subject<void>();
							const abortCheck = setInterval(() => {
								if (this.aborted) {
									aborted$.next();
									aborted$.complete();
								}
							}, 100);
							let waitResult: RelayWaitResult;
							try {
								waitResult = await firstValueFrom(
									createRelayWait$(
										{
											db: this.ctx.db,
											eventBus: this.ctx.eventBus,
											siteId: this.ctx.siteId,
											logger: this.ctx.logger,
										},
										{
											outboxEntryId: dispatchResult.outboxEntryId,
											toolName: dispatchResult.toolName,
											toolInput: toolCall.input,
											eligibleHosts: dispatchResult.eligibleHosts,
											currentHostIndex: dispatchResult.currentHostIndex,
											currentTurnId: this.currentTurnId,
											threadId: this.config.threadId,
										},
										aborted$,
									),
									{
										defaultValue: {
											content: "Cancelled: relay request was cancelled by user",
											retriable: false,
										},
									},
								);
							} finally {
								clearInterval(abortCheck);
								this.restorePhase(previousRelayState);
							}
							if (
								shouldRetryRelayCall({
									waitResult,
									attempt: retryAttempt,
									maxAttempts: MAX_RELAY_RETRIES,
									aborted: this.aborted,
									annotations: dispatchResult.annotations,
								})
							) {
								retryAttempt++;
								await new Promise((resolve) => setTimeout(resolve, 2000 * retryAttempt));
								this.config.onActivity?.();
								dispatchResult = await this.executeToolCall(toolCall, context.active());
								continue;
							}
							resultContent = waitResult.content;
							break;
						}
						if (isClientToolCallRequest(dispatchResult)) {
							deferred.push({ toolCall, value: dispatchResult });
							resultContent = "";
							exitCode = 0;
							break;
						}
						if (isDeferredToolResult(dispatchResult)) {
							resultContent =
								dispatchResult.description ??
								`[Background: tool "${toolCall.name}" deferred \u2014 result will arrive when complete.]`;
							exitCode = 0;
							deferredPlaceholder = true;
							// Metadata stamped on the PLACEHOLDER row survives resolution:
							// resolveDeferredToolResult drops only the `background` marker
							// and preserves sibling keys (e.g. aux_thread).
							toolMetadata = dispatchResult.metadata;
							break;
						}
						resultContent = dispatchResult.content;
						exitCode = dispatchResult.exitCode;
						mcpAppBinding = dispatchResult.mcpApp;
						toolMetadata = dispatchResult.metadata;
						break;
					}
				} finally {
					if (toolHeartbeat) clearInterval(toolHeartbeat);
				}
			} catch (error) {
				resultContent = `Error: ${formatError(error)}`;
				exitCode = 1;
			}

			if (deferred.some((pending) => pending.toolCall.id === toolCall.id)) {
				continue;
			}
			const toolDurationMs = Date.now() - toolStartTime;
			results.push({
				toolCall,
				result: {
					content: resultContent,
					exitCode,
					durationMs: toolDurationMs,
					mcpApp: mcpAppBinding,
					deferred: deferredPlaceholder || undefined,
					metadata: toolMetadata,
				},
			});
			this.config.onActivity?.();
			this.ctx.logger.info("[agent-loop] Tool completed", {
				turn,
				tool: toolCall.name,
				durationMs: toolDurationMs,
				exitCode,
				resultLength: resultContent.length,
				isError: exitCode !== 0,
			});
		}

		return { results, deferred };
	}

	protected override async afterToolExecution(
		_parsed: ParsedResponse,
		_frame: BoundPreparedFrame,
		batch: LoopToolExecutionBatch,
	): Promise<LoopTurnDecision> {
		const toolResults = batch.results;
		// Error/routing-error signature chains are recorded by the base loop's
		// recordToolErrorSignatures before this hook runs (on pre-offload content,
		// matching prior behavior). Here we only offload large results and append
		// durations.
		if (this.sandbox.writeFile) {
			for (const result of toolResults) {
				if (result.result.content.length > TOOL_RESULT_OFFLOAD_THRESHOLD) {
					const filePath = offloadToolResultPath(result.toolCall.id);
					try {
						const originalLength = result.result.content.length;
						await this.sandbox.writeFile(filePath, result.result.content);
						result.result.content = buildOffloadMessage(
							filePath,
							originalLength,
							result.toolCall.name,
						);
					} catch (offloadError) {
						this.ctx.logger.warn(
							"[agent-loop] Failed to offload large tool result; retaining inline content",
							{
								error: offloadError instanceof Error ? offloadError.message : String(offloadError),
								toolName: result.toolCall.name,
								toolCallId: result.toolCall.id,
								contentLength: result.result.content.length,
							},
						);
					}
				}
			}
		}
		for (const result of toolResults) {
			result.result.content = appendToolDuration(
				result.result.content,
				result.result.durationMs ?? 0,
			);
		}

		return { action: "continue" };
	}

	protected override async persistToolMessages(
		parsed: ParsedResponse,
		frame: BoundPreparedFrame,
		batch: LoopToolExecutionBatch,
	): Promise<void> {
		this.setPhase("TOOL_PERSIST");
		const toolCallBlocks = this.buildAssistantToolCallBlocks(
			parsed.textContent,
			{
				thinking: parsed.thinking,
				signature: parsed.thinkingSignature,
				redactedData: parsed.thinkingRedactedData,
				encryptedContent: parsed.thinkingEncryptedContent,
			},
			parsed.toolCalls,
		);
		const toolCallMsgId = insertThreadMessage(
			this.ctx.db,
			{
				threadId: this.config.threadId,
				role: "tool_call",
				content: JSON.stringify(toolCallBlocks),
				hostOrigin: this.ctx.siteId,
				modelId: frame.resolution.modelId,
			},
			this.ctx.siteId,
		);
		this.broadcastMessage(toolCallMsgId);
		this.messagesCreated++;
		frame.messages.push({ role: "tool_call", content: toolCallBlocks });

		for (const { toolCall, result } of batch.results) {
			const toolResultMsgId = insertThreadMessage(
				this.ctx.db,
				{
					threadId: this.config.threadId,
					role: "tool_result",
					content: result.content,
					hostOrigin: this.ctx.siteId,
					modelId: frame.resolution.modelId,
					toolName: toolCall.id,
					exitCode: result.exitCode,
				},
				this.ctx.siteId,
			);
			// Stamp tool-provided metadata (e.g. aux_thread) plus the seam's own
			// keys. The background marker keeps the in-flight count derivable from
			// DB state (countBackgroundToolCallsByThread) rather than tallied by
			// event arithmetic on a client, which drifts on any dropped frame.
			// resolveDeferredToolResult clears ONLY the background key when the
			// real result lands — sibling keys like aux_thread survive resolution.
			const extraMetadata: Record<string, unknown> = { ...result.metadata };
			if (result.mcpApp) extraMetadata.mcp_app = result.mcpApp;
			if (result.deferred) extraMetadata.background = true;
			if (Object.keys(extraMetadata).length > 0) {
				writeMessageMetadata(this.ctx.db, toolResultMsgId, extraMetadata, this.ctx.siteId);
			}
			this.broadcastMessage(toolResultMsgId);
			this.messagesCreated++;
			frame.messages.push({
				role: "tool_result",
				content: parseContentBlocks(result.content),
				tool_use_id: toolCall.id,
			});
		}

		// A placeholder just became in-flight — push the recomputed count so the
		// client's indicator lights up on dispatch, not only on completion.
		if (batch.results.some((r) => r.result.deferred)) {
			this.ctx.eventBus.emit("background:count", {
				thread_id: this.config.threadId,
				count: countBackgroundToolCallsByThread(this.ctx.db, this.config.threadId),
			});
		}
	}

	protected override async afterToolPersistence(
		_parsed: ParsedResponse,
		_frame: BoundPreparedFrame,
		batch: LoopToolExecutionBatch,
	): Promise<LoopTurnDecision> {
		// Identical-error / routing-error hard aborts and the corrective nudge run
		// in the base loop's runPostExecutionGuards after this hook. Bound routes
		// their messages through emitDeveloperNotice via the overridden
		// onLoopGuardTripped / emitLoopGuardNudge hooks.
		if (this.sandbox.checkMemoryThreshold) {
			const memCheck = this.sandbox.checkMemoryThreshold();
			if (memCheck.overThreshold) {
				this.ctx.logger.warn("Memory threshold exceeded, terminating loop", {
					usage: memCheck.usageBytes,
					threshold: memCheck.thresholdBytes,
				});
				return { action: "stop" };
			}
		}

		if (batch.deferred.length > 0) {
			for (const { toolCall } of batch.deferred) {
				const connectionId = this.config.connectionId;
				if (connectionId) {
					// LOCAL PATH (unchanged): the thread's live WS session is on THIS
					// host. Enqueue into the local WS dispatch and stop; the client's
					// result arrives via websocket.ts → enqueueToolResult, which
					// re-wakes the loop. The deferral is intentional.
					const entryId = enqueueClientToolCall(
						this.ctx.db,
						this.config.threadId,
						{
							call_id: toolCall.id,
							tool_name: toolCall.name,
							arguments: toolCall.input,
						},
						connectionId,
					);
					const tracker = this.config.handleMessageTracker;
					const dispatchCtx = tracker
						? (tracker.openDispatch(this.config.threadId, toolCall.id, toolCall.name) as Context)
						: context.active();
					const traceContext = context.with(dispatchCtx, () => injectTraceContext());
					this.ctx.eventBus.emit("client_tool_call:created", {
						threadId: this.config.threadId,
						callId: toolCall.id,
						entryId,
						toolName: toolCall.name,
						arguments: toolCall.input,
						traceContext,
					});
					continue;
				}

				// NO LOCAL CONNECTION. Resolve the live REMOTE host holding the
				// thread's WS session and relay the call there (R-UD5/R-UD8/R-UD12).
				const sessionHost = resolveClientSessionHost(
					this.ctx.db,
					this.config.threadId,
					this.ctx.siteId,
				);
				if (!sessionHost) {
					// No live session ANYWHERE (no local connection AND no live remote
					// session). Keep the loud-error edge: persist an error tool_result
					// so the loop resumes and the model sees the failure rather than
					// silently dropping the call (which would leave an orphan tool_call).
					this.ctx.logger.error("Client tool call without a live session anywhere", {
						tool: toolCall.name,
						callId: toolCall.id,
						threadId: this.config.threadId,
					});
					this.persistRelayedClientToolResult(
						toolCall.id,
						`Error: no live boundless/client session for this thread on any host; cannot run client tool "${toolCall.name}"`,
						true,
					);
					continue;
				}

				// Drive the relayed call to completion (relay request → wait for
				// client_result → persist tool_result + enqueueToolResult). This
				// matches the local resume contract: the persisted tool_result + the
				// enqueued dispatch row re-wake the loop exactly as the WS path does.
				await this.relayDeferredClientTool(toolCall, sessionHost);
			}
			return { action: "stop" };
		}

		if (this.config.shouldYield?.()) {
			this.yielded = true;
			return { action: "yield" };
		}
		return { action: "continue" };
	}

	/**
	 * Relay a deferred client tool to the remote host holding the thread's live
	 * WS session and drive it to completion (R-UD5/R-UD8/R-UD12).
	 *
	 * Writes a `client_tool` relay outbox entry to the session host, then waits
	 * for the matching `client_result` (or `error`) response on `relay_inbox`,
	 * keyed by the outbox entry id — the same correlation `createRelayWait$` uses
	 * for inference/tool relays. On success the executed tool output is persisted
	 * as the thread's `tool_result` message (host-parity with the WS path) and
	 * `enqueueToolResult` re-wakes the loop. On a retriable failure (timeout /
	 * session drop mid-call, AC.7b) the failure is surfaced as the tool result so
	 * the loop resumes and the model can react, rather than wedging the turn.
	 */
	protected async relayDeferredClientTool(
		toolCall: ParsedToolCall,
		sessionHost: EligibleHost,
	): Promise<void> {
		const timeoutMs = this.inferenceTimeoutMs;
		const tracker = this.config.handleMessageTracker;
		const dispatchCtx = tracker
			? (tracker.openDispatch(this.config.threadId, toolCall.id, toolCall.name) as Context)
			: context.active();
		const traceCarrier = context.with(dispatchCtx, () => injectTraceContext());

		const payload: ClientToolPayload = {
			thread_id: this.config.threadId,
			call_id: toolCall.id,
			tool_name: toolCall.name,
			args: toolCall.input,
			timeout_ms: timeoutMs,
		};
		const outboxEntry = createRelayOutboxEntry(
			sessionHost.site_id,
			this.ctx.siteId,
			"client_tool",
			JSON.stringify(payload),
			timeoutMs,
			undefined,
			undefined,
			undefined,
			traceCarrier ? JSON.stringify(traceCarrier) : undefined,
		);
		try {
			writeOutbox(this.ctx.db, outboxEntry);
		} catch (error) {
			this.ctx.logger.error("[agent-loop] Failed to write client_tool relay outbox entry", {
				tool: toolCall.name,
				callId: toolCall.id,
				host: sessionHost.host_name,
				error: error instanceof Error ? error.message : String(error),
			});
			this.persistRelayedClientToolResult(
				toolCall.id,
				`Error: failed to relay client tool "${toolCall.name}" to session host: ${formatError(error)}`,
				true,
			);
			return;
		}

		this.ctx.logger.info("[agent-loop] Relaying client tool to session host", {
			tool: toolCall.name,
			callId: toolCall.id,
			host: sessionHost.host_name,
			outboxEntryId: outboxEntry.id,
		});

		const previousRelayState = this.enterPhaseOverlay("RELAY_WAIT");
		const aborted$ = new Subject<void>();
		const abortCheck = setInterval(() => {
			if (this.aborted) {
				aborted$.next();
				aborted$.complete();
			}
		}, 100);
		let resolved: { content: string; isError: boolean } | null;
		try {
			resolved = await firstValueFrom(
				this.createClientResultWait$(outboxEntry.id, timeoutMs, aborted$),
				{ defaultValue: null },
			);
		} finally {
			clearInterval(abortCheck);
			this.restorePhase(previousRelayState);
		}

		if (resolved) {
			this.persistRelayedClientToolResult(toolCall.id, resolved.content, resolved.isError);
			return;
		}
		// Null = timeout / abort / unparseable response → retriable failure (AC.7b).
		// Surface it as the tool result so the loop resumes; the producer treats it
		// as transient (it did not hard-fail the turn).
		this.persistRelayedClientToolResult(
			toolCall.id,
			`Error: client tool "${toolCall.name}" relay timed out or the session dropped before returning a result (retriable)`,
			true,
		);
	}

	/**
	 * Wait for a `client_result` (or `error`) relay response correlated to
	 * `outboxEntryId`, mirroring {@link createRelayWait$}'s inbox correlation
	 * (initial read + `relay:inbox` event wakeups, with a hard timeout). Resolves
	 * to the executed tool output, or null on timeout / abort / unparseable
	 * payload (treated as a retriable failure by the caller).
	 */
	private createClientResultWait$(
		outboxEntryId: string,
		timeoutMs: number,
		aborted$: Observable<unknown>,
	): Observable<{ content: string; isError: boolean } | null> {
		const db = this.ctx.db;
		const eventBus = this.ctx.eventBus;
		const response$ = merge(
			defer(() => of(readInboxByRefId(db, outboxEntryId))),
			fromEventBus(eventBus, "relay:inbox").pipe(
				filter((event) => event.ref_id === outboxEntryId),
				map(() => readInboxByRefId(db, outboxEntryId)),
			),
		).pipe(
			filter((entry): entry is NonNullable<typeof entry> => entry !== null && entry !== undefined),
			take(1),
			timeout(timeoutMs),
			map((entry) => {
				markProcessed(db, [entry.id]);
				if (entry.kind === "client_result") {
					const parsed = parseJsonSafe(clientResultPayloadSchema, entry.payload, entry.kind);
					if (!parsed.ok) {
						return { content: "Error: malformed client_result payload", isError: true };
					}
					return { content: parsed.value.content, isError: parsed.value.is_error };
				}
				if (entry.kind === "error") {
					const parsed = parseJsonSafe(errorPayloadSchema, entry.payload, entry.kind);
					const message = parsed.ok ? parsed.value.error : entry.payload;
					return { content: `Error: ${message}`, isError: true };
				}
				return { content: `Error: unexpected relay response kind "${entry.kind}"`, isError: true };
			}),
			catchError((err) => {
				if (err instanceof TimeoutError) return of(null);
				return throwError(() => err);
			}),
		);
		const abort$ = aborted$.pipe(
			take(1),
			map(() => null),
		);
		return race(response$, abort$);
	}

	/**
	 * Persist a relayed client tool's result as the thread's `tool_result`
	 * message (role + `tool_name=callId`, host-parity with the WS path) and
	 * re-wake the loop via `enqueueToolResult`. Idempotent re-drive is safe:
	 * `enqueueToolResult` is a no-op on a duplicate `(thread_id, call_id)`.
	 */
	protected persistRelayedClientToolResult(
		callId: string,
		content: string,
		isError: boolean,
	): void {
		const capped = capToolResultContent(content);
		const messageId = insertThreadMessage(
			this.ctx.db,
			{
				threadId: this.config.threadId,
				role: "tool_result",
				content: capped,
				hostOrigin: this.ctx.siteId,
				modelId: null,
				toolName: callId,
				exitCode: isError ? 1 : 0,
			},
			this.ctx.siteId,
		);
		this.broadcastMessage(messageId);
		this.messagesCreated++;
		enqueueToolResult(this.ctx.db, this.config.threadId, callId);
	}

	async run(): Promise<AgentLoopResult> {
		return super.run();
	}

	/** Broadcast a persisted message to WS clients without re-triggering the agent loop. */
	private broadcastMessage(messageId: string): void {
		const message = findMessageById(this.ctx.db, messageId);
		if (message) {
			this.ctx.eventBus.emit("message:broadcast", {
				message: message as EventMap["message:broadcast"]["message"],
				thread_id: this.config.threadId,
			});
		}
	}

	/** Create an alert message and broadcast it to WS clients so they see it immediately. */
	private emitAlert(content: string): void {
		const id = insertThreadMessage(
			this.ctx.db,
			{
				threadId: this.config.threadId,
				role: "alert",
				content,
				hostOrigin: this.ctx.siteId,
			},
			this.ctx.siteId,
		);
		this.broadcastMessage(id);
	}

	private emitDeveloperNotice(content: string): void {
		const id = insertThreadMessage(
			this.ctx.db,
			{
				threadId: this.config.threadId,
				role: "developer",
				content,
				hostOrigin: this.ctx.siteId,
			},
			this.ctx.siteId,
		);
		this.broadcastMessage(id);
		this.messagesCreated++;
	}

	/** Read inference_timeout_ms from relay config (default 300s). */
	private get inferenceTimeoutMs(): number {
		if (this._inferenceTimeoutMs === null) {
			const syncResult = this.ctx.optionalConfig?.sync;
			const syncConfig = syncResult?.ok ? (syncResult.value as SyncConfig) : undefined;
			const relayConfig = resolveRelayConfig(syncConfig);
			this._inferenceTimeoutMs = relayConfig.inference_timeout_ms;
		}
		return this._inferenceTimeoutMs;
	}

	// First-chunk timeout for relay streaming. A dead/restarted spoke never
	// emits even a heartbeat, so the relay stream should fail over to the next
	// eligible host (source redispatch) well before the full per-chunk
	// inference timeout elapses. Capped at 60s but never above the per-chunk
	// timeout, so a tighter inference_timeout_ms config still bounds it.
	private get firstChunkTimeoutMs(): number {
		return Math.min(this.inferenceTimeoutMs, 60_000);
	}

	// Acquires a backend for loop-end summary extraction through cluster-wide
	// resolution rather than a local-only tryGetBackend lookup. A local
	// resolution runs extraction in-process exactly as before; a remote
	// resolution wraps the relay so extraction delegates over the inference
	// relay (the case that makes extraction run on a backendless host). An
	// unresolvable model returns null and extraction is skipped.
	protected acquireSummaryBackend(modelId: string): LLMBackend | null {
		const resolution = resolveModel(modelId, this.modelRouter, this.ctx.db, this.ctx.siteId);
		switch (resolution.kind) {
			case "local":
				return resolution.backend;
			case "remote":
				return createRelayBackend(
					{
						db: this.ctx.db,
						eventBus: this.ctx.eventBus,
						siteId: this.ctx.siteId,
						logger: this.ctx.logger,
					},
					resolution.hosts,
					resolution.modelId,
					this.inferenceTimeoutMs,
				);
			case "error":
				return null;
		}
	}

	/** Merge server tools and client tool definitions into a single LLM tool list. */
	protected getMergedTools(): Array<ToolDefinition> | undefined {
		// `noTools` turns (e.g. cache-warming pokes, issue #10) run tool-less: the
		// merged list resolves to undefined and the loop ends after one response.
		if (this.config.noTools) return undefined;
		const thinkingTool =
			this.lastModelResolution !== null &&
			this.lastModelResolution.kind !== "error" &&
			this.lastModelResolution.thinkingTool === true;
		if (this.config.toolRegistry) {
			const registryTools: ToolDefinition[] = [];
			for (const registered of this.config.toolRegistry.values()) {
				registryTools.push(registered.toolDefinition);
			}
			const registryNames = new Set(this.config.toolRegistry.keys());
			const extras = (this.config.tools ?? []).filter((t) => !registryNames.has(t.function.name));
			const merged = [
				...registryTools,
				...extras,
				...(thinkingTool ? [THINK_TOOL_DEFINITION] : []),
			];
			return merged.length > 0 ? merged : undefined;
		}

		const serverTools = this.config.tools ?? [];
		const clientTools = this.config.clientTools ? Array.from(this.config.clientTools.values()) : [];
		const merged: Array<ToolDefinition> = [
			...serverTools,
			...clientTools,
			...(thinkingTool ? [THINK_TOOL_DEFINITION] : []),
		];
		return merged.length > 0 ? merged : undefined;
	}

	/**
	 * Run a sandbox (bms_bash) command with a wall-clock timeout derived from the
	 * tool call's optional `timeout` arg (ms), defaulting to
	 * DEFAULT_SANDBOX_EXEC_TIMEOUT_MS. The timeout fires an AbortSignal that
	 * just-bash honors cooperatively (see the constant's note). On timeout we
	 * synthesize a 124 result (the conventional `timeout(1)` exit code) rather
	 * than letting the abort throw escape the dispatch.
	 *
	 * Returns whatever `sandbox.exec` returns (a {stdout,stderr,exitCode} result
	 * OR a relay request the wrapper lifted onto it), so callers still run their
	 * isRelayRequest check.
	 */
	private async execSandboxWithTimeout(
		command: string,
		timeoutArg: unknown,
		cwdArg?: unknown,
	): Promise<{ stdout: string; stderr: string; exitCode: number }> {
		const exec = this.sandbox.exec;
		if (!exec) {
			return { stdout: "", stderr: "sandbox execution not available", exitCode: 1 };
		}
		const timeoutMs =
			typeof timeoutArg === "number" && Number.isFinite(timeoutArg) && timeoutArg > 0
				? timeoutArg
				: DEFAULT_SANDBOX_EXEC_TIMEOUT_MS;
		// just-bash applies `cwd` for this execution only and restores it afterward
		// (ExecOptions.cwd), so the dedicated arg gives the same one-command scope an
		// inline `cd` would, without leaking the directory into the next command.
		const cwd = typeof cwdArg === "string" && cwdArg.length > 0 ? cwdArg : undefined;
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), timeoutMs);
		try {
			return await exec(command, { signal: controller.signal, ...(cwd ? { cwd } : {}) });
		} catch (err) {
			if (controller.signal.aborted) {
				return {
					stdout: "",
					stderr: `Command timed out after ${timeoutMs}ms`,
					exitCode: 124,
				};
			}
			throw err;
		} finally {
			clearTimeout(timer);
		}
	}

	/** Execute a tool call via platform tools or sandbox. Returns relay request for remote MCP tools or client tool call request. */
	private async executeToolCall(
		toolCall: ParsedToolCall,
		parentCtx?: Context,
	): Promise<
		| {
				content: string;
				exitCode: number;
				mcpApp?: McpAppBinding;
				metadata?: Record<string, unknown>;
		  }
		| RelayToolCallRequest
		| ClientToolCallRequest
		| DeferredToolResult
	> {
		// Registry-based dispatch (new path)
		if (this.config.toolRegistry) {
			const tool = this.config.toolRegistry.get(toolCall.name);
			if (!tool) {
				return {
					content: `Error: unknown tool "${toolCall.name}"`,
					exitCode: 1,
				};
			}

			// Client tools are deferred — no execution span here
			if (tool.kind === "client") {
				return {
					clientToolCall: true,
					toolName: toolCall.name,
					callId: toolCall.id,
					arguments: toolCall.input,
				} satisfies ClientToolCallRequest;
			}

			// Create span for all other tool kinds, parented to tool-execute span
			const toolSpan = getTracer().startSpan(
				"tool.execute",
				{
					attributes: {
						"tool.name": toolCall.name,
						"tool.kind": tool.kind,
						"tool.call_id": toolCall.id,
					},
				},
				parentCtx,
			);

			try {
				let result: {
					content: string;
					exitCode: number;
					mcpApp?: McpAppBinding;
					metadata?: Record<string, unknown>;
				};

				// Normalize a tool's raw return (string | ContentBlock[]) into the
				// result shape, deriving exitCode from the Error: convention. Shared
				// by the platform and builtin arms, and by the ToolResultWithMetadata
				// unwrap below.
				const normalize = (
					raw: string | import("@bound/llm").ContentBlock[],
				): { content: string; exitCode: number } => {
					if (Array.isArray(raw)) {
						const hasError = raw.some(
							(b) => b.type === "text" && "text" in b && (b.text as string).startsWith("Error:"),
						);
						// Rewrite inline-base64 image blocks to file_ref before persist so
						// a screenshot-sized payload never hits the cap. See tool-result-images.ts.
						const lightened = persistImageBlocksAsFileRefs(raw, this.ctx.db, this.ctx.siteId);
						return { content: JSON.stringify(lightened), exitCode: hasError ? 1 : 0 };
					}
					return { content: raw, exitCode: raw.startsWith("Error:") ? 1 : 0 };
				};

				switch (tool.kind) {
					case "platform": {
						// Platform tools call MCP client.callTool directly via execute closure.
						// This preserves full MCP result structures and bypasses bash command parsing.
						if (!tool.execute) {
							result = {
								content: `Error: platform tool "${toolCall.name}" has no execute handler`,
								exitCode: 1,
							};
							break;
						}
						// biome-ignore lint/suspicious/noExplicitAny: tool.execute result type is either string or BuiltInToolResult
						const platformResult = await (tool.execute as any)(toolCall.input, toolCall.id);
						if (isDeferredToolResult(platformResult)) {
							return platformResult;
						}
						if (isToolResultWithMetadata(platformResult)) {
							result = { ...normalize(platformResult.content), metadata: platformResult.metadata };
							break;
						}
						// Platform tools return strings, but handle both just like builtin does
						result = normalize(platformResult);
						break;
					}

					case "sandbox": {
						if (!this.sandbox.exec) {
							result = { content: "Error: sandbox execution not available", exitCode: 1 };
							break;
						}
						const command = toolCall.input.command;
						if (typeof command !== "string") {
							result = {
								content: `Error: bash tool requires a "command" string parameter`,
								exitCode: 1,
							};
							break;
						}
						const sandboxResult = await this.execSandboxWithTimeout(
							command,
							toolCall.input.timeout,
							toolCall.input.cwd,
						);
						if (isRelayRequest(sandboxResult)) {
							toolSpan.setStatus({ code: SpanStatusCode.OK });
							return sandboxResult; // finally block ends span
						}
						result = {
							content: buildCommandOutput(
								sandboxResult.stdout,
								sandboxResult.stderr,
								sandboxResult.exitCode,
							),
							exitCode: sandboxResult.exitCode,
						};
						// MCP Apps binding: the exec wrapper lifts a UI-bearing tool's
						// {server, tool, uiResourceUri} off the loop-context side-channel
						// onto the result. Carry it through so it lands on the persisted
						// tool_result row's metadata.
						{
							const mcpApp = (sandboxResult as { mcpApp?: McpAppBinding }).mcpApp;
							if (mcpApp) result.mcpApp = mcpApp;
						}
						break;
					}

					default: {
						// "builtin" has execute handler
						if (!tool.execute) {
							result = {
								content: `Error: tool "${toolCall.name}" has no execute handler`,
								exitCode: 1,
							};
							break;
						}
						const builtinResult = await tool.execute(toolCall.input, toolCall.id);
						if (isDeferredToolResult(builtinResult)) {
							return builtinResult;
						}
						if (isToolResultWithMetadata(builtinResult)) {
							result = { ...normalize(builtinResult.content), metadata: builtinResult.metadata };
							break;
						}
						result = normalize(builtinResult);
						break;
					}
				}

				// Cross-tool suggestion. When a model calls the wrong tool, the
				// Zod error enumerates valid options for the CALLED tool but
				// never reveals the params belong to a DIFFERENT tool. Models
				// that confuse two tools re-decide the same wrong routing every
				// turn — observed spins on gpt-5.5 confusing action-value
				// parameters between two similarly-shaped tools (26+/12+ turns)
				// and confusing parameter signatures between tools (60+ turns
				// across three aborts). suggestCorrectTool tries action-value matching first,
				// then falls back to parameter-signature matching. Appended on
				// the FIRST failed call so the model gets the correct tool name
				// immediately, not after the loop guard's 5-turn threshold.
				if (result.exitCode !== 0) {
					const suggestion = suggestCorrectTool(
						toolCall.name,
						toolCall.input,
						this.config.toolRegistry,
					);
					if (suggestion) {
						result = { ...result, content: `${result.content}\n${suggestion}` };
					}
				}

				// Universal tool-result cap. Per-tool caps run first inside their
				// implementations and produce more informative truncation; this is the
				// final backstop for tools that don't enforce their own (native bash
				// passthrough, uncapped MCP-bridged results, etc.).
				const rawOutputSize = result.content.length;
				const cappedContent = capToolResultContent(result.content);
				if (cappedContent !== result.content) {
					this.ctx.logger.warn("[agent-loop] Tool result exceeded universal cap", {
						toolName: toolCall.name,
						toolKind: tool.kind,
						rawSize: rawOutputSize,
					});
					result = { ...result, content: cappedContent };
				}

				// Record I/O sizes for trace analysis
				toolSpan.setAttribute("tool.input_size", JSON.stringify(toolCall.input).length);
				toolSpan.setAttribute("tool.output_size", result.content.length);
				toolSpan.setAttribute("tool.output_size_raw", rawOutputSize);

				// Set span status based on execution result
				if (result.exitCode !== 0) {
					toolSpan.setStatus({
						code: SpanStatusCode.ERROR,
						message: result.content.slice(0, 256),
					});
				} else {
					toolSpan.setStatus({ code: SpanStatusCode.OK });
				}

				return result;
			} catch (err) {
				toolSpan.setAttribute("tool.input_size", JSON.stringify(toolCall.input).length);
				toolSpan.setStatus({
					code: SpanStatusCode.ERROR,
					message: err instanceof Error ? err.message : String(err),
				});
				return {
					content: `Error: ${err instanceof Error ? err.message : String(err)}`,
					exitCode: 1,
				};
			} finally {
				toolSpan.end();
			}
		}

		// Priority 2: Client tools (schema only, execution deferred to client)
		if (this.config.clientTools?.has(toolCall.name)) {
			return {
				clientToolCall: true,
				toolName: toolCall.name,
				callId: toolCall.id,
				arguments: toolCall.input,
			} satisfies ClientToolCallRequest;
		}

		// Built-in tools (read, write, edit) — dispatched before bash fallback
		const builtIn = this.sandbox.builtInTools?.get(toolCall.name);
		if (builtIn) {
			const result = await builtIn.execute(toolCall.input);
			if (Array.isArray(result)) {
				// ContentBlock[] — serialize for persistence, check text blocks for errors
				const hasError = result.some(
					(b) => b.type === "text" && "text" in b && (b.text as string).startsWith("Error:"),
				);
				// Rewrite inline-base64 image blocks to file_ref before persist so
				// a screenshot-sized payload never hits the cap. See tool-result-images.ts.
				const lightened = persistImageBlocksAsFileRefs(result, this.ctx.db, this.ctx.siteId);
				return {
					content: capToolResultContent(JSON.stringify(lightened)),
					exitCode: hasError ? 1 : 0,
				};
			}
			const exitCode = result.startsWith("Error:") ? 1 : 0;
			return { content: capToolResultContent(result), exitCode };
		}

		if (!this.sandbox.exec) {
			return { content: "Error: sandbox execution not available", exitCode: 1 };
		}

		const command = toolCall.input.command;
		if (typeof command !== "string") {
			return {
				content: `Error: unknown tool "${toolCall.name}". Use the bash tool with {"command": "${toolCall.name} ..."}`,
				exitCode: 1,
			};
		}

		const result = await this.execSandboxWithTimeout(
			command,
			toolCall.input.timeout,
			toolCall.input.cwd,
		);

		// The exec wrapper in agent-factory.ts propagates RelayToolCallRequest
		// objects from remote MCP proxy commands via loopContextStorage side-channel
		// (just-bash strips extra fields from custom command return values).
		if (isRelayRequest(result)) {
			return result;
		}

		return {
			content: capToolResultContent(
				buildCommandOutput(result.stdout, result.stderr, result.exitCode),
			),
			exitCode: result.exitCode,
		};
	}

	/** Parse streamed chunks into text and tool calls, handling partial JSON accumulation and ID dedup. */
	protected parseResponseChunks(chunks: StreamChunk[]): ParsedResponse {
		return super.parseResponseChunks(chunks);
	}

	cancel(): void {
		this.aborted = true;
		this.ctx.logger.info("Agent loop cancelled");
	}
}
export { SILENCE_HEARTBEAT_INTERVAL_MS, withSilenceTimeout } from "@bound/loop";
