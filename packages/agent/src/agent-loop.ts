import { randomUUID } from "node:crypto";

import type { AppContext } from "@bound/core";
import {
	enqueueClientToolCall,
	findLatestLiveMessageCreatedAtByThread,
	findMessageById,
	insertRow,
	listLiveMessageDeltaByThreadSince,
	recordContextDebug,
	recordTurn,
	recordTurnRelayMetrics,
	resolveRelayConfig,
	updateRow,
	writeMessageMetadata,
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
import type { ContextDebugInfo, ContextSection, EventMap, SyncConfig } from "@bound/shared";
import {
	appendToolDuration,
	capToolResultContent,
	countContentTokens,
	countTokens,
	formatError,
	injectTraceContext,
} from "@bound/shared";
import type { Context, Span } from "@opentelemetry/api";
import { SpanStatusCode, context, trace } from "@opentelemetry/api";

import { Observable, Subject, firstValueFrom } from "rxjs";

import {
	buildCommandOutput,
	calculateTurnCost,
	clampMaxOutputTokens,
	convertDeltaMessages,
	createFileRefResolver,
	deriveCapabilityRequirements,
	getResolvedModelId,
	hasOrphanedToolCall,
	insertThreadMessage,
	parseContentBlocks,
} from "./agent-loop-utils";
import {
	buildCacheMarkers,
	coldPathPlaceCacheMarker,
	maybePlaceCacheMarker,
	refreshInnerLoopRollingMarker,
} from "./cache-marker";
import { CACHE_TTL_MS, predictCacheState, selectCacheTtl } from "./cache-prediction";
import { type CachedTurnState, computeToolFingerprint } from "./cached-turn-state";
import {
	TRUNCATION_TARGET_RATIO,
	applyActualUsageToContextDebug,
	assembleContext,
	buildVolatileContext,
	computeVolatileTailSection,
	rebuildWarmSections,
} from "./context-assembly";
import { trackFilePath } from "./file-thread-tracker";
import { resolveAdaptiveTruncation } from "./inflation-ratio";
import { type RelayToolCallRequest, isRelayRequest } from "./mcp-bridge";
import { type ModelResolution, resolveModel, resolveSameTierFallback } from "./model-resolution";
import { createRelayBackend } from "./relay-backend";
import { createRelayStream$ } from "./relay-stream$";
import { type RelayWaitResult, createRelayWait$ } from "./relay-wait$";
import { sharedStableSubsectionCache } from "./stable-prefix";
import { extractAssistantSeedText, extractSummaryAndMemories } from "./summary-extraction";
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
} from "./types";
import { isClientToolCallRequest } from "./types";
// Thinking-block compaction now lives exclusively in context-assembly.ts (Stage 1.7).
// The warm path no longer mutates stored messages — see agent-loop.ts step 3a comment.

export const SILENCE_TIMEOUT_MS = 600_000;
export const MAX_SILENCE_RETRIES = 3;
/** Max retries when the output token limit is hit during thinking (finishReason "length"). */
export const MAX_LENGTH_RETRIES = 2;

/**
 * Token count threshold above which `fastApproxContentTokens` falls back
 * to a character-based approximation instead of running tiktoken.
 *
 * tiktoken's BPE has pathological behavior on highly-repetitive content:
 * a 49k-character string of repeated single characters (e.g. a tool
 * output that's mostly whitespace or 'x's) takes 144+ seconds to
 * tokenize on cl100k_base. Real-world tool_result content is diverse
 * enough that tiktoken stays fast at this size, but synthetic test
 * fixtures and pathological dumps have triggered the slow path.
 *
 * The threshold is chosen below the 50K offload threshold so any
 * tool_result that survives offload (≤50K chars) skips the fallback if
 * it's small enough, and uses the fallback if it's near the boundary.
 */
const FAST_TOKEN_APPROX_THRESHOLD = 32_000;

/**
 * Cheap token count for content that may be pathologically slow under
 * tiktoken. Falls back to a 4-char-per-token approximation when content
 * exceeds {@link FAST_TOKEN_APPROX_THRESHOLD}; uses real tiktoken
 * otherwise for fidelity.
 *
 * The approximation matches tiktoken's typical 3.5–4 chars/token on
 * diverse English content within ±15%; under-estimates on highly
 * repetitive content (where tiktoken can produce ~1 token/char) but
 * that mismatch is acceptable for per-turn debug accounting and avoids
 * the worst-case hang.
 */
function fastApproxContentTokens(content: string | ContentBlock[]): number {
	if (typeof content === "string") {
		if (content.length > FAST_TOKEN_APPROX_THRESHOLD) {
			return Math.ceil(content.length / 4);
		}
		return countContentTokens(content);
	}
	let sum = 0;
	for (const block of content) {
		const blockJson = JSON.stringify(block);
		if (blockJson.length > FAST_TOKEN_APPROX_THRESHOLD) {
			sum += Math.ceil(blockJson.length / 4);
		} else {
			sum += countContentTokens([block]);
		}
	}
	return sum;
}

/** Per-message token estimator passed to `coldPathPlaceCacheMarker`. */
function estimateMessageTokens(msg: import("@bound/llm").LLMMessage): number {
	return fastApproxContentTokens(msg.content);
}

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
		resolveModel: () => ({ kind: "error", error: "Bound AgentLoop uses adapter model resolution" }),
		assembleContext: async () => {
			throw new Error("Bound AgentLoop uses adapter context assembly");
		},
		listTools: () => [],
		executeTool: async () => {
			throw new Error("Bound AgentLoop uses adapter tool dispatch");
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

const textEncoder = new TextEncoder();

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

interface BashLike {
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

interface BoundPreparedFrame extends PreparedLoopFrame {
	resolution: Exclude<ModelResolution, { kind: "error" }> & {
		backend?: LLMBackend;
		modelId: string;
	};
	assembled: {
		messages: import("@bound/llm").LLMMessage[];
		systemPrompt: string;
		debug: ContextDebugInfo;
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
	adaptiveTruncationRatio: number;
	measuredInflation: number | null;
	cacheTtl: ReturnType<typeof selectCacheTtl>;
}

export class AgentLoop extends ModularAgentLoop {
	private filesChanged = 0;
	private yielded = false;
	private lastModelResolution: ModelResolution | null = null;
	private _visionAdvisoryEmitted?: Set<string>;
	private lastContextDebug?: ContextDebugInfo;
	private loopStartTime = 0;
	private prevCacheReadTokens = 0;
	// Loop-guard state (consecutive*/last*Signature), length-retry, and
	// transport-retry counters are owned and reset by ModularAgentLoop.
	private requirements: ReturnType<typeof deriveCapabilityRequirements> | undefined;
	private currentTurnId: string | null = null;
	private relayMetadataRef: { hostName?: string; firstChunkLatencyMs?: number } = {};
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

	/**
	 * Accessor for this thread's cached turn state. Lives in ctx.turnStateStore
	 * so it survives AgentLoop instance teardown (e.g. across client-tool
	 * defer/wakeup cycles). Previously an instance field, which meant every
	 * fresh AgentLoop started cold regardless of upstream cache liveness.
	 */
	private getCachedTurnState(): CachedTurnState | undefined {
		return this.ctx.turnStateStore?.get(this.config.threadId) as CachedTurnState | undefined;
	}

	private setCachedTurnState(state: CachedTurnState): void {
		if (this.ctx.turnStateStore) {
			this.ctx.turnStateStore.set(this.config.threadId, state);
		}
	}

	private clearCachedTurnState(): void {
		this.ctx.turnStateStore?.delete(this.config.threadId);
	}

	/**
	 * Inner-loop volatile-tail refresh.
	 *
	 * Cold-path entry (assembleContext) and warm-path entry both produce a
	 * developer-role volatile-tail message inserted into llmMessages. The
	 * inner `while (continueLoop)` loop then appends tool_call/tool_result
	 * pairs after each LLM response, but does NOT rebuild the volatile
	 * content. Across multi-call inner-loop runs, the tail's snapshot ages
	 * relative to the agent's own state mutations (memorize, file writes,
	 * applied advisories, purges, etc.), and the next LLM call reads the
	 * stale snapshot — visible on thread 25687e6c as the agent re-stating
	 * "the user is asking me to delete /Users again" on every inner-loop
	 * turn even after its own tool calls had already deleted the row.
	 *
	 * The recorded `context_debug.totalEstimated` and section breakdown
	 * suffer the same staleness: every inner-loop turn writes the cold-
	 * frame estimate while `actualTotalTokens` climbs with each appended
	 * tool roundtrip. The mismatch poisons the per-thread inflation EMA
	 * (see resolveAdaptiveTruncationRatio) and drives the adaptive ratio
	 * down for no real reason.
	 *
	 * This helper rebuilds the varying volatile tail and refreshes
	 * `lastContextDebug.{totalEstimated,sections}` to reflect the current
	 * wire payload. The dev message is replaced in place; the bridge
	 * tail-emits dev regardless of array position so positional
	 * invariance is fine. Stable prefix sections (system, skill-context,
	 * volatile-prefix, tools) are preserved unchanged.
	 *
	 * Called from the top of each inner-loop iteration after the first
	 * (turnCount > 1). The first iteration uses the cold/warm-path
	 * snapshot directly.
	 */
	private refreshVolatileTailForNextTurn(
		llmMessages: import("@bound/llm").LLMMessage[],
		relayInfo:
			| { remoteHost: string; localHost: string; model: string; provider: string }
			| undefined,
		resolvedModelForDebug: string | undefined,
	): void {
		const freshVol = buildVolatileContext({
			db: this.ctx.db,
			threadId: this.config.threadId,
			taskId: this.config.taskId,
			userId: this.config.userId,
			siteId: this.ctx.siteId,
			hostName: this.ctx.hostName,
			currentModel: resolvedModelForDebug,
			relayInfo,
			systemPromptAddition: this.config.systemPromptAddition,
			platformInstructions: this.config.platformInstructions,
			assistantMessageText: extractAssistantSeedText(llmMessages),
		});

		// Replace the LAST developer-role message — that's the
		// volatile-tail produced by Stage 5.5 of context-assembly. There
		// may be additional developer messages earlier in `llmMessages`:
		// in particular, when `thread.summary` is set, Stage 1.7 prepends
		// a compaction-summary developer at index 0. Those head
		// developers are byte-stable across inner-loop iterations and
		// MUST NOT be touched here — Bedrock's prompt cache anchors on
		// their bytes.
		//
		// Bug previously addressed by `findIndex` returning the FIRST
		// developer: when Stage 1.7 ran, the refresh silently overwrote
		// the byte-stable summary with the varying volatile-tail content,
		// destroying the cache prefix mid-user-turn AND leaving the actual
		// tail dev stale. Live evidence on agent-harness production-shape
		// fixture: cumulative cache_read dropped 22,363 tokens between
		// two consecutive inferences within the same user-turn (cr 80,952
		// → 58,589, cw 241 → 22,427).
		let tailDevIdx = -1;
		for (let i = llmMessages.length - 1; i >= 0; i--) {
			if (llmMessages[i].role === "developer") {
				tailDevIdx = i;
				break;
			}
		}
		if (tailDevIdx >= 0) {
			llmMessages[tailDevIdx] = {
				role: "developer",
				content: freshVol.varyingContent,
			};
		}

		if (!this.lastContextDebug) return;

		// Recompute history. Excludes cache markers AND the dev tail
		// wherever it sits — the dev's tokens are accounted for under
		// volatile-tail below. Uses the cheap-on-pathological-content
		// helper because tool_result payloads can occasionally be near
		// the offload threshold (50k chars), and tiktoken's BPE has
		// pathological O(n²)-ish behavior on highly-repetitive content
		// (e.g. mostly-whitespace tool dumps). The character-based
		// fallback caps refresh latency at O(n) regardless of content
		// shape; accuracy stays ±15% for typical diverse content.
		let userTokens = 0;
		let assistantTokens = 0;
		let toolResultTokens = 0;
		for (const m of llmMessages) {
			if (m.role === "cache" || m.role === "developer") continue;
			const tokens = fastApproxContentTokens(m.content);
			if (m.role === "user") userTokens += tokens;
			else if (m.role === "assistant" || m.role === "tool_call") assistantTokens += tokens;
			else if (m.role === "tool_result") toolResultTokens += tokens;
		}

		const historyChildren: ContextSection[] = [];
		if (userTokens > 0) historyChildren.push({ name: "user", tokens: userTokens });
		if (assistantTokens > 0) historyChildren.push({ name: "assistant", tokens: assistantTokens });
		if (toolResultTokens > 0)
			historyChildren.push({ name: "tool_result", tokens: toolResultTokens });
		const historyTokens = userTokens + assistantTokens + toolResultTokens;

		// Volatile-tail subsection: shared with cold-path and warm-rebuild
		// via computeVolatileTailSection (memory + task-digest +
		// volatile-other under a parent). When the rebuild yields a null
		// tail (varyingTokenEstimate is 0), preserve the existing section
		// shape to avoid spurious churn in the recorded debug breakdown.
		const tailSection = computeVolatileTailSection(freshVol);

		const newSections = this.lastContextDebug.sections.map((s) => {
			if (s.name === "history") {
				return {
					name: "history",
					tokens: historyTokens,
					children: historyChildren.length > 0 ? historyChildren : undefined,
				};
			}
			if (s.name === "volatile-tail" && tailSection) {
				return tailSection;
			}
			return s;
		});

		const newTotalEstimated = newSections.reduce((sum, s) => sum + s.tokens, 0);

		this.lastContextDebug = {
			...this.lastContextDebug,
			totalEstimated: newTotalEstimated,
			sections: newSections,
		};
	}

	constructor(
		private ctx: AppContext,
		private sandbox: BashLike,
		private modelRouter: ModelRouter,
		private config: AgentLoopConfig,
	) {
		super(createBoundLoopExtensions(ctx, modelRouter, config), config, {
			silenceTimeoutMs: SILENCE_TIMEOUT_MS,
			maxTransientRetries: MAX_SILENCE_RETRIES,
			lengthRetryMax: MAX_LENGTH_RETRIES,
		});
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

		const primarySummaryModelId = this.modelRouter.getDefaultId();
		const fallbackSummaryModelId = getResolvedModelId(
			this.lastModelResolution,
			this.config.modelId ?? "",
		);
		const summaryModelId = primarySummaryModelId || fallbackSummaryModelId;
		const extractionBackend = this.acquireSummaryBackend(summaryModelId);
		if (extractionBackend) {
			extractSummaryAndMemories(
				this.ctx.db,
				this.config.threadId,
				extractionBackend,
				this.ctx.siteId,
			).catch((err) => {
				this.ctx.logger.warn("Summary/memory extraction failed", {
					threadId: this.config.threadId,
					error: formatError(err),
				});
			});
		} else {
			this.ctx.logger.info("Skipping summary extraction — model unresolvable cluster-wide", {
				threadId: this.config.threadId,
				summaryModelId,
			});
		}
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

	protected override async prepareFrame(input: {
		resolution: BoundPreparedFrame["resolution"];
	}): Promise<Omit<BoundPreparedFrame, "resolution">> {
		const resolution = input.resolution;
		let relayInfo: BoundPreparedFrame["relayInfo"];
		if (resolution.kind === "remote" && resolution.hosts.length > 0) {
			const firstHost = resolution.hosts[0];
			relayInfo = {
				remoteHost: firstHost.host_name,
				localHost: this.ctx.hostName,
				model: resolution.modelId,
				provider: "remote",
			};
		}

		const resolvedCaps =
			resolution.kind === "local"
				? this.modelRouter.getEffectiveCapabilities(resolution.modelId)
				: undefined;
		const cacheMarkerCaps =
			resolution.kind === "local" ? resolvedCaps : resolution.hosts[0]?.capabilities;
		const contextWindow =
			(resolution.kind === "local"
				? resolvedCaps?.max_context
				: resolution.hosts[0]?.capabilities?.max_context) || 200_000;
		const mergedTools = this.getMergedTools();
		const toolTokenEstimate = mergedTools ? countTokens(JSON.stringify(mergedTools)) : 0;
		const resolvedModelForDebug = getResolvedModelId(resolution, this.config.modelId);
		const threadInterface = this.config.platform ?? "web";
		const cacheTtl = selectCacheTtl(threadInterface);
		const { ratio: adaptiveTruncationRatio, inflation: measuredInflation } =
			resolveAdaptiveTruncation(this.ctx.db, this.config.threadId, TRUNCATION_TARGET_RATIO);
		const cacheState = predictCacheState(this.ctx.db, this.config.threadId, CACHE_TTL_MS[cacheTtl]);
		const currentFingerprint = computeToolFingerprint(this.config.tools);
		let cachePathReason: ContextDebugInfo["cachePathReason"] = this.config.noHistory
			? "no-history"
			: "no-stored-state";
		const cachedForWarm = this.getCachedTurnState();
		const isWarmPathEligible =
			!this.config.noHistory &&
			cacheState === "warm" &&
			cachedForWarm !== undefined &&
			cachedForWarm.toolFingerprint === currentFingerprint;

		if (isWarmPathEligible && cachedForWarm) {
			const assembleContextSpan = getTracer().startSpan("agent-loop.assemble-context", {
				attributes: {
					"context.cache_path": "warm",
					"context.effective_truncation_ratio": adaptiveTruncationRatio,
				},
			});
			const cached = cachedForWarm;
			const deltaRows = listLiveMessageDeltaByThreadSince(
				this.ctx.db,
				this.config.threadId,
				cached.lastMessageCreatedAt,
			);
			const deltaMessages = convertDeltaMessages(deltaRows);
			const storedMessages: import("@bound/llm").LLMMessage[] = [];
			for (let i = 0; i < cached.messages.length; i++) {
				const message = cached.messages[i];
				if (message.role === "cache" && i !== cached.fixedCacheIdx) continue;
				storedMessages.push(message);
			}
			if (storedMessages[storedMessages.length - 1]?.role === "developer") {
				storedMessages.pop();
			}
			storedMessages.push(...deltaMessages);

			if (hasOrphanedToolCall(storedMessages)) {
				cachePathReason = "orphaned-tool-call";
				assembleContextSpan.setAttribute("context.warm_bail_reason", cachePathReason);
				this.clearCachedTurnState();
				assembleContextSpan.end();
			} else {
				const rollingPlacement = maybePlaceCacheMarker(
					storedMessages,
					"rolling",
					cacheMarkerCaps ?? undefined,
				);
				const volatileContext = buildVolatileContext({
					db: this.ctx.db,
					threadId: this.config.threadId,
					taskId: this.config.taskId,
					userId: this.config.userId,
					siteId: this.ctx.siteId,
					hostName: this.ctx.hostName,
					currentModel: resolvedModelForDebug,
					relayInfo,
					systemPromptAddition: this.config.systemPromptAddition,
					platformInstructions: this.config.platformInstructions,
					assistantMessageText: extractAssistantSeedText(storedMessages),
				});
				storedMessages.push({ role: "developer", content: volatileContext.varyingContent });

				const storedTokens = storedMessages.reduce(
					(sum, msg) => sum + countContentTokens(msg.content),
					0,
				);
				const systemTokens = cached.systemPrompt ? countContentTokens(cached.systemPrompt) : 0;
				let estimatedTotal = storedTokens + systemTokens + toolTokenEstimate;
				const warmEffectiveBudget = Math.floor(contextWindow * adaptiveTruncationRatio);
				let warmCompactionTokensSaved = 0;
				if (estimatedTotal > warmEffectiveBudget) {
					const compactionResult = compactStoredMessagesInPlace(storedMessages, {
						recentWindow: computeRecentWindow(contextWindow),
						contextWindow,
						effectiveTruncationRatio: adaptiveTruncationRatio,
						precomputedEstimate: storedTokens,
					});
					if (compactionResult.compacted) {
						estimatedTotal -= compactionResult.tokensSaved;
						warmCompactionTokensSaved = compactionResult.tokensSaved;
					}
				}

				if (estimatedTotal <= warmEffectiveBudget) {
					const newLastRow = findLatestLiveMessageCreatedAtByThread(
						this.ctx.db,
						this.config.threadId,
					);
					const fixedIdx = cached.fixedCacheIdx;
					const rollingIdx = storedMessages.length - 2;
					const newCachePositions: number[] = [];
					if (fixedIdx >= 0 && fixedIdx < storedMessages.length) {
						newCachePositions.push(fixedIdx);
					}
					if (rollingIdx !== fixedIdx && rollingIdx >= 0) {
						newCachePositions.push(rollingIdx);
					}
					this.setCachedTurnState({
						...cached,
						messages: [...storedMessages],
						cacheMessagePositions: newCachePositions,
						lastMessageCreatedAt: newLastRow?.created_at ?? new Date().toISOString(),
					});
					const warmSections = cached.debugSections
						? rebuildWarmSections({
								cachedSections: cached.debugSections,
								storedMessages,
								volatileCtx: volatileContext,
							})
						: [];
					const contextDebug: ContextDebugInfo = {
						contextWindow,
						totalEstimated: estimatedTotal,
						model: resolvedModelForDebug ?? "unknown",
						sections: warmSections,
						budgetPressure: false,
						truncated: 0,
						cachePath: "warm",
						cachePathReason: "warm-eligible",
						effectiveTruncationRatio: adaptiveTruncationRatio,
						measuredInflation,
						warmCompactionTokensSaved,
						relevantMemory: volatileContext.relevantMemory,
						cacheMarkers: buildCacheMarkers({
							sections: warmSections,
							messagePlacement: rollingPlacement,
							ttl: cacheTtl,
						}),
					};
					this.lastContextDebug = contextDebug;
					this.ctx.logger.info("[agent-loop] Cache path selected", {
						path: "warm",
						reason: "warm-eligible",
						storedMessageCount: cached.messages.length,
						deltaMessageCount: deltaMessages.length,
						cacheMessagePositions: newCachePositions,
					});
					this.ctx.logger.info("[agent-loop] Context assembled", {
						messageCount: storedMessages.length,
						contextWindow,
						toolTokenEstimate,
						totalEstimatedTokens: contextDebug.totalEstimated,
						headroom: contextWindow - contextDebug.totalEstimated - toolTokenEstimate,
						budgetPressure: contextDebug.budgetPressure ?? false,
						truncatedMessages: contextDebug.truncated ?? 0,
						sections: contextDebug.sections.map((s) => `${s.name}:${s.tokens}`).join(", "),
					});
					assembleContextSpan.end();
					return {
						assembled: {
							messages: storedMessages,
							systemPrompt: cached.systemPrompt,
							debug: contextDebug,
						},
						messages: storedMessages,
						toolDefinitions: mergedTools ?? [],
						mergedTools,
						relayInfo,
						resolvedModelForDebug,
						resolvedCaps,
						cacheMarkerCaps,
						contextWindow,
						toolTokenEstimate,
						adaptiveTruncationRatio,
						measuredInflation,
						cacheTtl,
					};
				}

				cachePathReason = "budget-exceeded";
				assembleContextSpan.setAttribute("context.warm_bail_reason", cachePathReason);
				this.clearCachedTurnState();
				assembleContextSpan.end();
			}
		} else if (this.config.noHistory) {
			cachePathReason = "no-history";
		} else if (
			cachedForWarm !== undefined &&
			cachedForWarm.toolFingerprint !== currentFingerprint
		) {
			cachePathReason = "tool-change";
		} else if (cachedForWarm !== undefined && cacheState === "cold") {
			cachePathReason = "cache-expired";
		}

		const assembleContextSpan = getTracer().startSpan("agent-loop.assemble-context", {
			attributes: {
				"context.cache_path": "cold",
				"context.cold_reason": cachePathReason,
				"context.effective_truncation_ratio": adaptiveTruncationRatio,
			},
		});
		const result = await context.with(
			trace.setSpan(context.active(), assembleContextSpan),
			async () => {
				const syncResult = this.ctx.optionalConfig?.sync;
				const syncConfig = syncResult?.ok ? (syncResult.value as SyncConfig) : undefined;
				const topologyRole: "hub" | "spoke" = syncConfig?.hub ? "spoke" : "hub";
				return assembleContext({
					db: this.ctx.db,
					threadId: this.config.threadId,
					taskId: this.config.taskId,
					taskType: this.config.taskType,
					userId: this.config.userId,
					currentModel: resolvedModelForDebug,
					contextWindow,
					hostName: this.ctx.hostName,
					siteId: this.ctx.siteId,
					topologyRole,
					relayInfo,
					targetCapabilities: resolvedCaps ?? undefined,
					toolTokenEstimate,
					compactToolResults: true,
					effectiveTruncationRatio: adaptiveTruncationRatio,
					noHistory: this.config.noHistory,
					systemPromptAddition: this.config.systemPromptAddition,
					platformInstructions: this.config.platformInstructions,
					commandRegistry: this.ctx.commandRegistry,
					stableSubsectionCache: sharedStableSubsectionCache,
				});
			},
		);
		assembleContextSpan.end();

		const messages = result.messages;
		const fixedPlacement = coldPathPlaceCacheMarker(
			messages,
			{ bucketTokens: 0, estimateTokens: estimateMessageTokens },
			cacheMarkerCaps ?? undefined,
		);
		const fixedCacheIdx = fixedPlacement.placed ? fixedPlacement.index : -1;
		const contextDebug = {
			...result.debug,
			cacheMarkers: buildCacheMarkers({
				sections: result.debug.sections,
				messagePlacement: fixedPlacement,
				ttl: cacheTtl,
			}),
			cachePath: "cold" as const,
			cachePathReason,
			effectiveTruncationRatio: adaptiveTruncationRatio,
			measuredInflation,
		};
		const lastRow = findLatestLiveMessageCreatedAtByThread(this.ctx.db, this.config.threadId);
		this.setCachedTurnState({
			messages: [...messages],
			systemPrompt: result.systemPrompt,
			cacheMessagePositions: fixedPlacement.placed ? [fixedCacheIdx] : [],
			fixedCacheIdx,
			lastMessageCreatedAt: lastRow?.created_at ?? new Date().toISOString(),
			toolFingerprint: currentFingerprint,
			debugSections: contextDebug.sections,
		});
		this.lastContextDebug = contextDebug;
		this.ctx.logger.info("[agent-loop] Cache path selected", {
			path: "cold",
			reason: cachePathReason,
			storedMessageCount: this.getCachedTurnState()?.messages.length,
			deltaMessageCount: 0,
			cacheMessagePositions: this.getCachedTurnState()?.cacheMessagePositions,
		});

		this.ctx.logger.info("[agent-loop] Context assembled", {
			messageCount: messages.length,
			contextWindow,
			toolTokenEstimate,
			totalEstimatedTokens: contextDebug.totalEstimated,
			headroom: contextWindow - contextDebug.totalEstimated - toolTokenEstimate,
			budgetPressure: contextDebug.budgetPressure ?? false,
			truncatedMessages: contextDebug.truncated ?? 0,
			sections: contextDebug.sections.map((s) => `${s.name}:${s.tokens}`).join(", "),
		});

		if (resolvedCaps && !resolvedCaps.vision) {
			const advisoryKey = `${this.config.threadId}::vision:false`;
			if (!this._visionAdvisoryEmitted?.has(advisoryKey)) {
				if (!this._visionAdvisoryEmitted) this._visionAdvisoryEmitted = new Set();
				this._visionAdvisoryEmitted.add(advisoryKey);
				this.ctx.logger.info(
					"[agent-loop] Image blocks replaced with text annotations (backend lacks vision)",
					{ backendId: resolution.kind === "local" ? resolution.modelId : undefined },
				);
			}
		}

		return {
			assembled: { messages, systemPrompt: result.systemPrompt, debug: contextDebug },
			messages,
			toolDefinitions: mergedTools ?? [],
			mergedTools,
			relayInfo,
			resolvedModelForDebug,
			resolvedCaps,
			cacheMarkerCaps,
			contextWindow,
			toolTokenEstimate,
			adaptiveTruncationRatio,
			measuredInflation,
			cacheTtl,
		};
	}

	protected override beforeTurn(turn: number, frame: BoundPreparedFrame): void {
		this.currentTurnId = null;
		this.relayMetadataRef = {};
		this.config.onActivity?.();
		if (turn > 1) {
			this.refreshVolatileTailForNextTurn(
				frame.messages,
				frame.relayInfo,
				frame.resolvedModelForDebug,
			);
			const fixedIdxForRolling = this.getCachedTurnState()?.fixedCacheIdx ?? -1;
			refreshInnerLoopRollingMarker(
				frame.messages,
				fixedIdxForRolling,
				frame.cacheMarkerCaps ?? undefined,
			);
		}
		this.setPhase("LLM_CALL");
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
			let inferencePayload: InferenceRequestPayload = {
				model: resolution.modelId,
				messages: frame.messages,
				tools: frame.mergedTools,
				system: frame.assembled.systemPrompt || undefined,
				max_tokens: this.effectiveMaxOutputTokens(),
				temperature: undefined,
				timeout_ms: this.inferenceTimeoutMs,
			};
			const MAX_INLINE_BYTES = 2 * 1024 * 1024;
			const serialized = JSON.stringify(inferencePayload);
			const payloadBytes = textEncoder.encode(serialized).byteLength;
			if (payloadBytes > MAX_INLINE_BYTES) {
				const fileRef = `cluster/relay/inference-${randomUUID()}.json`;
				const messagesJson = JSON.stringify(inferencePayload.messages);
				insertRow(
					this.ctx.db,
					"files",
					{
						id: randomUUID(),
						path: fileRef,
						content: messagesJson,
						is_binary: 0,
						size_bytes: textEncoder.encode(messagesJson).byteLength,
						created_at: new Date().toISOString(),
						modified_at: new Date().toISOString(),
						deleted: 0,
						created_by: this.config.userId,
						host_origin: this.ctx.siteId,
					},
					this.ctx.siteId,
				);
				inferencePayload = { ...inferencePayload, messages: [], messages_file_ref: fileRef };
			}

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
				max_tokens: clampMaxOutputTokens(
					this.effectiveMaxOutputTokens(),
					resolution.maxOutputTokens,
				),
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

		// Length-retry (finishReason="length" on a thinking-only turn) is handled
		// by the base loop's checkLengthRetry, evaluated after this hook returns.
		return { action: "continue" };
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
			this.toolCallsMade++;
			let resultContent = "";
			let exitCode = 0;
			let mcpAppBinding: McpAppBinding | undefined;
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
						resultContent = dispatchResult.content;
						exitCode = dispatchResult.exitCode;
						mcpAppBinding = dispatchResult.mcpApp;
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
			if (result.mcpApp) {
				writeMessageMetadata(
					this.ctx.db,
					toolResultMsgId,
					{ mcp_app: result.mcpApp },
					this.ctx.siteId,
				);
			}
			this.broadcastMessage(toolResultMsgId);
			this.messagesCreated++;
			frame.messages.push({
				role: "tool_result",
				content: parseContentBlocks(result.content),
				tool_use_id: toolCall.id,
			});
		}
	}

	protected override afterToolPersistence(
		_parsed: ParsedResponse,
		_frame: BoundPreparedFrame,
		batch: LoopToolExecutionBatch,
	): LoopTurnDecision {
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
				if (!connectionId) {
					this.ctx.logger.error("Client tool call without connectionId", {
						tool: toolCall.name,
						callId: toolCall.id,
					});
					continue;
				}
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
			}
			return { action: "stop" };
		}

		if (this.config.shouldYield?.()) {
			this.yielded = true;
			return { action: "yield" };
		}
		return { action: "continue" };
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
	private acquireSummaryBackend(modelId: string): LLMBackend | null {
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
	private getMergedTools(): Array<ToolDefinition> | undefined {
		// `noTools` turns (e.g. cache-warming pokes, issue #10) run tool-less: the
		// merged list resolves to undefined and the loop ends after one response.
		if (this.config.noTools) return undefined;
		if (this.config.toolRegistry) {
			const registryTools: ToolDefinition[] = [];
			for (const registered of this.config.toolRegistry.values()) {
				registryTools.push(registered.toolDefinition);
			}
			// config.tools may contain MCP bridge tool definitions that
			// appear in the LLM tool list but dispatch through the bash tool.
			// Include any config.tools entries not already in the registry.
			const registryNames = new Set(this.config.toolRegistry.keys());
			const extras = (this.config.tools ?? []).filter((t) => !registryNames.has(t.function.name));
			const merged = [...registryTools, ...extras];
			return merged.length > 0 ? merged : undefined;
		}

		// Legacy path (when no registry provided)
		const serverTools = this.config.tools ?? [];
		const clientTools = this.config.clientTools ? Array.from(this.config.clientTools.values()) : [];
		const merged: Array<ToolDefinition> = [...serverTools, ...clientTools];
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
		| { content: string; exitCode: number; mcpApp?: McpAppBinding }
		| RelayToolCallRequest
		| ClientToolCallRequest
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
				let result: { content: string; exitCode: number; mcpApp?: McpAppBinding };

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
						const platformResult = await (tool.execute as any)(toolCall.input);
						// Platform tools return strings, but handle both just like builtin does
						if (Array.isArray(platformResult)) {
							const hasError = platformResult.some(
								(b) => b.type === "text" && "text" in b && (b.text as string).startsWith("Error:"),
							);
							// Rewrite inline-base64 image blocks to file_ref before persist so
							// a screenshot-sized payload never hits the cap. See tool-result-images.ts.
							const lightened = persistImageBlocksAsFileRefs(
								platformResult,
								this.ctx.db,
								this.ctx.siteId,
							);
							result = { content: JSON.stringify(lightened), exitCode: hasError ? 1 : 0 };
						} else {
							const exitCode = platformResult.startsWith("Error:") ? 1 : 0;
							result = { content: platformResult, exitCode };
						}
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
						const builtinResult = await tool.execute(toolCall.input);
						if (Array.isArray(builtinResult)) {
							const hasError = builtinResult.some(
								(b) => b.type === "text" && "text" in b && (b.text as string).startsWith("Error:"),
							);
							// Rewrite inline-base64 image blocks to file_ref before persist so
							// a screenshot-sized payload never hits the cap. See tool-result-images.ts.
							const lightened = persistImageBlocksAsFileRefs(
								builtinResult,
								this.ctx.db,
								this.ctx.siteId,
							);
							result = { content: JSON.stringify(lightened), exitCode: hasError ? 1 : 0 };
						} else {
							const exitCode = builtinResult.startsWith("Error:") ? 1 : 0;
							result = { content: builtinResult, exitCode };
						}
						break;
					}
				}

				// Cross-tool suggestion. When a model calls the wrong tool, the
				// Zod error enumerates valid options for the CALLED tool but
				// never reveals the params belong to a DIFFERENT tool. Models
				// that confuse two tools re-decide the same wrong routing every
				// turn — the 2026-06-12 / 2026-06-21 gpt-5.5 connector-vs-skill
				// spins (action-value confusion, 26+/12+ turns) and the
				// 2026-06-21 gpt-5.5 connector-spin (parameter-signature
				// confusion, 60+ turns across three aborts) both followed this
				// pattern. suggestCorrectTool tries action-value matching first,
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
					result = { content: cappedContent, exitCode: result.exitCode };
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
import { compactStoredMessagesInPlace, computeRecentWindow } from "./warm-compaction";
