import type { AppContext } from "@bound/core";
import {
	countBackgroundToolCallsByThread,
	enqueueClientToolCall,
	enqueueToolResult,
	findMessageById,
	getLatestChangeLogHlcForRows,
	listLiveMessageProjectionByThreadNewestFirst,
	recordContextDebug,
	recordTurn,
	recordTurnRelayMetrics,
	resolveRelayConfig,
	updateRow,
} from "@bound/core";
import type {
	ChatParams,
	ContentBlock,
	LLMBackend,
	ModelRouter,
	StreamChunk,
	ToolDefinition,
} from "@bound/llm";
import { LLMRefusalError } from "@bound/llm";
import type { InferenceRequestPayload } from "@bound/llm";
import {
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
	classifyRouteError,
	getLlmRetryAfterMs,
	getLlmStatusCode,
	hasUnparseableArgs,
	scaledMaxRetries,
	scaledSilenceTimeout,
	shouldRetryRelayCall,
} from "@bound/loop";
import type { McpAppBinding } from "@bound/sandbox";
import type {
	ClientToolPayload,
	ContextDebugInfo,
	EventMap,
	RelayConfig,
	SyncConfig,
} from "@bound/shared";
import {
	HLC_ZERO,
	appendToolDuration,
	capToolResultContent,
	clientResultPayloadSchema,
	countTokens,
	errorPayloadSchema,
	formatError,
	injectTraceContext,
	parseJsonSafe,
} from "@bound/shared";
import { getConfirmedSyncWatermark } from "@bound/sync";
import type { Context, Span } from "@opentelemetry/api";
import { SpanStatusCode, context, trace } from "@opentelemetry/api";
import { recordAgentOperationalMetric, recordAgentToolDuration } from "./operational-metrics";

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
	mergeMap,
	of,
	race,
	take,
	throwError,
	timeout,
} from "rxjs";

import { createAdvisory } from "./advisories";
import {
	attachPricingSource,
	buildCommandOutput,
	clampMaxOutputTokens,
	createFileRefResolver,
	deriveCapabilityRequirements,
	getResolvedModelId,
	getResolvedRouteId,
	insertThreadMessage,
	parseContentBlocks,
	resolveTurnCost,
} from "./agent-loop-utils";
import type { selectCacheTtl } from "./cache-prediction";
import { applyActualUsageToContextDebug } from "./context-assembly";
import { resolveClientSessionHost } from "./delegation";
import { segmentAssembledMessages } from "./delegation-segments";
import { trackFilePath } from "./file-thread-tracker";
import { type RelayToolCallRequest, isRelayRequest } from "./mcp-bridge";
import {
	MAX_MODEL_RECONNECT_WAIT_MS,
	type ModelResolution,
	resolveModel,
	resolveTargetCapabilities,
	waitForModelResolution,
} from "./model-resolution";
import {
	type AttemptRecord,
	buildTurnCostBreakdownWithAttempts,
} from "./refusal-fallback-accounting";
import { readUnionResponseEntry } from "./relay-await-helpers";
import { createRelayBackend } from "./relay-backend";
import { type EligibleHost, resolveTopologyRole, routeRelayRequest } from "./relay-router";
import { createRelayStream$ } from "./relay-stream$";
import { type RelayWaitResult, createRelayWait$ } from "./relay-wait$";
import { resolveRequestFallback } from "./resolve-request-fallback";
import { parseModelHint } from "./routing-preferences";
import { fromEventBus } from "./rx-utils";
import {
	THINK_FORCE_SCAN_LIMIT,
	THINK_TOOL_FORCE_AFTER,
	resolveThinkToolChoice,
} from "./think-tool-force";
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
/**
 * Model-visible result for a tool call whose arguments never parsed. A
 * max_tokens diagnosis is made only when the response ended on a length stop;
 * otherwise the arguments are reported as malformed JSON. Never echoes the
 * argument text.
 */
export function unparseableArgsToolResult(toolCall: ParsedToolCall): string {
	const err = toolCall.argsError;
	if (toolCall.truncated) {
		return `Error: tool call arguments were truncated (the response stopped at the output-token limit, finish_reason=length). The "${toolCall.name}" call was cut off before the full arguments could be generated and was not executed. Try breaking the operation into smaller parts, or reduce the size of the arguments.`;
	}
	const detail = err
		? ` (${err.parseError}; finish_reason=${err.finishReason ?? "unknown"}, ${err.argsLength} chars)`
		: "";
	return `Error: tool call arguments for "${toolCall.name}" were not valid JSON${detail}. The call was not executed. Re-issue it with well-formed JSON arguments.`;
}

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

export abstract class BoundAgentLoop extends ModularAgentLoop {
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
		super({ logger: ctx.logger }, config, {
			silenceTimeoutMs: config.silenceTimeoutMs ?? SILENCE_TIMEOUT_MS,
			maxTransientRetries: MAX_SILENCE_RETRIES,
			degenerateRetryMax: MAX_DEGENERATE_RETRIES,
		});
	}

	/**
	 * Output budget used by BOTH context assembly and the wire request. Local and
	 * remote resolutions carry the serving backend's advertised cap; the shared
	 * clamp still provides the conservative fallback for legacy peers that omit it.
	 */
	protected resolvedMaxOutputTokens(resolution: BoundPreparedFrame["resolution"]): number {
		const backendCap =
			resolution.kind === "local" || resolution.kind === "remote"
				? resolution.maxOutputTokens
				: undefined;
		return clampMaxOutputTokens(this.effectiveMaxOutputTokens(), backendCap);
	}

	/**
	 * Resolve the refusal-fallback chain fields to ship on the outgoing request
	 * (R-RT18, §7.3 step 2). Reads the resolved logical model's
	 * `model_routing_rules.fallback_policy` (absent row → auto) and the cluster
	 * `routing.default_fallback_models`, producing the two optional ChatParams /
	 * inference-payload fields. A local driver's inline credit redemption reads
	 * them directly; a relay carrier copies them through so the executing host's
	 * driver sees the same chain. Returns `{}` when the logical model is unknown
	 * so the request simply carries no fallback hint.
	 */
	protected resolveFallbackFields(resolution: BoundPreparedFrame["resolution"]): {
		fallback_policy?: { mode: "auto" | "never" | "custom" };
		fallback_models?: string[];
	} {
		const logicalModel =
			resolution.kind === "local" || resolution.kind === "remote" ? resolution.modelId : undefined;
		if (!logicalModel) return {};
		return resolveRequestFallback(this.ctx.db, logicalModel);
	}

	/** Shared, policy-free model-derived inputs for Main and Aux frame assembly. */
	protected prepareSharedFrameInputs(resolution: BoundPreparedFrame["resolution"]) {
		const firstRemoteHost = resolution.kind === "remote" ? resolution.hosts[0] : undefined;
		const resolvedCaps = resolveTargetCapabilities(resolution, this.modelRouter);
		const mergedTools = this.getMergedTools();
		const contextWindow = resolution.max_context;
		return {
			relayInfo: firstRemoteHost
				? {
						remoteHost: firstRemoteHost.host_name,
						localHost: this.ctx.hostName,
						model: resolution.modelId,
						provider: "remote",
					}
				: undefined,
			resolvedCaps,
			cacheMarkerCaps: resolvedCaps,
			contextWindow,
			mergedTools,
			toolTokenEstimate: mergedTools ? countTokens(JSON.stringify(mergedTools)) : 0,
			resolvedModelForDebug: getResolvedModelId(resolution, this.config.modelId),
			maxOutputTokens: this.resolvedMaxOutputTokens(resolution),
		};
	}

	/** Bound owns the reset/activity/phase boundary; subclasses only prepare policy state. */
	protected async prepareTurn(_turn: number, _frame: BoundPreparedFrame): Promise<void> {}

	protected override async beforeTurn(turn: number, frame: BoundPreparedFrame): Promise<void> {
		this.currentTurnId = null;
		this.relayMetadataRef = {};
		this.config.onActivity?.();
		await this.prepareTurn(turn, frame);
		this.setPhase("LLM_CALL");
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
		// §5.4: a model hint of the form `logical_model@RouteId` hard-pins the route
		// (failover + substitution disabled). §5.3: an unpinned call resolves
		// thread-sticky, reusing the thread's last ok route while it is warm+eligible.
		const { logicalModel: hintedModel, pin } = parseModelHint(this.config.modelId);
		const resolvePrefs = {
			threadId: this.config.threadId,
			pin,
		} as const;
		this.lastModelResolution = resolveModel(
			hintedModel,
			this.modelRouter,
			this.ctx.db,
			this.ctx.siteId,
			this.requirements,
			resolvePrefs,
		);
		// A stale host row means the requested remote model is known but its relay
		// is reconnecting. Wait here, at inference dispatch only: resolveModel()
		// itself remains synchronous for startup, model listing, and validation.
		// A hintless loop waits too: an omitted hint resolves the default afresh on
		// every poll, so a self-configuring namespace placeholder that is still
		// warming up resolves to the default its discovery selects (#296).
		this.lastModelResolution = await waitForModelResolution({
			initial: this.lastModelResolution,
			resolve: () =>
				resolveModel(
					hintedModel,
					this.modelRouter,
					this.ctx.db,
					this.ctx.siteId,
					this.requirements,
					resolvePrefs,
				),
			timeoutMs: Math.min(this.inferenceTimeoutMs, MAX_MODEL_RECONNECT_WAIT_MS),
			signal: this.config.abortSignal,
		});

		if (this.lastModelResolution.kind === "error" && this.config.modelId !== undefined) {
			// No same-tier (or any-model) substitution: under the routing redesign
			// (R-RT7, R-RT8) a model whose routes are all down returns
			// transient-unavailable and is NOT substituted onto a different model.
			// Cross-model fallback happens only on a model refusal (slice 5).
			//
			// §6.3/R-RT23: a `unknown-model` reason means the model is advertised by
			// no non-deleted host in the cluster — decommissioned, not momentarily
			// down. An existing thread targeting it must be prompted to pick another
			// model (never silently substituted), with language distinct from a
			// transient outage so the operator knows retrying won't help.
			if (this.lastModelResolution.reason === "unknown-model") {
				return {
					kind: "error",
					error: `Model "${this.config.modelId}" is no longer available anywhere in the cluster (decommissioned). Pick another model for this thread — Bound will not substitute one automatically. Details: ${this.lastModelResolution.error}`,
				};
			}
			return {
				kind: "error",
				error: `Failed to resolve requested model "${this.config.modelId}": ${this.lastModelResolution.error}`,
			};
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
		const result: AgentLoopResult = {
			messagesCreated: this.messagesCreated,
			toolCallsMade: this.toolCallsMade,
			filesChanged: this.filesChanged,
			outcome: "completed",
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
		const forcedThinkChoice = this.resolveThinkForce(resolution);
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
				threadId: this.config.threadId,
				model: resolution.modelId,
				segments,
				nowMs: frame.assembled.assemblyNowMs,
				tools: frame.mergedTools,
				system: frame.assembled.systemPrompt || undefined,
				max_tokens: this.resolvedMaxOutputTokens(resolution),
				temperature: undefined,
				...(resolution.thinkingConfig && { thinking: resolution.thinkingConfig }),
				...(forcedThinkChoice && { tool_choice: forcedThinkChoice }),
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
					maxPayloadBytes: this.relayConfig.max_payload_bytes,
					topologyRole: resolveTopologyRole(this.ctx.optionalConfig),
				},
				inferencePayload,
				resolution.hosts,
				aborted$,
				this.relayMetadataRef,
				{
					perHostTimeoutMs: this.inferenceTimeoutMs,
					firstTokenTimeoutMs: this.firstTokenTimeoutMs,
				},
			);
			return {
				chunks: this.withRestoredPhase(observableToAsyncIterable(relayStream), previousState),
				useSilenceTimeout: false,
			};
		}

		const totalEstimatedTokens =
			(this.lastContextDebug?.totalEstimated ?? 0) + frame.toolTokenEstimate;
		const effectiveSilenceTimeout = scaledSilenceTimeout(
			this.config.silenceTimeoutMs ?? SILENCE_TIMEOUT_MS,
			totalEstimatedTokens,
		);
		this.currentDriverSpan = getTracer().startSpan("llm-driver.chat", {
			attributes: {
				"llm.model": getResolvedModelId(this.lastModelResolution, this.config.modelId || "unknown"),
				"llm.provider": "local",
			},
		});
		const silenceAbortController = new AbortController();
		const abortOnParentAbort = () => silenceAbortController.abort();
		this.config.abortSignal?.addEventListener("abort", abortOnParentAbort, { once: true });
		const source = resolution.backend.chat({
			threadId: this.config.threadId,
			messages: frame.messages,
			system: frame.assembled.systemPrompt || undefined,
			tools: frame.mergedTools,
			max_tokens: this.resolvedMaxOutputTokens(resolution),
			thinking: resolution.thinkingConfig,
			effort: resolution.effort,
			...(forcedThinkChoice && { tool_choice: forcedThinkChoice }),
			cache_ttl: resolution.cacheTtl,
			// Resolve the refusal-fallback chain (R-RT18) and ship it so a local
			// driver's inline credit redemption sees the policy + ordered candidate
			// list. For a remote turn the relay carrier copies these through.
			...this.resolveFallbackFields(resolution),
			resolveFileRef: createFileRefResolver(this.ctx.db),
			signal: silenceAbortController.signal,
		});
		return {
			chunks: this.withSilenceAbort(
				source,
				effectiveSilenceTimeout,
				silenceAbortController,
				abortOnParentAbort,
			),
			useSilenceTimeout: false,
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

	private async *withSilenceAbort<T>(
		source: AsyncIterable<T>,
		timeoutMs: number,
		controller: AbortController,
		abortOnParentAbort: () => void,
	): AsyncGenerator<T> {
		try {
			yield* super.withSilenceTimeout(
				source,
				timeoutMs,
				() => this.config.onActivity?.(),
				() => controller.abort(),
			);
		} catch (error) {
			// Abort before the timeout wrapper finalizes the iterator so a stalled
			// backend can release its pending next() call.
			controller.abort();
			throw error;
		} finally {
			this.config.abortSignal?.removeEventListener("abort", abortOnParentAbort);
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
	 * Bound route-failure policy (#265/#285, spec §6.1/§7.1, R-RT11–R-RT13). The
	 * base loop already spent its same-route transient retry budget; this hook
	 * fires for EVERY classified route failure — rate limit, 402/quota, auth, 5xx,
	 * driver-bug 400, transport. It records the failure against the local route's
	 * health (moving it to `backoff`) and fails over to the NEXT ranked route for
	 * the SAME logical model — local or remote (R-RT7/R-RT8). There is no
	 * cross-model substitution: switching models happens only on a refusal.
	 * Returns a retry decision when another route is found (or when an auth
	 * refresh left the route healthy), or null to fall through to terminal
	 * handling, which reports the accumulated failover chain.
	 */
	protected override async onRouteFailure(
		error: unknown,
		frame: BoundPreparedFrame,
	): Promise<LoopTurnDecision | null> {
		const resolution = this.lastModelResolution;
		if (resolution?.kind === "remote") {
			// A remote attempt is the end of this loop's failover chain (the relay
			// already walked the remote candidate hosts), but it still belongs in the
			// chain: local route A failing over to a remote route that also fails
			// must surface both causes, not only the remote one.
			this.routeFailureChain.push({
				routeId: this.currentRouteLabel() ?? resolution.modelId,
				error: formatError(error),
			});
			this.routeFailureRecordedFor = error;
			return null;
		}
		const backendId = resolution?.kind === "local" ? resolution.modelId : null;
		if (!backendId) {
			return null;
		}
		this.routeFailureChain.push({
			routeId: this.currentRouteLabel() ?? backendId,
			error: formatError(error),
		});
		this.routeFailureRecordedFor = error;
		this.failedOverBackends.add(backendId);
		// Record the failure against route health with the classified kind so the
		// backoff schedule (and R-RT13 advisory handling) react to the real error.
		// A supplied Retry-After / usage-limit reset is honored for rate limits.
		const backedOff = await this.recordRouteFailure(backendId, error);
		if (!backedOff) {
			// An auth refresh rotated the credentials and left the route healthy:
			// retry the same route once with the new token. The refresh is
			// single-shot per backend, so a second 401 backs off and fails over.
			this.failedOverBackends.delete(backendId);
			this.transportRetries = 0;
			return { action: "retry" };
		}
		// Re-resolve the SAME logical model: the unified candidate pool (§5.1) now
		// excludes the cooled route and returns the next ranked route for this
		// model (another local route or a remote host). Cross-route failover strips
		// route-bound state at the boundary via the driver's reasoning_origin check.
		const newResolution = resolveModel(
			this.config.modelId,
			this.modelRouter,
			this.ctx.db,
			this.ctx.siteId,
			this.requirements,
		);
		if (newResolution.kind === "error") {
			return null;
		}
		// Never re-enter a route that already failed this turn — an exhausted
		// chain ends in terminal handling instead of cycling.
		if (newResolution.kind === "local" && this.failedOverBackends.has(newResolution.modelId)) {
			return null;
		}
		this.ctx.logger.warn("[agent-loop] Route failure, failing over to next route", {
			from: backendId,
			to: newResolution.kind === "local" ? newResolution.modelId : "remote",
			errorKind: classifyRouteError(error),
		});
		this.lastModelResolution = newResolution;
		frame.resolution = newResolution;
		this.transportRetries = 0;
		return { action: "retry" };
	}

	/**
	 * Routes that failed within the current model call's failover chain, in
	 * order, with their error text. Reported in the terminal error so the
	 * operator sees every route's cause, not only the last one (#265). Cleared
	 * on a successful turn.
	 */
	private routeFailureChain: Array<{ routeId: string; error: string }> = [];

	/** Local backends already failed over away from in the current chain. */
	private failedOverBackends = new Set<string>();

	/** The error onRouteFailure last recorded, so terminal handling never double-records it. */
	private routeFailureRecordedFor: unknown = undefined;

	/**
	 * Advisory-dedup set: driver-bug `400` and auth-refresh-failure advisories are
	 * raised at most once per backend per loop lifetime (R-RT13 — "a SINGLE
	 * advisory"). A fresh loop instance per turn would re-raise, so the set lives
	 * on the per-thread cached turn state is overkill here; the spec's intent is
	 * "don't spam", which the advisories layer's own idempotency does not cover.
	 * Kept instance-local: the dominant spam source is the half-open retry storm
	 * within one turn's failover chain, all on one loop instance.
	 */
	private routeAdvisoriesRaised = new Set<string>();

	/**
	 * Record a classified route failure against the local route's health (#285,
	 * spec §6.1, R-RT11/R-RT13) and apply the error-specific handling:
	 *
	 * - `auth` (401/403): attempt a silent token refresh via the driver's
	 *   `refreshAuth` hook FIRST. A successful refresh does NOT trip backoff — the
	 *   route stays healthy so the turn's transport retry re-sends with the rotated
	 *   token. Only a failed or unsupported refresh backs the route off and raises
	 *   a re-login advisory, because re-login needs a human.
	 * - `driver_bug` (sustained non-refusal 400s): back off and raise a single
	 *   advisory while half-open recovery keeps running.
	 * - everything else: back off on the exponential schedule (or the exact
	 *   Retry-After for a rate limit).
	 *
	 * Returns true if the route was backed off, false if an auth refresh succeeded
	 * and the route was left healthy for an immediate retry.
	 */
	protected async recordRouteFailure(backendId: string, error: unknown): Promise<boolean> {
		// A model refusal (R-RT15) is NOT a route failure: the request reached the
		// model and a safety classifier declined it. It must never touch route health
		// — no backoff, no advisory — even though it arrives as a 400-shaped error.
		if (error instanceof LLMRefusalError) {
			return false;
		}
		const errorKind = classifyRouteError(error);
		const retryAfterMs = getLlmRetryAfterMs(error);

		if (errorKind === "auth") {
			const backend = this.modelRouter.tryGetBackend(backendId);
			// R-RT13: try a token refresh before tripping backoff. Attempt it at most
			// once per backend per loop — a 401 that survives a fresh token is a real
			// auth failure, not a stale-token blip.
			if (backend?.refreshAuth && !this.authRefreshAttempted.has(backendId)) {
				this.authRefreshAttempted.add(backendId);
				let refreshed = false;
				try {
					refreshed = await backend.refreshAuth();
				} catch {
					refreshed = false;
				}
				if (refreshed) {
					// Credentials rotated: leave the route healthy so the turn retries
					// immediately with the new token. No backoff, no advisory.
					return false;
				}
			}
			// No refresh hook, refresh already tried, or refresh failed → back off and
			// raise a re-login advisory (human action required).
			this.modelRouter.recordRouteFailure(backendId, { errorKind, retryAfterMs });
			this.raiseRouteAdvisoryOnce(backendId, "auth", error);
			return true;
		}

		this.modelRouter.recordRouteFailure(backendId, { errorKind, retryAfterMs });
		if (errorKind === "driver_bug") {
			this.raiseRouteAdvisoryOnce(backendId, "driver_bug", error);
		}
		return true;
	}

	/** Backends whose auth refresh has been attempted this loop (R-RT13 single-shot). */
	private authRefreshAttempted = new Set<string>();

	/**
	 * Raise a route-health operator advisory at most once per backend+kind per loop
	 * (R-RT13 — "a single advisory"). `auth` means a token refresh failed and
	 * re-login is required; `driver_bug` means the provider keeps returning
	 * malformed-request 400s that are not refusals.
	 */
	private raiseRouteAdvisoryOnce(
		backendId: string,
		kind: "auth" | "driver_bug",
		error: unknown,
	): void {
		const dedupKey = `${kind}:${backendId}`;
		if (this.routeAdvisoriesRaised.has(dedupKey)) return;
		this.routeAdvisoriesRaised.add(dedupKey);
		const routeId = this.modelRouter.getRouteId(backendId) ?? backendId;
		const detail = error instanceof Error ? error.message : String(error);
		try {
			if (kind === "auth") {
				createAdvisory(
					this.ctx.db,
					{
						type: "route_auth_expired",
						status: "proposed",
						title: `Route ${routeId} auth expired — re-login required`,
						detail: `A token refresh for route ${routeId} failed, so the route is backing off. Re-authenticate the provider (e.g. \`bound login\`) to restore it. Underlying error: ${detail}`,
						action: null,
						impact:
							"This route is unavailable until its credentials are refreshed; turns fail over to other routes for the same model.",
						evidence: detail,
					},
					this.ctx.siteId,
					this.config.threadId,
				);
			} else {
				createAdvisory(
					this.ctx.db,
					{
						type: "route_driver_bug",
						status: "proposed",
						title: `Route ${routeId} returning malformed-request errors`,
						detail: `Route ${routeId} keeps returning non-refusal 400 errors (a driver/provider bug, not a safety refusal). The route backs off and keeps auto-recovering via half-open trials, so a deployed fix is picked up without operator action. Underlying error: ${detail}`,
						action: null,
						impact:
							"Turns fail over to other routes for the same model while this route recovers automatically.",
						evidence: detail,
					},
					this.ctx.siteId,
					this.config.threadId,
				);
			}
		} catch (advisoryError) {
			this.ctx.logger.warn("[agent-loop] Failed to raise route-health advisory", {
				backendId,
				kind,
				error: advisoryError instanceof Error ? advisoryError.message : String(advisoryError),
			});
		}
	}
	/**
	 * Bound terminal model-error handling: salvage any partial streamed text into
	 * a developer message so work isn't lost, then emit an alert and end the turn
	 * with an error. Runs once base retries + rate-limit fallback are exhausted.
	 */
	protected override async onModelErrorTerminal(
		error: unknown,
		chunks: StreamChunk[],
	): Promise<LoopTurnDecision> {
		// Record the route failure against health before surfacing the error (#285,
		// R-RT11/R-RT13). onRouteFailure already recorded every route failure it saw
		// (and fell through here only when no further route existed), so record only
		// errors that bypassed it — never double-increment the same failure's backoff.
		// A local resolution is required to know which backend to cool.
		if (
			this.lastModelResolution?.kind === "local" &&
			this.routeFailureRecordedFor !== error &&
			!this.aborted
		) {
			const backendId = this.lastModelResolution.modelId;
			try {
				await this.recordRouteFailure(backendId, error);
			} catch (recordError) {
				this.ctx.logger.warn("[agent-loop] Failed to record terminal route failure", {
					backendId,
					error: recordError instanceof Error ? recordError.message : String(recordError),
				});
			}
		}
		const failureChain = [...this.routeFailureChain];
		// An error that bypassed onRouteFailure (not a classified route failure)
		// still ends a chain that earlier routes started: append it so the
		// surfaced error keeps every earlier route's cause.
		if (failureChain.length > 0 && this.routeFailureRecordedFor !== error) {
			failureChain.push({
				routeId: this.currentRouteLabel() ?? "unknown route",
				error: formatError(error),
			});
		}
		this.resetRouteFailureChain();
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
		const finalError = formatRouteFailureChain(formatError(error), failureChain);
		this.emitAlert(`Error: ${finalError}`);
		return { action: "error", error: finalError };
	}

	/**
	 * Operator-facing label for the route the current resolution targets: the
	 * local backend's RouteId, or the remote host's advertised RouteId (falling
	 * back to the candidate host names) for a relayed attempt.
	 */
	private currentRouteLabel(): string | null {
		const resolution = this.lastModelResolution;
		if (resolution?.kind === "local") {
			return this.modelRouter.getRouteId(resolution.modelId) ?? resolution.modelId;
		}
		if (resolution?.kind === "remote") {
			const advertised = resolution.hosts.find((h) => h.routeId)?.routeId;
			if (advertised) return advertised;
			const names = resolution.hosts.map((h) => h.host_name).join("/");
			return names ? `${names}:${resolution.modelId}` : resolution.modelId;
		}
		return null;
	}

	/** Start a fresh failover chain (after a served turn or a surfaced terminal error). */
	private resetRouteFailureChain(): void {
		this.routeFailureChain = [];
		this.failedOverBackends.clear();
		this.routeFailureRecordedFor = undefined;
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
			// Cost precedence (CONTRIBUTING.md invariant #17). A done-chunk cost can
			// come from two places: a relay hub (remote resolution) that already
			// applied the operator-pricing-over-provider precedence before stamping,
			// OR a local provider driver (e.g. Copilot) that stamped its own catalog
			// cost. For a REMOTE turn the relayed cost is authoritative and recorded
			// verbatim — including an explicit 0 — since the executing host owns the
			// pricing config this (often hub-only) spoke may lack. For a LOCAL turn the
			// stamped cost is just a provider-reported value, so resolveTurnCost lets
			// explicit operator pricing win over it (explicit pricing > provider cost
			// > 0); absent operator pricing it falls through to the provider's cost.
			// Resolve BOTH the authoritative cost and its component breakdown so the
			// turn row records parts that sum to the recorded cost. For a REMOTE turn
			// the relayed cost+breakdown are authoritative (recorded verbatim); for a
			// LOCAL turn resolveTurnCost lets explicit operator pricing win over a
			// provider-stamped cost, and returns the matching breakdown (null when
			// the model is priced only by a plain-number price(turn) callback).
			let cost_usd: number | null;
			let cost_breakdown: {
				input?: number;
				output?: number;
				cacheRead?: number;
				cacheWrite?: number;
				// Which pricing layer priced the turn (requirement 3). Persisted inside
				// cost_breakdown so provenance survives even when there is no numeric
				// split (a plain-number price(turn) callback → source-only object).
				source?: string;
			} | null;
			if (this.lastModelResolution?.kind === "remote") {
				if (metrics.response.costUsdFromHub !== null) {
					// Hub already applied the precedence and stamped the cost; record it
					// and its relayed breakdown (which already carries the hub's source)
					// verbatim.
					cost_usd = metrics.response.costUsdFromHub;
					cost_breakdown = metrics.response.costBreakdownFromHub;
				} else {
					const catalogPricing = this.modelRouter.getResolvedPricing(resolvedModelId);
					const resolved = resolveTurnCost({
						modelId: resolvedModelId,
						usage: metrics.response.usage,
						backends,
						providerCostUsd: undefined,
						catalogPricing: catalogPricing?.pricing,
						catalogPricingSource: catalogPricing?.source,
					});
					cost_usd = resolved.cost;
					cost_breakdown = attachPricingSource(resolved.breakdown, resolved.source);
				}
			} else {
				const catalogPricing = this.modelRouter.getResolvedPricing(resolvedModelId);
				const resolved = resolveTurnCost({
					modelId: resolvedModelId,
					usage: metrics.response.usage,
					backends,
					providerCostUsd: metrics.response.costUsdFromHub,
					providerBreakdown: metrics.response.costBreakdownFromHub,
					catalogPricing: catalogPricing?.pricing,
					catalogPricingSource: catalogPricing?.source,
				});
				cost_usd = resolved.cost;
				cost_breakdown = attachPricingSource(resolved.breakdown, resolved.source);
			}

			// Per-attempt provenance (slice 5, R-RT21, §7.4). A driver-level inline
			// credit redemption surfaces the refused primary attempt AND the served
			// retry as distinct `done` chunks on one stream, captured in
			// `response.attempts`. Record each separately in `cost_breakdown` (never
			// summing tokens across models) and emit the dedicated observability
			// events. A single clean attempt keeps the bare four-component breakdown,
			// byte-identical to a pre-slice-5 turn.
			const routeId = getResolvedRouteId(this.lastModelResolution, (id) =>
				this.modelRouter.getRouteId(id),
			);
			const parsedAttempts = metrics.response.attempts;
			let finalCostBreakdown:
				typeof cost_breakdown | ReturnType<typeof buildTurnCostBreakdownWithAttempts> =
				cost_breakdown;
			const substitutedFrom: string | null = null;
			if (parsedAttempts.length > 1) {
				const attemptRecords: AttemptRecord[] = parsedAttempts.map((a) => {
					const attemptCatalogPricing = this.modelRouter.getResolvedPricing(resolvedModelId);
					const attemptCost = resolveTurnCost({
						modelId: resolvedModelId,
						usage: {
							inputTokens: a.usage.inputTokens,
							outputTokens: a.usage.outputTokens,
							cacheReadTokens: a.usage.cacheReadTokens,
							cacheWriteTokens: a.usage.cacheWriteTokens,
							cacheWrite1hTokens: a.usage.cacheWrite1hTokens,
							...(a.usage.cacheWriteSplit !== undefined && {
								cacheWriteSplit: a.usage.cacheWriteSplit,
							}),
						},
						backends,
						providerCostUsd: a.costUsdFromHub ?? undefined,
						providerBreakdown: a.costBreakdownFromHub ?? undefined,
						// Price the attempt from the same catalog layer the served turn uses,
						// so an attempt whose model carries no explicit config override is
						// still priced instead of coalescing to a misleading $0 (requirement 2).
						catalogPricing: attemptCatalogPricing?.pricing,
						catalogPricingSource: attemptCatalogPricing?.source,
					});
					return {
						model_id: resolvedModelId,
						route_id: routeId,
						outcome: a.declined ? "refusal" : "ok",
						refusal_category: a.declined?.category ?? null,
						credit_redeemed: false,
						tokens: {
							input: a.usage.inputTokens,
							output: a.usage.outputTokens,
							cache_read: a.usage.cacheReadTokens ?? 0,
							cache_write: a.usage.cacheWriteTokens ?? 0,
						},
						// Unknown (null) stays null, not $0: an unpriced attempt renders as an
						// em dash in the provenance footer rather than a free turn.
						cost_usd: attemptCost.cost,
					};
				});
				finalCostBreakdown = buildTurnCostBreakdownWithAttempts({
					served: cost_breakdown,
					attempts: attemptRecords,
				});
			}

			// Observability events for every refusal + each fallback walk (R-RT21),
			// independent of HTTP error metrics. A refused attempt followed by a served
			// one is a substitution; the served attempt's absence (every attempt
			// refused) is a surfaced refusal with no substitute.
			this.emitRefusalAndFallbackEvents(parsedAttempts, resolvedModelId, routeId);
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
					cost_breakdown: finalCostBreakdown,
					// Route provenance for thread-sticky routing (§5.3): the RouteId that
					// served this turn so the NEXT turn can reuse it while warm+eligible.
					// substituted_from records the originally requested logical model when a
					// refusal fallback substituted another model (R-RT20).
					substituted_from: substitutedFrom,
					route_id: routeId,
					status: metrics.status === "success" ? "ok" : metrics.status,
					created_at: new Date().toISOString(),
				},
				this.ctx.siteId,
			);
			this.currentTurnId = turnId;
			// Record a route SUCCESS against local health (#285, R-RT12): a completed
			// local turn is the real-traffic trial that brings a recovering route back
			// to `healthy`, and keeps a healthy route healthy. This is the ONLY live
			// success input into route health — before this wiring no live turn ever
			// recorded success, so no route could leave backoff/half_open. Remote turns
			// ran on the executing host and recorded success in ITS own loop; this host
			// only tracks health for its local routes.
			if (metrics.status === "success" && this.lastModelResolution?.kind === "local") {
				this.modelRouter.recordRouteSuccess(this.lastModelResolution.modelId);
			}
			if (metrics.status === "success") {
				this.resetRouteFailureChain();
			}
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
						reasoningOrigin: parsed.thinkingReasoningOrigin,
					},
					[],
				),
			);
		} else {
			assistantContent = parsed.textContent || "";
		}
		// A `content-filter` finish is a model refusal: the request reached the
		// model and a safety classifier declined it. Per R-RT16 the refused
		// partial output must NEVER be persisted as an ordinary assistant
		// `messages` row — on the next turn the model would otherwise read that
		// partial as a complete reply it wrote. Surface an operator alert instead
		// and end the turn without retrying.
		if (parsed.finishReason === "content-filter") {
			this.emitAlert(
				"Model safety filter stopped generation (finishReason=content-filter). " +
					"The refused partial output was not persisted; the turn was not retried.",
			);
			return;
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
	}

	protected override beforeToolRoundTrip(
		_parsed: ParsedResponse,
		_frame: BoundPreparedFrame,
		_turn: number,
	): LoopTurnDecision {
		// A normal queued message must not preempt a tool round after the model has
		// requested it. Finish execution and persist every tool result first; then
		// afterToolPersistence yields so the next dispatch rebuilds context with the
		// queued message. Explicit aborts still travel through abortSignal.
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

			if (hasUnparseableArgs(toolCall)) {
				results.push({
					toolCall,
					result: {
						content: unparseableArgsToolResult(toolCall),
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
											topologyRole: resolveTopologyRole(this.ctx.optionalConfig),
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
				reasoningOrigin: parsed.thinkingReasoningOrigin,
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
			// Include tool-provided metadata in the insert event. A follow-up metadata
			// update can share the insert's millisecond modified_at and be dropped by a
			// peer's LWW replay before its aux/background stamp has replicated.
			const metadata: Record<string, unknown> = { ...result.metadata };
			if (result.mcpApp) metadata.mcp_app = result.mcpApp;
			if (result.deferred) metadata.background = true;
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
					metadata: Object.keys(metadata).length > 0 ? metadata : undefined,
				},
				this.ctx.siteId,
			);
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
			const stillDeferred: LoopToolExecutionBatch["deferred"] = [];
			for (const pending of batch.deferred) {
				const { toolCall } = pending;
				const connectionId = this.config.connectionId;
				if (connectionId) {
					// A local client result arrives asynchronously after this loop exits.
					stillDeferred.push(pending);
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

				const sessionHost = resolveClientSessionHost(
					this.ctx.db,
					this.config.threadId,
					this.ctx.siteId,
				);
				if (!sessionHost) {
					this.ctx.logger.error("Client tool call without a live session anywhere", {
						tool: toolCall.name,
						callId: toolCall.id,
						threadId: this.config.threadId,
					});
					batch.results.push({
						toolCall,
						result: {
							content: `Error: no live boundless/client session for this thread on any host; cannot run client tool "${toolCall.name}"`,
							exitCode: 1,
							durationMs: 0,
						},
					});
					continue;
				}

				// A remote client result is awaited synchronously, so it belongs to this
				// active loop and can take the normal persistence/continuation track.
				const remoteResult = await this.relayDeferredClientTool(toolCall, sessionHost);
				batch.results.push({ toolCall, result: remoteResult });
			}
			batch.deferred.splice(0, batch.deferred.length, ...stillDeferred);
			if (stillDeferred.length > 0) return { action: "stop" };
		}

		if (this.config.shouldYield?.()) {
			this.yielded = true;
			return { action: "yield" };
		}
		return { action: "continue" };
	}

	/**
	 * Relay a client tool to the remote host holding the thread's live WS
	 * session and wait for its result (R-UD5/R-UD8/R-UD12).
	 *
	 * Unlike the local client path, this call is synchronous from the producer's
	 * perspective: the result returns to the active loop, joins `batch.results`,
	 * and is persisted into the live frame before the next inference turn. It
	 * must not enqueue a second tool-result wakeup for work already completed.
	 */
	protected async relayDeferredClientTool(
		toolCall: ParsedToolCall,
		sessionHost: EligibleHost,
	): Promise<ToolExecutionResult> {
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
		const clientToolKey = `client-tool:${this.config.threadId}:${toolCall.id}`;
		let awaitId: string;
		try {
			const routed = context.with(dispatchCtx, () =>
				routeRelayRequest(this.ctx.db, {
					targetSiteId: sessionHost.site_id,
					sourceSiteId: this.ctx.siteId,
					kind: "client_tool",
					payload: JSON.stringify(payload),
					timeoutMs,
					idempotencyKey: clientToolKey,
					traceContext: traceCarrier ? JSON.stringify(traceCarrier) : undefined,
					topologyRole: resolveTopologyRole(this.ctx.optionalConfig),
				}),
			);
			if (routed.path === "error") throw new Error(routed.reason);
			awaitId = routed.id;
		} catch (error) {
			this.ctx.logger.error("[agent-loop] Failed to write client_tool relay request", {
				tool: toolCall.name,
				callId: toolCall.id,
				host: sessionHost.host_name,
				error: error instanceof Error ? error.message : String(error),
			});
			return {
				content: `Error: failed to relay client tool "${toolCall.name}" to session host: ${formatError(error)}`,
				exitCode: 1,
				durationMs: 0,
			};
		}

		this.ctx.logger.info("[agent-loop] Relaying client tool to session host", {
			tool: toolCall.name,
			callId: toolCall.id,
			host: sessionHost.host_name,
			outboxEntryId: awaitId,
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
			resolved = await firstValueFrom(this.createClientResultWait$(awaitId, timeoutMs, aborted$), {
				defaultValue: null,
			});
		} finally {
			clearInterval(abortCheck);
			this.restorePhase(previousRelayState);
		}

		if (resolved) {
			return {
				content: capToolResultContent(resolved.content),
				exitCode: resolved.isError ? 1 : 0,
				durationMs: 0,
			};
		}
		return {
			content: capToolResultContent(
				`Error: client tool "${toolCall.name}" relay timed out or the session dropped before returning a result (retriable)`,
			),
			exitCode: 1,
			durationMs: 0,
		};
	}

	/**
	 * Wait for a `client_result` (or `error`) relay response correlated to
	 * `outboxEntryId`, mirroring {@link createRelayWait$}'s inbox correlation
	 * (initial read + `relay:inbox` event wakeups, with a hard timeout). Resolves
	 * to the executed tool output, or null on timeout / abort. A deterministically
	 * unparseable payload is settled (consumed, not left claimed) and resolves to
	 * `{ content: "Error: malformed client_result payload", isError: true }` — poison
	 * is not retriable, mirroring {@link awaitPlatformRequestResponse}'s parse-failure
	 * disposition (settle-then-error) in relay-await-helpers.
	 */
	private createClientResultWait$(
		outboxEntryId: string,
		timeoutMs: number,
		aborted$: Observable<unknown>,
	): Observable<{ content: string; isError: boolean } | null> {
		const db = this.ctx.db;
		const eventBus = this.ctx.eventBus;
		// 4D-D union read: a client_result (or error) response lands in legacy
		// relay_inbox (pre-drop) or the durable spool (post-4E). readUnionResponseEntry
		// claims a durable row under a fresh token and defers its ack to settle();
		// a legacy row's markProcessed is likewise deferred. We settle() only AFTER
		// taking delivery (parse) below, matching the claim → deliver → ack ordering
		// awaitPlatformRequestResponse uses so a mid-flight capability flip still resolves.
		const unionRead = () => readUnionResponseEntry(db, outboxEntryId, this.ctx.siteId);
		const response$ = merge(
			defer(() => of(unionRead())),
			fromEventBus(eventBus, "relay:inbox").pipe(
				filter((event) => event.ref_id === outboxEntryId),
				map(() => unionRead()),
			),
		).pipe(
			filter((entry): entry is NonNullable<typeof entry> => entry !== null && entry !== undefined),
			// Parse + settle BEFORE take(1). Deliver BEFORE ack: settle() the row,
			// then emit its outcome. A deterministically-unparseable client_result is
			// POISON, not a transient fault: leaving it claimed would let a boot-reset
			// return it to pending and re-emit the same garbage forever until TTL.
			// Match the reference (awaitPlatformRequestResponse settle()s then throws
			// on a parse failure): settle() to consume it — it was delivered to its
			// only consumer — then emit a parse-error outcome through the same channel
			// an error-kind row uses, rather than EMPTY-and-keep-waiting.
			mergeMap((entry) => {
				if (entry.kind === "client_result") {
					const parsed = parseJsonSafe(clientResultPayloadSchema, entry.payload, entry.kind);
					entry.settle();
					if (!parsed.ok) {
						return of({ content: "Error: malformed client_result payload", isError: true });
					}
					return of({ content: parsed.value.content, isError: parsed.value.is_error });
				}
				if (entry.kind === "error") {
					const parsed = parseJsonSafe(errorPayloadSchema, entry.payload, entry.kind);
					entry.settle();
					const message = parsed.ok ? parsed.value.error : entry.payload;
					return of({ content: `Error: ${message}`, isError: true });
				}
				entry.settle();
				return of({
					content: `Error: unexpected relay response kind "${entry.kind}"`,
					isError: true,
				});
			}),
			take(1),
			timeout(timeoutMs),
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

	/**
	 * Emit the dedicated refusal/fallback observability events (slice 5, R-RT21,
	 * §7.4), independent of HTTP error-rate monitoring. Fires `llm:refusal` for
	 * every classified refusal attempt, and `llm:fallback` once per walk when a
	 * refused attempt was followed by further attempts (the substitution outcome).
	 * A clean single-attempt turn emits nothing.
	 */
	private emitRefusalAndFallbackEvents(
		attempts: ParsedResponse["attempts"],
		modelId: string,
		routeId: string | null,
	): void {
		const refusedAttempts = attempts.filter((a) => a.declined !== null);
		if (refusedAttempts.length === 0) return;
		for (const attempt of refusedAttempts) {
			const declined = attempt.declined;
			if (!declined) continue;
			this.ctx.eventBus.emit("llm:refusal", {
				thread_id: this.config.threadId,
				...(this.config.taskId ? { task_id: this.config.taskId } : {}),
				model: modelId,
				route_id: routeId,
				vendor: declined.vendor,
				category: declined.category,
				substitutable: declined.substitutable,
			});
		}
		// A served attempt following the refusal(s) means a substitution carried the
		// turn; its absence means every attempt refused and the refusal surfaced.
		const served = attempts.find((a) => a.declined === null);
		const substituted = attempts.length > refusedAttempts.length ? served : undefined;
		this.ctx.eventBus.emit("llm:fallback", {
			thread_id: this.config.threadId,
			...(this.config.taskId ? { task_id: this.config.taskId } : {}),
			refused_model: modelId,
			// The driver-level credited retry stays on the same request's endpoint, so
			// the substitute logical model is the same requested model when a served
			// attempt followed; null when every attempt refused.
			substitute_model: substituted ? modelId : null,
			// Credit redemption is a driver-internal step the loop cannot observe from
			// the stream alone; recorded false here (the driver owns the redemption).
			credit_redeemed: false,
			policy_mode:
				(this.lastModelResolution?.kind === "local" || this.lastModelResolution?.kind === "remote"
					? this.resolveFallbackFields(this.lastModelResolution).fallback_policy?.mode
					: undefined) ?? "auto",
		});
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

	private get relayConfig(): RelayConfig {
		const syncResult = this.ctx.optionalConfig?.sync;
		const syncConfig = syncResult?.ok ? (syncResult.value as SyncConfig) : undefined;
		return resolveRelayConfig(syncConfig);
	}

	/** Read inference_timeout_ms from relay config (default 300s). */
	private get inferenceTimeoutMs(): number {
		if (this._inferenceTimeoutMs !== null) return this._inferenceTimeoutMs;
		const timeoutMs = this.relayConfig.inference_timeout_ms;
		this._inferenceTimeoutMs = timeoutMs;
		return timeoutMs;
	}

	// First-token timeout for relay streaming (#223). Relay heartbeats prove a
	// live target but no longer satisfy the first deadline — a backend that
	// heartbeats without producing a real token fails over at this deadline
	// instead of consuming the full per-chunk inference timeout.
	private get firstTokenTimeoutMs(): number {
		return this.relayConfig.first_token_timeout_ms;
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
						topologyRole: resolveTopologyRole(this.ctx.optionalConfig),
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
	 * Resolve a forced `think` choice from complete persisted history. Context
	 * assembly may budget-truncate old rows, but truncation must not reset this
	 * behavioral guardrail. The same resolved value is attached to both local
	 * backend calls and relay inference payloads.
	 */
	protected resolveThinkForce(
		resolution: BoundPreparedFrame["resolution"],
	): ChatParams["tool_choice"] | undefined {
		if (this.config.noTools || resolution.thinkingTool !== true) return undefined;
		const rows = listLiveMessageProjectionByThreadNewestFirst(
			this.ctx.db,
			this.config.threadId,
			THINK_FORCE_SCAN_LIMIT,
		);
		const choice = resolveThinkToolChoice({ thinkingTool: true, rows });
		if (choice) {
			this.ctx.logger.info("[agent-loop] Forcing think tool after tool-call streak", {
				threadId: this.config.threadId,
				model: resolution.modelId,
				forceAfter: THINK_TOOL_FORCE_AFTER,
			});
		}
		return choice;
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

			const toolStartedAt = performance.now();

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
							toolSpan.addEvent("bound.tool.dispatch.outcome", { "tool.outcome": "relayed" });
							recordAgentOperationalMetric("tool_dispatch", {
								outcome: "relayed",
								kind: tool.kind,
							});
							recordAgentToolDuration(performance.now() - toolStartedAt, {
								outcome: "relayed",
								kind: tool.kind,
								location: "relay",
							});
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
				const outcome = result.exitCode !== 0 ? "error" : "success";
				toolSpan.addEvent("bound.tool.dispatch.outcome", { "tool.outcome": outcome });
				recordAgentOperationalMetric("tool_dispatch", { outcome, kind: tool.kind });
				recordAgentToolDuration(performance.now() - toolStartedAt, {
					outcome,
					kind: tool.kind,
					location: "local",
				});
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
				toolSpan.addEvent("bound.tool.dispatch.outcome", { "tool.outcome": "exception" });
				recordAgentOperationalMetric("tool_dispatch", { outcome: "exception", kind: tool.kind });
				recordAgentToolDuration(performance.now() - toolStartedAt, {
					outcome: "exception",
					kind: tool.kind,
					location: "local",
				});
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

/**
 * Compose the terminal error for a failed failover chain (#265): the final
 * error first (unchanged when only one route was tried), then every route that
 * failed in order with its own cause, so a usage cap on one provider and an
 * expired key on the next are both visible in the surfaced error.
 */
export function formatRouteFailureChain(
	finalError: string,
	chain: ReadonlyArray<{ routeId: string; error: string }>,
): string {
	if (chain.length < 2) return finalError;
	const steps = chain.map((step, i) => `${i + 1}. ${step.routeId}: ${step.error}`).join("; ");
	return `${finalError} [all ${chain.length} routes failed: ${steps}]`;
}
