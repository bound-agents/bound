import { randomUUID } from "node:crypto";

import type { AppContext } from "@bound/core";
import {
	enqueueClientToolCall,
	insertRow,
	recordContextDebug,
	recordTurn,
	recordTurnRelayMetrics,
	resolveRelayConfig,
	updateRow,
} from "@bound/core";
import type {
	ContentBlock,
	LLMBackend,
	ModelRouter,
	StreamChunk,
	ToolDefinition,
} from "@bound/llm";
import type { InferenceRequestPayload } from "@bound/llm";
import { LLMError } from "@bound/llm";
import type { ContextDebugInfo, ContextSection, EventMap, SyncConfig } from "@bound/shared";
import {
	appendToolDuration,
	capToolResultContent,
	countContentTokens,
	countTokens,
	formatError,
	injectTraceContext,
} from "@bound/shared";
import type { Context } from "@opentelemetry/api";
import { SpanStatusCode, context, trace } from "@opentelemetry/api";

import { Observable, Subject, firstValueFrom, lastValueFrom } from "rxjs";
import { tap } from "rxjs/operators";

import {
	buildCommandOutput,
	calculateTurnCost,
	clampMaxOutputTokens,
	convertDeltaMessages,
	createFileRefResolver,
	deriveCapabilityRequirements,
	dropSupersededToolCallDrafts,
	getResolvedModelId,
	hasOrphanedToolCall,
	insertThreadMessage,
	isTransientLLMError,
	parseContentBlocks,
	shouldRetryRelayCall,
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
import {
	TOOL_RESULT_OFFLOAD_THRESHOLD,
	buildOffloadMessage,
	offloadToolResultPath,
} from "./tool-result-offload";
import type {
	AgentLoopConfig,
	AgentLoopResult,
	AgentLoopState,
	ClientToolCallRequest,
} from "./types";
import { VALID_TRANSITIONS, isClientToolCallRequest } from "./types";
import { compactStoredMessagesInPlace, computeRecentWindow } from "./warm-compaction";
// Thinking-block compaction now lives exclusively in context-assembly.ts (Stage 1.7).
// The warm path no longer mutates stored messages — see agent-loop.ts step 3a comment.

export const SILENCE_TIMEOUT_MS = 600_000;
export const MAX_SILENCE_RETRIES = 3;
/** Default max output tokens. Bedrock defaults to 4096 if unset, which truncates large tool calls. */
export const DEFAULT_MAX_OUTPUT_TOKENS = 16_384;

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

/**
 * Circuit breaker for consecutive truncated tool calls on the same tool name.
 * If the parser flags N turns in a row as truncated for the same tool, we abort
 * the loop rather than let it spin. Guards against parser bugs (e.g. the
 * empty-args false-truncation regression from 2026-04-24 that burned 23M tokens
 * across 3,654 turns before Kara cancelled manually).
 */
export const MAX_CONSECUTIVE_TRUNCATED_TURNS = 5;

/**
 * Scale silence timeout based on estimated context size.
 * With a 10-minute base timeout, only very large contexts (100k+) need
 * additional time for cold-cache processing.
 */
export function scaledSilenceTimeout(baseMs: number, estimatedTokens: number): number {
	if (estimatedTokens <= 100_000) return baseMs;
	// Large context: add 1 minute per 50k tokens over 100k
	const extraMs = Math.floor((estimatedTokens - 100_000) / 50_000) * 60_000;
	return baseMs + extraMs;
}

/**
 * Scale max silence retries. With 10-minute timeouts, each retry is expensive.
 * Keep retries low to avoid multi-hour stalls.
 */
export function scaledMaxRetries(_estimatedTokens: number): number {
	return MAX_SILENCE_RETRIES;
}

const textEncoder = new TextEncoder();

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

/** Parsed tool call accumulated from stream chunks */
interface ParsedToolCall {
	id: string;
	name: string;
	input: Record<string, unknown>;
	argsJson: string;
	/** True when the tool_use args JSON failed to parse (likely output truncation). */
	truncated?: boolean;
}

/** Full parse result from an LLM response stream */
interface ParsedResponse {
	textContent: string;
	thinking: string | null;
	thinkingSignature: string | null;
	/**
	 * Opaque Bedrock redacted-reasoning blob. When safety filters redact the
	 * model's thinking, this is emitted instead of (or alongside) visible
	 * thinking text. Must be echoed back on the next assistant turn via
	 * providerOptions.bedrock.redactedData — the bridge handles that when a
	 * thinking ContentBlock carries redacted_data.
	 */
	thinkingRedactedData: string | null;
	/**
	 * OpenAI Responses encrypted reasoning state (GPT-5.x on Mantle, store:false).
	 * Echoed back on the next same-provider turn via
	 * providerOptions.openai.reasoningEncryptedContent so the model reconstructs
	 * its prior chain-of-thought. On Mantle a turn can carry this with empty
	 * thinking text, so it independently gates thinking-block emission below.
	 */
	thinkingEncryptedContent: string | null;
	toolCalls: ParsedToolCall[];
	usage: {
		inputTokens: number;
		outputTokens: number;
		cacheWriteTokens: number | null;
		cacheReadTokens: number | null;
		usageEstimated: boolean;
	};
	/**
	 * Authoritative USD cost for this turn as computed by the executing
	 * host (the relay hub for delegated inference) and stamped onto the
	 * `done` StreamChunk. `null` when the chunk did not carry a cost —
	 * either local (non-relay) inference, or a hub on pre-fix code.
	 * Consumers (the agent-loop's recordTurn site) prefer this value over
	 * a local pricing lookup so hub-only spokes don't write 0 for every
	 * delegated turn (CONTRIBUTING.md invariant #17 amendment).
	 */
	costUsdFromHub: number | null;
}

export class AgentLoop {
	private state: AgentLoopState = "IDLE";
	private messagesCreated = 0;
	private toolCallsMade = 0;
	private filesChanged = 0;
	private aborted = false;
	private yielded = false;
	private lastModelResolution: ModelResolution | null = null;
	private _visionAdvisoryEmitted?: Set<string>;
	private lastContextDebug?: ContextDebugInfo;

	private transition(next: AgentLoopState): void {
		const allowed = VALID_TRANSITIONS[this.state];
		if (!allowed.includes(next)) {
			this.ctx.logger.warn("[agent-loop] Invalid state transition", {
				from: this.state,
				to: next,
				allowed,
				threadId: this.config.threadId,
			});
		}
		this.state = next;
	}

	private enterOverlay(overlay: "RELAY_STREAM" | "RELAY_WAIT"): AgentLoopState {
		const saved = this.state;
		this.state = overlay;
		return saved;
	}

	private restoreState(saved: AgentLoopState): void {
		this.state = saved;
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
		if (config.abortSignal) {
			config.abortSignal.addEventListener("abort", () => {
				this.aborted = true;
			});
		}
	}

	/** Broadcast a persisted message to WS clients without re-triggering the agent loop. */
	private broadcastMessage(messageId: string): void {
		const message = this.ctx.db.prepare("SELECT * FROM messages WHERE id = ?").get(messageId);
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

	async run(): Promise<AgentLoopResult> {
		const loopStartTime = Date.now();
		let turnCount = 0;
		let prevCacheReadTokens = 0;
		// Circuit breaker state for MAX_CONSECUTIVE_TRUNCATED_TURNS guardrail.
		let consecutiveTruncatedTurns = 0;
		let lastTruncatedToolName: string | null = null;

		this.ctx.logger.info("[agent-loop] Starting", {
			threadId: this.config.threadId,
			taskId: this.config.taskId ?? null,
			userId: this.config.userId,
			modelHint: this.config.modelId ?? "default",
			platform: this.config.platform ?? null,
			toolCount: this.config.tools?.length ?? 0,
		});

		try {
			this.transition("HYDRATE_FS");
			const hydrateSpan = getTracer().startSpan("agent-loop.hydrate-fs");
			if (this.sandbox.capturePreSnapshot) {
				await this.sandbox.capturePreSnapshot();
			}
			hydrateSpan.end();

			this.transition("ASSEMBLE_CONTEXT");

			const hasTools = !!(this.config.tools && this.config.tools.length > 0);
			const requirements = deriveCapabilityRequirements(
				this.ctx.db,
				this.config.threadId,
				hasTools,
			);

			this.lastModelResolution = resolveModel(
				this.config.modelId,
				this.modelRouter,
				this.ctx.db,
				this.ctx.siteId,
				requirements,
			);

			this.ctx.logger.info("[agent-loop] Model resolved", {
				kind: this.lastModelResolution.kind,
				modelId:
					this.lastModelResolution.kind !== "error" ? this.lastModelResolution.modelId : null,
				error: this.lastModelResolution.kind === "error" ? this.lastModelResolution.error : null,
				remoteHosts:
					this.lastModelResolution.kind === "remote" ? this.lastModelResolution.hosts.length : 0,
			});

			if (this.lastModelResolution.kind === "error" && this.config.modelId !== undefined) {
				// Try cost-equivalent fallback if caller provided a tier hint
				if (this.config.modelTier !== undefined) {
					const tierFallback = resolveSameTierFallback(
						this.config.modelId,
						this.modelRouter,
						this.ctx.db,
						this.ctx.siteId,
						this.config.modelTier,
						requirements,
					);
					if (tierFallback) {
						const fallbackModelId =
							tierFallback.kind !== "error" ? tierFallback.modelId : undefined;
						const alertMsg = `Model "${this.config.modelId}" unavailable. Using same-tier (${this.config.modelTier}) alternative "${fallbackModelId}".`;
						this.ctx.logger.warn("[agent-loop] Model hint failed, using same-tier fallback", {
							requestedModel: this.config.modelId,
							fallbackModel: fallbackModelId,
							tier: this.config.modelTier,
						});
						this.emitAlert(alertMsg);
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

				// If still an error after tier fallback attempt, fail the task
				if (this.lastModelResolution.kind === "error") {
					const errorMsg = `Failed to resolve requested model "${this.config.modelId}": ${this.lastModelResolution.error}`;
					this.ctx.logger.warn("[agent-loop] Model hint failed, aborting task", {
						requestedModel: this.config.modelId,
						reason: this.lastModelResolution.reason,
					});
					this.emitAlert(errorMsg);
					throw new Error(errorMsg);
				}
			}

			let relayInfo:
				| { remoteHost: string; localHost: string; model: string; provider: string }
				| undefined;
			if (this.lastModelResolution.kind === "remote" && this.lastModelResolution.hosts.length > 0) {
				const firstHost = this.lastModelResolution.hosts[0];
				relayInfo = {
					remoteHost: firstHost.host_name,
					localHost: this.ctx.hostName,
					model: this.lastModelResolution.modelId,
					provider: "remote",
				};
			}

			const resolvedCaps =
				this.lastModelResolution?.kind === "local"
					? this.modelRouter.getEffectiveCapabilities(this.lastModelResolution.modelId)
					: undefined;

			// Separate caps view for the cache-marker gate. For remote resolutions
			// we don't have the full BackendCapabilities, but EligibleHost publishes
			// `prompt_caching` in its partial capability bag — enough for the gate
			// to decide. Without this, relay requests to a non-caching spoke would
			// carry `{role:"cache"}` markers that the spoke's backend then forwards
			// to AWS as providerOptions.bedrock.cachePoint, triggering 403
			// "unsupported model or your request did not allow prompt caching."
			const cacheMarkerCaps =
				this.lastModelResolution?.kind === "local"
					? resolvedCaps
					: this.lastModelResolution?.kind === "remote"
						? this.lastModelResolution.hosts[0]?.capabilities
						: undefined;

			// Resolve max_context from local capabilities, remote host, or safe fallback.
			// On spoke nodes with no local backends, getDefault() would throw, so we
			// read max_context from the remote host's advertised capabilities instead.
			let resolvedMaxContext: number | undefined;
			if (this.lastModelResolution?.kind === "local") {
				resolvedMaxContext = resolvedCaps?.max_context;
			} else if (this.lastModelResolution?.kind === "remote") {
				resolvedMaxContext = this.lastModelResolution.hosts[0]?.capabilities?.max_context;
			}
			const contextWindow = resolvedMaxContext || 200_000;

			const mergedTools = this.getMergedTools();
			const toolTokenEstimate = mergedTools ? countTokens(JSON.stringify(mergedTools)) : 0;

			const resolvedModelForDebug = getResolvedModelId(
				this.lastModelResolution,
				this.config.modelId,
			);

			// Determine cache state for warm/cold path decision
			const threadInterface = this.config.platform ?? "web";
			const cacheTtl = selectCacheTtl(threadInterface);
			const cacheState = predictCacheState(
				this.ctx.db,
				this.config.threadId,
				CACHE_TTL_MS[cacheTtl],
			);
			const currentFingerprint = computeToolFingerprint(this.config.tools);

			// Resolve the per-thread adaptive truncation ratio once per assembly.
			// Thinking-heavy threads have measured tiktoken inflation up to 2.4x;
			// the base 0.85 ratio leaves the configured forcing budget exposed
			// when the estimator runs that low. resolveAdaptiveTruncationRatio
			// reads recent turns' actual/estimated samples and tightens the
			// ratio proportionally. New threads with insufficient data fall
			// back to the base ratio.
			const { ratio: adaptiveTruncationRatio, inflation: measuredInflation } =
				resolveAdaptiveTruncation(this.ctx.db, this.config.threadId, TRUNCATION_TARGET_RATIO);

			// Check if warm path is eligible.
			// noHistory tasks are stateless across runs — each run should cold-assemble
			// from only the current claim's messages. Warm cache from a prior run would
			// serve stale history that noHistory is designed to exclude.
			const isWarmPathEligible =
				!this.config.noHistory &&
				cacheState === "warm" &&
				this.getCachedTurnState() !== undefined &&
				this.getCachedTurnState()?.toolFingerprint === currentFingerprint;

			let contextDebug: ContextDebugInfo = {
				contextWindow: contextWindow,
				totalEstimated: 0,
				model: resolvedModelForDebug ?? "unknown",
				sections: [],
				budgetPressure: false,
				truncated: 0,
			};
			let llmMessages: import("@bound/llm").LLMMessage[] = [];
			let usedWarmPath = false;
			let deltaMessageCount = 0;
			// Tracks the specific reason a warm-eligible attempt bailed. Stays
			// `null` when the warm path either succeeded or was never eligible
			// (the latter is captured by the eligibility predicate below).
			// Distinguishing orphaned-tool-call from budget-exceeded matters
			// because the two bails have different remedies — the former is a
			// structural sanitization issue, the latter is genuine pressure.
			let warmBailReason: "orphaned-tool-call" | "budget-exceeded" | null = null;
			// Tokens reclaimed by `compactStoredMessagesInPlace` on this turn.
			// Recorded onto contextDebug for the warm-success branch so the
			// "warm path applied in-place compaction" event is visible without
			// log scraping. `0` means compaction was not invoked.
			let warmCompactionTokensSaved = 0;

			const cachedForWarm = this.getCachedTurnState();
			if (isWarmPathEligible && cachedForWarm) {
				// WARM PATH: Try to reuse stored messages and append delta
				const assembleContextSpan = getTracer().startSpan("agent-loop.assemble-context", {
					attributes: {
						"context.cache_path": "warm",
						"context.effective_truncation_ratio": adaptiveTruncationRatio,
					},
				});

				await context.with(trace.setSpan(context.active(), assembleContextSpan), async () => {
					const cached = cachedForWarm;

					// 1. Fetch delta messages from DB (created after lastMessageCreatedAt)
					const deltaFetchSpan = getTracer().startSpan("context.warm.delta-fetch");
					const deltaRows = this.ctx.db
						.query(
							"SELECT id, thread_id, role, content, model_id, tool_name, created_at, modified_at, host_origin, deleted FROM messages WHERE thread_id = ? AND deleted = 0 AND created_at > ? ORDER BY created_at ASC, rowid ASC",
						)
						.all(this.config.threadId, cached.lastMessageCreatedAt) as Array<{
						id: string;
						thread_id: string;
						role: string;
						content: string;
						model_id: string | null;
						tool_name: string | null;
						created_at: string;
						modified_at: string | null;
						host_origin: string;
						deleted: number;
					}>;

					// 2. Convert and sanitize delta messages
					const deltaMessages = convertDeltaMessages(deltaRows);
					deltaMessageCount = deltaMessages.length;
					deltaFetchSpan.setAttribute("context.delta_messages", deltaMessageCount);
					deltaFetchSpan.end();

					assembleContextSpan.setAttribute("context.delta_messages", deltaMessageCount);
					assembleContextSpan.setAttribute("context.stored_messages", cached.messages.length);

					this.ctx.logger.debug("[agent-loop] Warm path: delta messages fetched", {
						storedMessageCount: cached.messages.length,
						deltaMessageCount: deltaMessages.length,
					});

					// 3. Rebuild message array: stored (without old developer tail) + delta.
					//
					// Evict any prior rolling cache-role markers. Anthropic caps each
					// request at 4 cache_control blocks across system + tools + messages.
					// The cold path places a FIXED cache marker at `cached.fixedCacheIdx`;
					// the warm path then appends a ROLLING marker at the tail on every
					// turn. Without eviction, each successive warm turn adds a new
					// rolling marker on top of the previous one — after a few turns
					// the accumulated message-level cache_control count alone can hit
					// or exceed 4, yielding "Found 5" 400s from the Claude API.
					// We keep the fixed marker (it anchors the stable prefix) and
					// strip every other cache-role entry before placing the new one.
					const storedMessages: import("@bound/llm").LLMMessage[] = [];
					for (let i = 0; i < cached.messages.length; i++) {
						const m = cached.messages[i];
						if (m.role === "cache" && i !== cached.fixedCacheIdx) {
							// Drop stale rolling cache markers from earlier warm turns.
							continue;
						}
						storedMessages.push(m);
					}
					const lastIdx = storedMessages.length - 1;
					if (storedMessages[lastIdx]?.role === "developer") {
						storedMessages.pop();
					}

					storedMessages.push(...deltaMessages);

					// 3a. NO MUTATION ON WARM PATH.
					// Previously we stripped thinking blocks here when context approached the
					// budget ceiling. That mutation invalidated Bedrock's cached prefix on
					// every turn it fired (cache_read=0, full rewrite of ~100k tokens),
					// because cache lookups are byte-exact on the prefix bytes leading up to
					// the cachePoint. Bedrock's "simplified cache management" auto-lookback
					// is only ~20 content blocks, but our stripping walked from oldest msg
					// forward — well outside that window.
					//
					// Compaction now happens exclusively on the cold path (Stage 1.7), which
					// produces a stable new prefix. The warm-path budget gate below bails to
					// cold reassembly when context exceeds the threshold so compaction
					// happens once, deterministically, and the resulting prefix stays cached
					// for the next ~20-30 turns.

					// 3b. If the merged stored+delta array contains a tool_call with no
					//    matching tool_result before a non-tool turn (common when a
					//    client tool was in flight and the user typed a follow-up, or
					//    when the loop yielded mid-batch), the warm path cannot safely
					//    ship this payload — the AI SDK prompt validator raises
					//    `MissingToolResultsError` and the whole turn fails. Fall
					//    through to the cold path so Stage 3 sanitization can
					//    synthesize the missing result. Clearing the cached state
					//    forces a full re-assembly on the next iteration as well.
					const orphanCheckSpan = getTracer().startSpan("context.warm.orphan-check");
					const warmOrphanedToolCall = hasOrphanedToolCall(storedMessages);
					orphanCheckSpan.setAttribute("context.orphan_detected", warmOrphanedToolCall);
					orphanCheckSpan.end();

					if (warmOrphanedToolCall) {
						this.ctx.logger.info(
							"[agent-loop] Warm path detected orphaned tool_call, falling back to cold reassembly",
							{
								threadId: this.config.threadId,
								storedMessageCount: cached.messages.length,
								deltaMessageCount: deltaMessages.length,
							},
						);
						assembleContextSpan.setAttribute("context.warm_bail_reason", "orphaned-tool-call");
						warmBailReason = "orphaned-tool-call";
						this.clearCachedTurnState();
						// Fall through to the cold path by leaving usedWarmPath=false.
					}

					let rollingPlacement: ReturnType<typeof maybePlaceCacheMarker> | null = null;
					if (!warmOrphanedToolCall) {
						// 4. Place rolling cache message at messages[length-2] (before last delta
						//    message). Gated on effective backend capabilities — skipped when
						//    prompt_caching is explicitly disabled (e.g. MiniMax on Bedrock)
						//    to avoid the 403 "unsupported model / prompt caching not allowed".
						rollingPlacement = maybePlaceCacheMarker(
							storedMessages,
							"rolling",
							cacheMarkerCaps ?? undefined,
						);

						// 5. Inject fresh volatile developer message at tail.
						//
						// Use `varyingContent` only — NOT the full `content`
						// (which is `stableContent + varyingContent`). The stable
						// subsection (Working Knowledge bodies + Discoverable
						// Archive titles + skill index) lives in the cached
						// system prompt; injecting it again into the developer
						// tail is pure duplication that bloats `tokens_in` by
						// the size of the entire stable prefix on every warm
						// turn. The cold path correctly uses `varyingContent`
						// alone — see `context-assembly.ts:1348`.
						//
						// Live evidence captured via the agent-harness
						// production-shape fixture (2026-05-26): warm-path
						// inferences carried 226,238-byte trailing user
						// messages containing the full Working Knowledge +
						// Discoverable Archive + skill index XML — exactly
						// the content the system-anchor cache already covered.
						// Switching to `varyingContent` shrinks each warm-path
						// `tokens_in` by ~the volatile-prefix size.
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

						storedMessages.push({
							role: "developer",
							content: volatileContext.varyingContent,
						});

						// 6. Check budget: bail to cold reassembly when context exceeds the
						//    TRUNCATION_TARGET_RATIO threshold (85% of contextWindow). This is
						//    LOWER than the safety-margined budget (~98%) used by the previous
						//    high-water-mark gate. The lower threshold lets cold path do all
						//    compaction (tool_result pointer stubs, conditional thinking strip)
						//    in one stable shot, producing a fresh prefix the provider can cache
						//    for the next ~20-30 warm turns. The previous higher threshold left
						//    a 170k-196k window where neither warm-path mutation nor cold
						//    reassembly fired cleanly, causing the alternating cache MISS/HIT
						//    pattern we observed on Bedrock.
						const budgetCheckSpan = getTracer().startSpan("context.warm.budget-check");
						const storedTokens = storedMessages.reduce(
							(sum, msg) => sum + countContentTokens(msg.content),
							0,
						);
						const systemTokens = cached.systemPrompt ? countContentTokens(cached.systemPrompt) : 0;
						let estimatedTotal = storedTokens + systemTokens + toolTokenEstimate;
						const warmEffectiveBudget = Math.floor(contextWindow * adaptiveTruncationRatio);
						budgetCheckSpan.setAttribute("context.estimated_tokens", estimatedTotal);
						budgetCheckSpan.setAttribute("context.effective_budget", warmEffectiveBudget);

						// When the warm-path budget would fail, compact in-place
						// instead of bailing to cold reassembly. Cold rebuild
						// produces a different byte-prefix the provider's cache
						// misses; in-place compaction keeps the prefix stable.
						// Regression coverage: warm-cold-path.test.ts and
						// inflation-ratio.test.ts.
						if (estimatedTotal > warmEffectiveBudget) {
							const compactionResult = compactStoredMessagesInPlace(storedMessages, {
								recentWindow: computeRecentWindow(contextWindow),
								contextWindow,
								effectiveTruncationRatio: adaptiveTruncationRatio,
								// We just summed countContentTokens over storedMessages
								// to derive `storedTokens`. Pass it through so Step 2
								// of the helper doesn't re-tokenize the same array.
								precomputedEstimate: storedTokens,
							});
							if (compactionResult.compacted) {
								estimatedTotal -= compactionResult.tokensSaved;
								warmCompactionTokensSaved = compactionResult.tokensSaved;
								budgetCheckSpan.setAttribute(
									"context.warm_compaction_saved",
									compactionResult.tokensSaved,
								);
								budgetCheckSpan.setAttribute(
									"context.estimated_tokens_post_compaction",
									estimatedTotal,
								);
								this.ctx.logger.info("[agent-loop] Warm path applied in-place compaction", {
									tokensSaved: compactionResult.tokensSaved,
									estimatedTotalPostCompaction: estimatedTotal,
									effectiveBudget: warmEffectiveBudget,
								});
							}
						}

						if (estimatedTotal > warmEffectiveBudget) {
							// Even after compaction, budget still exceeded —
							// fall through to cold path.
							budgetCheckSpan.setAttribute("context.budget_exceeded", true);
							budgetCheckSpan.end();
							assembleContextSpan.setAttribute("context.warm_bail_reason", "budget-exceeded");
							warmBailReason = "budget-exceeded";
							this.ctx.logger.info(
								"[agent-loop] Warm path exceeded context budget, triggering cold reassembly",
								{
									estimatedTotal,
									contextWindow,
									effectiveBudget: warmEffectiveBudget,
									storedTokens,
									systemTokens,
									toolTokenEstimate,
								},
							);
							// Clear cached state to force cold path on next iteration
							this.clearCachedTurnState();
							// Fall through to cold path by not setting usedWarmPath or llmMessages
						} else {
							// Warm path succeeded within budget
							budgetCheckSpan.setAttribute("context.budget_exceeded", false);
							budgetCheckSpan.end();
							usedWarmPath = true;

							// 7. Query latest message created_at for next turn
							const newLastRow = this.ctx.db
								.query(
									"SELECT created_at FROM messages WHERE thread_id = ? AND deleted = 0 ORDER BY created_at DESC LIMIT 1",
								)
								.get(this.config.threadId) as { created_at: string } | null;

							// 8. Update stored state.
							// Spread-copy so later mutations of `llmMessages` (e.g. the
							// loop appending tool_call blocks after the LLM response) do
							// NOT leak into the cached state. Aliasing here previously
							// caused the next warm iteration to re-append the delta on
							// top of an already-appended tool_call, producing duplicated
							// tool_use blocks and a Bedrock tool_use_id_mismatch.
							//
							// Recompute cacheMessagePositions from the freshly rebuilt
							// array since stale rolling markers were evicted in step 3.
							// The fixed cache (cold-path anchor) survived at its original
							// index; the new rolling cache sits at length-2.
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

							// 9. Use stored messages directly (no system messages in the array)
							llmMessages = storedMessages;

							// Rebuild section breakdown for debug. Reuses stable-prefix
							// sections (system, skill-context, tools) from the cold-path
							// snapshot stored in cached state, and recomputes the dynamic
							// ones (history, memory, task-digest, volatile-other) from the
							// fresh volatileContext and current storedMessages. Falls back
							// to an empty array if the cache pre-dates this fix and has no
							// stored debugSections — next cold rebuild will repopulate it.
							const warmSections = cached.debugSections
								? rebuildWarmSections({
										cachedSections: cached.debugSections,
										storedMessages,
										volatileCtx: volatileContext,
									})
								: [];

							contextDebug = {
								contextWindow: contextWindow,
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
								cacheMarkers: buildCacheMarkers({
									sections: warmSections,
									messagePlacement: rollingPlacement ?? {
										placed: false,
										variant: "rolling",
										index: -1,
										reason: "too-short",
									},
									ttl: cacheTtl,
								}),
							};
						}
					}
				});

				assembleContextSpan.end();
			}

			// Compute path decision reason (used in log, cold-path span attribute,
			// and the recorded `context_debug.cachePathReason`). The branch order
			// matters: noHistory short-circuits before any cached-state inspection
			// because the eligibility predicate forces cold regardless of cache
			// freshness, and the warm-bail reasons (orphaned-tool-call /
			// budget-exceeded) are meaningless in that branch. After noHistory,
			// the warmBailReason captured during the warm attempt takes priority
			// over derived reasons since it reflects the actual control-flow
			// decision rather than a structural inference.
			const cachePathReason: ContextDebugInfo["cachePathReason"] = this.config.noHistory
				? "no-history"
				: warmBailReason !== null
					? warmBailReason
					: !this.getCachedTurnState()
						? "no-stored-state"
						: cacheState === "cold"
							? "cache-expired"
							: !isWarmPathEligible &&
									this.getCachedTurnState()?.toolFingerprint !== currentFingerprint
								? "tool-change"
								: usedWarmPath === false
									? "budget-exceeded"
									: "warm-eligible";

			// Log warm/cold path decision with reason and counts
			this.ctx.logger.info("[agent-loop] Cache path selected", {
				path: usedWarmPath ? "warm" : "cold",
				reason: cachePathReason,
				storedMessageCount: this.getCachedTurnState()?.messages.length,
				deltaMessageCount,
				cacheMessagePositions: this.getCachedTurnState()?.cacheMessagePositions,
			});

			// If warm path failed budget check or was ineligible, run cold path
			if (!usedWarmPath) {
				// COLD PATH: Full assembly and cache message placement
				this.ctx.logger.debug("[agent-loop] Cold path: full context assembly", {
					cacheState,
					hasStoredState: this.getCachedTurnState() !== undefined,
					fingerprintMatch: this.getCachedTurnState()?.toolFingerprint === currentFingerprint,
				});

				// Deterministic compaction keeps cached prefixes stable while reducing context size
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
						// #68: spoke when a hub URL is configured, hub otherwise
						// (mirrors `isHub: !syncConfig.hub` in start/sync.ts).
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
							contextWindow: contextWindow,
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

				// assembleContext now returns systemPrompt separately — no system-role
				// messages in the array, no filtering needed.
				const contextMessages = result.messages;
				const systemPrompt = result.systemPrompt;
				contextDebug = result.debug;

				// Place the cold-path cache marker at the latest bucket-aligned
				// stable byte position. Bucket alignment ensures consecutive same-
				// bucket turns land the cachePoint at the SAME byte position so
				// Bedrock's prefix cache matches reliably. The legacy "rolling"
				// placement (always at messages.length - 1) thrashed because each
				// turn's marker landed at a different position as message history
				// grew — see thread 7453d60b post-deploy data (cache_read stuck at
				// system-anchor floor despite cache_write growing per turn).
				// Gated on effective backend capabilities; skipped when
				// prompt_caching is explicitly disabled (e.g. MiniMax on Bedrock).
				const fixedPlacement = coldPathPlaceCacheMarker(
					contextMessages,
					{
						// `bucketTokens` is unused under the semantic-anchor algorithm
						// — kept in the API for backward compat. Pass any value.
						bucketTokens: 0,
						estimateTokens: estimateMessageTokens,
					},
					cacheMarkerCaps ?? undefined,
				);
				const placedFixedMarker = fixedPlacement.placed;
				const fixedCacheIdx = fixedPlacement.placed ? fixedPlacement.index : -1;

				// Annotate contextDebug with the cache breakpoints recorded for this
				// turn so the web debugger can render truthful tick positions on the
				// breakdown bar. The system breakpoint always rides the system param;
				// the message breakpoint sits at messages[length-2] (just before the
				// volatile-tail developer message) when capability allows.
				contextDebug.cacheMarkers = buildCacheMarkers({
					sections: contextDebug.sections,
					messagePlacement: fixedPlacement,
					ttl: cacheTtl,
				});

				// Stamp cache-path provenance fields onto the cold-path debug
				// record. `assembleContext` builds the rest of contextDebug; the
				// agent loop owns the routing decision (warm vs cold, which
				// reason fired, what truncation ratio applied), so those fields
				// are attached here rather than threaded through assembleContext.
				contextDebug.cachePath = "cold";
				contextDebug.cachePathReason = cachePathReason;
				contextDebug.effectiveTruncationRatio = adaptiveTruncationRatio;
				contextDebug.measuredInflation = measuredInflation;

				// Query last message created_at for delta queries
				const lastRow = this.ctx.db
					.query(
						"SELECT created_at FROM messages WHERE thread_id = ? AND deleted = 0 ORDER BY created_at DESC LIMIT 1",
					)
					.get(this.config.threadId) as { created_at: string } | null;
				const lastMessageCreatedAt = lastRow?.created_at ?? new Date().toISOString();

				// Store state for potential warm-path reuse on next turn
				this.setCachedTurnState({
					messages: [...contextMessages],
					systemPrompt,
					cacheMessagePositions: placedFixedMarker ? [fixedCacheIdx] : [],
					fixedCacheIdx,
					lastMessageCreatedAt,
					toolFingerprint: currentFingerprint,
					debugSections: contextDebug.sections,
				});

				llmMessages = contextMessages;
			}

			this.lastContextDebug = contextDebug;

			this.ctx.logger.info("[agent-loop] Context assembled", {
				messageCount: llmMessages.length,
				contextWindow,
				toolTokenEstimate,
				totalEstimatedTokens: contextDebug.totalEstimated,
				headroom: contextWindow - contextDebug.totalEstimated - toolTokenEstimate,
				budgetPressure: contextDebug.budgetPressure ?? false,
				truncatedMessages: contextDebug.truncated ?? 0,
				sections: contextDebug.sections.map((s) => `${s.name}:${s.tokens}`).join(", "),
			});

			// Log once per thread when image blocks are stripped for a non-vision backend
			if (resolvedCaps && !resolvedCaps.vision) {
				const advisoryKey = `${this.config.threadId}::vision:false`;
				if (!this._visionAdvisoryEmitted?.has(advisoryKey)) {
					if (!this._visionAdvisoryEmitted) this._visionAdvisoryEmitted = new Set();
					this._visionAdvisoryEmitted.add(advisoryKey);
					this.ctx.logger.info(
						"[agent-loop] Image blocks replaced with text annotations (backend lacks vision)",
						{
							backendId:
								this.lastModelResolution?.kind === "local"
									? this.lastModelResolution.modelId
									: undefined,
							threadId: this.config.threadId,
						},
					);
				}
			}
			let continueLoop = true;
			let transportRetries = 0;

			while (continueLoop) {
				// Reset the inactivity timeout at the start of each turn.
				// Context assembly and LLM initial processing can take minutes
				// for large threads (1000+ messages with extended thinking),
				// and the timeout must not fire during that preparation.
				this.config.onActivity?.();

				if (this.aborted) {
					this.ctx.logger.info("[agent-loop] Aborted before LLM call", {
						threadId: this.config.threadId,
						turn: turnCount,
					});
					break;
				}

				turnCount++;
				const turnSpan = getTracer().startSpan("agent-loop.turn", {
					attributes: {
						"thread.id": this.config.threadId,
						"task.id": this.config.taskId ?? "",
					},
				});
				// Establish turn context for child span nesting.
				// We can't use context.with() around the loop body (break/continue),
				// so we pass turnCtx explicitly to child span creation.
				const turnCtx = trace.setSpan(context.active(), turnSpan);

				this.transition("LLM_CALL");

				// After the first iteration of this run(), refresh the
				// volatile-tail to reflect any state mutations the prior
				// iteration's tool dispatches produced. Without this, the
				// dev tail in llmMessages ages relative to DB reality and
				// the recorded context_debug.totalEstimated stays frozen
				// at the cold-frame value while actualTotalTokens climbs,
				// poisoning the inflation EMA. See
				// inner-loop-temporal-frame.test.ts for the regression
				// suite covering this requirement.
				//
				// Perf debt: buildVolatileContext runs ~13 DB queries each
				// call. For a 10-turn inner loop that's ~130 extra queries
				// per run() — bounded but not free. A future optimization
				// can add a staleness fast-path (skip rebuild when no
				// tracked source has mutated since last refresh) and cache
				// per-message tokenizations to avoid O(N²) re-counting of
				// unchanged history messages.
				if (turnCount > 1) {
					this.refreshVolatileTailForNextTurn(llmMessages, relayInfo, resolvedModelForDebug);

					// Refresh the inner-loop rolling cache marker. Each inner-loop
					// iteration appends `tool_call + tool_result(s)` to
					// `llmMessages`; without a rolling cachePoint, those bytes pay
					// full price on each subsequent inference because they live
					// outside the cache region anchored by the FIXED marker at
					// user_1. The fixed semantic-anchor stays put — this adds a
					// SECOND marker downstream of the appended content so iter K
					// reads back iter K-1's tool roundtrip.
					//
					// Live evidence (agent-harness production-shape, 2026-05-26):
					// cr stuck at the system+user_1 floor (59,510) across 5 inner-
					// loop iterations while ti climbed 63k → 84k. The next outer-
					// turn's warm-path then had to write ~25k of cache to seed
					// what the inner loop produced cold. With this rolling, the
					// inner-loop cumulative cache grows monotonically.
					//
					// `fixedCacheIdx` may be -1 when the cold-path placer
					// refused (e.g. a fresh thread whose initial `[user_1,
					// dev_tail]` is too short for the semantic-anchor placer).
					// In that case eviction matches no index and drops every
					// `role: "cache"` entry — fine; placement then runs on a
					// cleanly-evicted array with 4+ messages from accumulated
					// tool roundtrips, well past the placer's too-short floor.
					const fixedIdxForRolling = this.getCachedTurnState()?.fixedCacheIdx ?? -1;
					refreshInnerLoopRollingMarker(
						llmMessages,
						fixedIdxForRolling,
						cacheMarkerCaps ?? undefined,
					);
				}
				const chunks: StreamChunk[] = [];
				let currentTurnId: string | null = null;
				let resolvedModelId: string | null = null;
				const relayMetadataRef: { hostName?: string; firstChunkLatencyMs?: number } = {};

				this.ctx.logger.info("[agent-loop] LLM call starting", {
					turn: turnCount,
					model: getResolvedModelId(this.lastModelResolution, this.config.modelId || "unknown"),
					messageCount: llmMessages.length,
					kind: this.lastModelResolution?.kind ?? "unknown",
				});

				const llmCallSpan = getTracer().startSpan("agent-loop.llm-call", {}, turnCtx);
				const llmCallCtx = trace.setSpan(turnCtx, llmCallSpan);
				try {
					// System prompt comes from assembleContext (cold path) or cached state (warm path).
					// No filtering needed — llmMessages contains no system-role messages.
					const systemPrompt = this.getCachedTurnState()?.systemPrompt ?? "";

					const resolution = this.lastModelResolution;
					if (!resolution) {
						throw new Error("Model resolution not available");
					}

					switch (resolution.kind) {
						case "error":
							throw new Error(resolution.error);

						case "remote": {
							let inferencePayload: InferenceRequestPayload = {
								model: resolution.modelId,
								messages: llmMessages,
								tools: mergedTools,
								system: systemPrompt || undefined,
								max_tokens: this.config.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS,
								temperature: undefined,
								timeout_ms: this.inferenceTimeoutMs,
								// cache_ttl is omitted on the remote-dispatch payload — the
								// receiving spoke's relay-processor reads its OWN per-backend
								// config via getCacheTtl(payload.model). This avoids the spoke
								// honoring a TTL configured on the hub for a model it doesn't
								// support.
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
								inferencePayload = {
									...inferencePayload,
									messages: [], // Clear inline messages
									messages_file_ref: fileRef,
								};
							}

							// Replace the for-await with Observable consumption
							const previousState = this.enterOverlay("RELAY_STREAM");
							try {
								// Create aborted$ from the AbortSignal and this.aborted flag
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
									// MINOR Issue 2: Also check this.aborted periodically via interval
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

								await lastValueFrom(
									createRelayStream$(
										{
											db: this.ctx.db,
											eventBus: this.ctx.eventBus,
											siteId: this.ctx.siteId,
											logger: this.ctx.logger,
										},
										inferencePayload,
										resolution.hosts,
										aborted$,
										relayMetadataRef,
										{ perHostTimeoutMs: this.inferenceTimeoutMs },
									).pipe(
										tap((chunk) => {
											if (chunk.type !== "heartbeat") {
												this.config.onStreamChunk?.(chunk);
												chunks.push(chunk);
											}
										}),
									),
									{ defaultValue: undefined },
								);
							} finally {
								this.restoreState(previousState);
							}
							break;
						}

						case "local": {
							const totalEstimatedTokens = contextDebug.totalEstimated + toolTokenEstimate;
							const effectiveSilenceTimeout = scaledSilenceTimeout(
								SILENCE_TIMEOUT_MS,
								totalEstimatedTokens,
							);
							const effectiveMaxRetries = scaledMaxRetries(totalEstimatedTokens);

							let silenceRetries = 0;
							for (;;) {
								// Reset inactivity timeout before each LLM call attempt.
								// Bedrock may take 30-120s to produce the first chunk for
								// large contexts with extended thinking enabled.
								this.config.onActivity?.();
								try {
									// Create a child span for the driver chat call with TTFT/completion tracking
									const driverSpan = getTracer().startSpan(
										"llm-driver.chat",
										{
											attributes: {
												"llm.model": getResolvedModelId(
													this.lastModelResolution,
													this.config.modelId || "unknown",
												),
												"llm.provider": "local",
											},
										},
										llmCallCtx,
									);

									let ttftRecorded = false;

									try {
										const chatStream = resolution.backend.chat({
											messages: llmMessages,
											system: systemPrompt || undefined,
											tools: mergedTools,
											max_tokens: clampMaxOutputTokens(
												this.config.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS,
												resolution.maxOutputTokens,
											),
											thinking: resolution.thinkingConfig,
											effort: resolution.effort,
											cache_ttl: resolution.cacheTtl,
											resolveFileRef: createFileRefResolver(this.ctx.db),
											signal: this.config.abortSignal,
										});
										for await (const chunk of this.withSilenceTimeout(
											chatStream,
											effectiveSilenceTimeout,
											() => this.config.onActivity?.(),
										)) {
											if (this.aborted) break;
											// Cooperative yield: check on every chunk during streaming
											if (this.config.shouldYield?.()) {
												this.yielded = true;
												this.aborted = true;
												break;
											}
											// Reset the inactivity timeout — any chunk (including
											// heartbeats) proves the LLM is still working. Heartbeats
											// from Bedrock extended-thinking warm-up can take >5min
											// before the first content chunk; without resetting here
											// the outer timer in message-handler.ts aborts mid-session.
											this.config.onActivity?.();
											// Heartbeats reset the timeout but carry no data
											if (chunk.type === "heartbeat") continue;

											// Record TTFT on first non-heartbeat chunk
											if (!ttftRecorded) {
												driverSpan.addEvent("time-to-first-token");
												ttftRecorded = true;
											}

											this.config.onStreamChunk?.(chunk);
											chunks.push(chunk);
										}

										// Record completion event with token counts from the done chunk
										const doneChunk = chunks.find((c) => c.type === "done");
										if (doneChunk && doneChunk.type === "done") {
											const thinkingChars = chunks.reduce(
												(sum, c) => sum + (c.type === "thinking" ? c.content.length : 0),
												0,
											);
											driverSpan.addEvent("completion", {
												"llm.input_tokens": doneChunk.usage.input_tokens,
												"llm.output_tokens": doneChunk.usage.output_tokens,
												"llm.thinking_chars": thinkingChars,
											});
										}

										driverSpan.setStatus({ code: SpanStatusCode.OK });
										driverSpan.end();
										break; // Stream completed — exit retry loop
									} catch (streamErr) {
										driverSpan.setStatus({
											code: SpanStatusCode.ERROR,
											message: streamErr instanceof Error ? streamErr.message : String(streamErr),
										});
										driverSpan.end();
										throw streamErr;
									}
								} catch (silenceErr) {
									const isSilenceTimeout =
										silenceErr instanceof Error && silenceErr.message.includes("silence timeout");
									if (isSilenceTimeout && silenceRetries < effectiveMaxRetries) {
										silenceRetries++;
										chunks.length = 0; // Clear any partial chunks
										// Reset inactivity timeout — we're actively retrying, not stalled
										this.config.onActivity?.();
										this.ctx.logger.warn("[agent-loop] Silence timeout, retrying", {
											attempt: silenceRetries,
											max: effectiveMaxRetries,
										});
										continue;
									}
									throw silenceErr; // Exhausted retries or non-silence error
								}
							}
							break;
						}
					}
					llmCallSpan.setStatus({ code: SpanStatusCode.OK });
					llmCallSpan.end();
				} catch (error) {
					llmCallSpan.setStatus({
						code: SpanStatusCode.ERROR,
						message: error instanceof Error ? error.message : String(error),
					});
					llmCallSpan.end();
					// Transient transport errors (HTTP/2 drops, socket resets): retry
					// Non-transient errors (4xx client errors like invalid JSON) are NOT retried.
					const errMsg = error instanceof Error ? error.message : String(error);
					if (isTransientLLMError(error) && transportRetries < MAX_SILENCE_RETRIES) {
						transportRetries++;
						// 5xx server faults need a wait before retry: withEmptyRetry
						// already proved instant no-backoff retry of this same Mantle
						// mid-stream server_error does NOT clear it. Transport drops
						// (http2/ECONNRESET, no status) keep their historical instant
						// retry — they reconnect, they don't need the server to recover.
						const isServerFault =
							error instanceof LLMError &&
							error.statusCode !== undefined &&
							error.statusCode >= 500;
						const backoffMs = isServerFault ? 1000 * 2 ** (transportRetries - 1) : 0;
						this.ctx.logger.warn("[agent-loop] Transient LLM error, retrying", {
							attempt: transportRetries,
							max: MAX_SILENCE_RETRIES,
							backoffMs,
							statusCode: error instanceof LLMError ? error.statusCode : null,
							error: errMsg,
						});
						if (backoffMs > 0) {
							await new Promise((resolve) => setTimeout(resolve, backoffMs));
						}
						turnSpan.end();
						continue; // Re-enter the while loop → LLM_CALL
					}

					if (error instanceof LLMError && (error.statusCode === 429 || error.statusCode === 529)) {
						const backendId =
							this.lastModelResolution?.kind === "local" ? this.lastModelResolution.modelId : null;
						if (backendId) {
							const retryAfterMs = error.retryAfterMs || 60_000;
							this.modelRouter.markRateLimited(backendId, retryAfterMs);
							this.ctx.logger.warn("[agent-loop] Backend rate-limited, marked for exclusion", {
								backendId,
								retryAfterMs,
								statusCode: error.statusCode,
							});

							const newResolution = resolveModel(
								undefined,
								this.modelRouter,
								this.ctx.db,
								this.ctx.siteId,
								requirements,
							);
							if (newResolution.kind !== "error") {
								const previousModelId = getResolvedModelId(this.lastModelResolution, backendId);
								const newModelId = newResolution.modelId;
								this.lastModelResolution = newResolution;

								if (previousModelId !== newModelId) {
									const switchMsg = `Model switched from ${previousModelId} to ${newModelId} (rate limit on ${previousModelId})`;
									llmMessages.push({ role: "developer", content: switchMsg });
									const switchMsgId = insertThreadMessage(
										this.ctx.db,
										{
											threadId: this.config.threadId,
											role: "developer",
											content: switchMsg,
											hostOrigin: this.ctx.siteId,
										},
										this.ctx.siteId,
									);
									this.broadcastMessage(switchMsgId);
									this.messagesCreated++;
								}

								this.ctx.logger.info(
									"[agent-loop] Rate-limit fallback: re-resolved to alternative backend",
									{
										previousBackend: backendId,
										newBackend: newModelId,
										newKind: newResolution.kind,
									},
								);
								transportRetries = 0;
								turnSpan.end();
								continue;
							}

							this.ctx.logger.warn(
								"[agent-loop] Rate-limit fallback: no alternative backend available",
								{ backendId },
							);
						}
					}

					this.transition("ERROR_PERSIST");
					const errorMsg = formatError(error);
					this.ctx.logger.error("[agent-loop] LLM call failed (non-retryable)", {
						turn: turnCount,
						error: errorMsg,
						statusCode: error instanceof LLMError ? error.statusCode : null,
						model: getResolvedModelId(this.lastModelResolution, this.config.modelId || "unknown"),
					});

					// Record the failed attempt so cross-host cost/usage queries
					// can see which model/task failed (bound_issue:turns-table:
					// observability-gap sub-gap 2c). Pre-stream errors used to
					// leave no row at all.
					try {
						const failedModelId = getResolvedModelId(
							this.lastModelResolution,
							this.config.modelId || "unknown",
						);
						recordTurn(
							this.ctx.db,
							{
								thread_id: this.config.threadId,
								task_id: this.config.taskId || undefined,
								dag_root_id: undefined,
								model_id: failedModelId,
								tokens_in: 0,
								tokens_out: 0,
								tokens_cache_write: null,
								tokens_cache_read: null,
								cost_usd: 0,
								status: "error",
								created_at: new Date().toISOString(),
							},
							this.ctx.siteId,
						);
					} catch (recordErr) {
						this.ctx.logger.warn("Failed to record error turn", {
							threadId: this.config.threadId,
							error: recordErr instanceof Error ? recordErr.message : String(recordErr),
						});
					}

					this.emitAlert(`Error: ${errorMsg}`);

					turnSpan.setStatus({
						code: SpanStatusCode.ERROR,
						message: errorMsg,
					});
					turnSpan.end();

					return {
						messagesCreated: this.messagesCreated,
						toolCallsMade: this.toolCallsMade,
						filesChanged: this.filesChanged,
						error: errorMsg,
					};
				}

				this.transition("PARSE_RESPONSE");
				const parsed = this.parseResponseChunks(chunks);

				this.ctx.logger.info("[agent-loop] LLM response received", {
					turn: turnCount,
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

				// Aborted mid-stream with no done chunk — persist notice and exit.
				// Skip the notice if this was a cooperative yield (shouldYield) — the
				// executor will retry the loop and the message will be processed.
				if (this.aborted && parsed.usage.inputTokens === 0 && parsed.usage.outputTokens === 0) {
					// Record the aborted attempt so cross-host cost/usage queries
					// can attribute it to the right model/task (bound_issue:turns-
					// table:observability-gap sub-gap 2c). The status='aborted'
					// marker keeps it out of success-path rollups.
					try {
						const abortedModelId = getResolvedModelId(
							this.lastModelResolution,
							this.config.modelId || "unknown",
						);
						recordTurn(
							this.ctx.db,
							{
								thread_id: this.config.threadId,
								task_id: this.config.taskId || undefined,
								dag_root_id: undefined,
								model_id: abortedModelId,
								tokens_in: 0,
								tokens_out: 0,
								tokens_cache_write: null,
								tokens_cache_read: null,
								cost_usd: 0,
								status: "aborted",
								created_at: new Date().toISOString(),
							},
							this.ctx.siteId,
						);
					} catch (recordErr) {
						this.ctx.logger.warn("Failed to record aborted turn", {
							threadId: this.config.threadId,
							error: recordErr instanceof Error ? recordErr.message : String(recordErr),
						});
					}

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
					turnSpan.end();
					break;
				}

				try {
					resolvedModelId = getResolvedModelId(
						this.lastModelResolution,
						this.config.modelId || "unknown",
					);

					// Prefer hub-computed cost when present. The relay hub stamps
					// cost_usd onto the `done` StreamChunk using its own backend
					// pricing — that's authoritative for delegated inference,
					// because the spoke may be hub-only mode (empty backends
					// list) and its local calculateTurnCost would return 0
					// (CONTRIBUTING.md invariant #17). When the chunk carries
					// no cost (local inference, or a hub on pre-fix code) fall
					// back to the local pricing lookup.
					const backends = this.ctx.config?.modelBackends?.backends ?? [];
					const cost_usd =
						parsed.costUsdFromHub ?? calculateTurnCost(resolvedModelId, parsed.usage, backends);

					currentTurnId = recordTurn(
						this.ctx.db,
						{
							thread_id: this.config.threadId,
							task_id: this.config.taskId || undefined,
							dag_root_id: undefined,
							model_id: resolvedModelId,
							tokens_in: parsed.usage.inputTokens,
							tokens_out: parsed.usage.outputTokens,
							tokens_cache_write: parsed.usage.cacheWriteTokens,
							tokens_cache_read: parsed.usage.cacheReadTokens,
							cost_usd,
							created_at: new Date().toISOString(),
						},
						this.ctx.siteId,
					);

					// Set turn span attributes after LLM response
					turnSpan.setAttributes({
						"model.id": resolvedModelId,
						"model.kind": this.lastModelResolution?.kind ?? "unknown",
						"llm.input_tokens": parsed.usage.inputTokens,
						"llm.output_tokens": parsed.usage.outputTokens,
						"llm.cache_read_tokens": parsed.usage.cacheReadTokens ?? 0,
						"llm.cache_write_tokens": parsed.usage.cacheWriteTokens ?? 0,
						"llm.thinking_chars": parsed.thinking?.length ?? 0,
						"context.messages_in_flight": llmMessages.length,
					});

					// Detect provider-side cache eviction (TTL expiry mid-loop)
					const cacheRead = parsed.usage.cacheReadTokens ?? 0;
					const cacheWrite = parsed.usage.cacheWriteTokens ?? 0;
					if (prevCacheReadTokens > 0 && cacheRead === 0 && cacheWrite > 0) {
						turnSpan.setAttribute("llm.cache_evicted", true);
						turnSpan.setAttribute("llm.cache_prefix_delta", cacheWrite - prevCacheReadTokens);
					}
					prevCacheReadTokens =
						cacheRead > 0 ? cacheRead : cacheWrite > 0 ? cacheWrite : prevCacheReadTokens;
				} catch (error) {
					this.ctx.logger.warn("Failed to record turn metrics", {
						threadId: this.config.threadId,
						error: error instanceof Error ? error.message : String(error),
					});
				}

				if (
					currentTurnId !== null &&
					relayMetadataRef.hostName !== undefined &&
					relayMetadataRef.firstChunkLatencyMs !== undefined
				) {
					try {
						recordTurnRelayMetrics(
							this.ctx.db,
							currentTurnId,
							relayMetadataRef.hostName,
							relayMetadataRef.firstChunkLatencyMs,
							this.ctx.siteId,
						);
					} catch (error) {
						this.ctx.logger.warn("Failed to record turn relay metrics", {
							threadId: this.config.threadId,
							turnId: currentTurnId,
							error: error instanceof Error ? error.message : String(error),
						});
					}
				}

				// `actualTotalTokens` for inflation-EMA purposes wants the
				// FULL on-wire prompt token count (so the ratio of agent-side
				// tiktoken estimate vs the LLM's tokenizer reflects only
				// tokenizer drift, not cache accounting). Since the bridge
				// fix at ai-sdk-bridge.ts:extractUsage now reports
				// `input_tokens` as the NON-cached portion (the value billed
				// at the full input rate), we must add the cache fields back
				// here to recover the true wire size. Cache reads + writes
				// also occupy wire bytes — they're discounted in pricing,
				// not absent from the prompt.
				//
				// Pre-2026-05-26: `parsed.usage.inputTokens` was the AI SDK's
				// summed total, which already included cache fields, and
				// this site explicitly avoided double-adding. After the
				// bridge fix lands, the field reverted to its raw bedrock/
				// anthropic semantic (noCache only), so the explicit sum is
				// now both correct AND necessary. See ai-sdk-bridge.ts probe
				// notes for the live evidence.
				const actualTotalTokens =
					parsed.usage.inputTokens +
					(parsed.usage.cacheReadTokens ?? 0) +
					(parsed.usage.cacheWriteTokens ?? 0);
				// applyActualUsageToContextDebug deep-clones sections so per-turn
				// snapshots remain independent across loop iterations.
				if (this.lastContextDebug && actualTotalTokens > 0) {
					this.lastContextDebug = applyActualUsageToContextDebug(
						this.lastContextDebug,
						actualTotalTokens,
					);
				}

				if (currentTurnId !== null && this.lastContextDebug) {
					try {
						recordContextDebug(this.ctx.db, currentTurnId, this.lastContextDebug, this.ctx.siteId);
						this.ctx.eventBus.emit("context:debug", {
							thread_id: this.config.threadId,
							turn_id: currentTurnId,
							debug: this.lastContextDebug,
						});
					} catch (error) {
						this.ctx.logger.warn("Failed to record context debug", {
							threadId: this.config.threadId,
							turnId: currentTurnId,
							error: error instanceof Error ? error.message : String(error),
						});
					}
				}

				if (parsed.toolCalls.length > 0) {
					// Circuit breaker: if the parser keeps flagging the same tool as truncated
					// turn after turn, we're in a loop — likely a parser bug or a model that
					// won't stop retrying. Abort before executing (and re-prompting) again.
					const firstTruncated = parsed.toolCalls.find((tc) => tc.truncated);
					if (firstTruncated) {
						if (lastTruncatedToolName === firstTruncated.name) {
							consecutiveTruncatedTurns++;
						} else {
							consecutiveTruncatedTurns = 1;
							lastTruncatedToolName = firstTruncated.name;
						}

						if (consecutiveTruncatedTurns >= MAX_CONSECUTIVE_TRUNCATED_TURNS) {
							this.ctx.logger.error("[agent-loop] Aborting: consecutive truncated tool-call loop", {
								threadId: this.config.threadId,
								taskId: this.config.taskId ?? null,
								toolName: firstTruncated.name,
								consecutiveTurns: consecutiveTruncatedTurns,
								threshold: MAX_CONSECUTIVE_TRUNCATED_TURNS,
								turn: turnCount,
							});
							const noticeId = insertThreadMessage(
								this.ctx.db,
								{
									threadId: this.config.threadId,
									role: "developer",
									content: `[Agent loop aborted] Detected ${consecutiveTruncatedTurns} consecutive turns with truncated "${firstTruncated.name}" tool calls. This typically indicates a parser bug or a model stuck in a retry loop. Aborting to prevent runaway token usage.`,
									hostOrigin: this.ctx.siteId,
								},
								this.ctx.siteId,
							);
							this.broadcastMessage(noticeId);
							this.messagesCreated++;
							continueLoop = false;
							break;
						}
					} else {
						consecutiveTruncatedTurns = 0;
						lastTruncatedToolName = null;
					}

					// Cooperative cancellation: check before executing tools
					if (this.config.shouldYield?.()) {
						this.ctx.logger.info(
							"[agent-loop] Yielding before tool execution (cooperative cancel)",
						);
						this.yielded = true;
						break;
					}

					this.transition("TOOL_EXECUTE");
					const toolExecuteSpan = getTracer().startSpan("agent-loop.tool-execute", {}, turnCtx);
					const toolExecuteCtx = trace.setSpan(turnCtx, toolExecuteSpan);
					const toolResults: Array<{
						toolCall: ParsedToolCall;
						content: string;
						exitCode: number;
						durationMs: number;
					}> = [];
					const pendingClientCalls: Array<{
						toolCall: ParsedToolCall;
						request: ClientToolCallRequest;
					}> = [];

					for (const toolCall of parsed.toolCalls) {
						this.toolCallsMade++;
						let resultContent = "";
						let exitCode = 0;
						let deferredToClient = false;
						const toolStartTime = Date.now();

						this.ctx.logger.debug("[agent-loop] Tool executing", {
							turn: turnCount,
							tool: toolCall.name,
							toolCallId: toolCall.id,
							argsLength: toolCall.argsJson.length,
						});

						// Short-circuit truncated tool calls — args JSON was malformed (output truncation)
						if (toolCall.truncated) {
							this.ctx.logger.warn("[agent-loop] Skipping truncated tool call", {
								tool: toolCall.name,
								toolCallId: toolCall.id,
								argsLength: toolCall.argsJson.length,
							});
							toolResults.push({
								toolCall,
								content: `Error: tool call arguments were truncated (output exceeded max_tokens limit). The "${toolCall.name}" call was cut off before the full arguments could be generated. Try breaking the operation into smaller parts, or reduce the size of the arguments.`,
								exitCode: 1,
								durationMs: 0,
							});
							continue;
						}

						try {
							// Fire onActivity periodically during tool execution so the outer
							// inactivity timer doesn't trip on long-running tools (big bash
							// commands, deep reads, relay waits, client tool calls, etc.).
							// Covers both executeToolCall and the subsequent relayWait.
							const toolHeartbeat = this.config.onActivity
								? setInterval(() => {
										try {
											this.config.onActivity?.();
										} catch {
											// Never let a heartbeat callback throw from the loop.
										}
									}, SILENCE_HEARTBEAT_INTERVAL_MS)
								: null;

							try {
								// Bounded retry loop for relay-routed tool calls. When a relay
								// response is marked retriable=true (e.g. hub fast-failed because
								// the target host was offline, or all eligible hosts timed out),
								// we re-dispatch up to MAX_RELAY_RETRIES times with a short
								// backoff. Re-dispatching from executeToolCall picks up a fresh
								// eligibleHosts list, which gives an offline target a chance to
								// reconnect between attempts. Non-relay tool errors are NOT
								// retried here — they fall through unchanged.
								const MAX_RELAY_RETRIES = 1;
								let retryAttempt = 0;
								let dispatchResult = await this.executeToolCall(toolCall, toolExecuteCtx);
								let dispatchHandled = false;
								while (!dispatchHandled) {
									if ("outboxEntryId" in dispatchResult) {
										const previousRelayState = this.enterOverlay("RELAY_WAIT");
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
														currentTurnId,
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
											this.restoreState(previousRelayState);
										}

										if (
											shouldRetryRelayCall({
												waitResult,
												attempt: retryAttempt,
												maxAttempts: MAX_RELAY_RETRIES,
												aborted: this.aborted,
												// For relay-routed tools, the target's idempotency hints
												// are resolved at dispatch time and carried on the
												// RelayToolCallRequest itself — the local registry
												// only knows about the dispatcher command (e.g. `bash`),
												// not the remote MCP tool (e.g. `github list_commits`).
												// Falling back to registry lookup would always say
												// "not idempotent" for the dispatcher and refuse all
												// retries.
												annotations: dispatchResult.annotations,
											})
										) {
											retryAttempt++;
											const backoffMs = 2000 * retryAttempt;
											this.ctx.logger.info(
												"[agent-loop] Retrying relay tool call after retriable error",
												{
													tool: toolCall.name,
													attempt: retryAttempt,
													backoffMs,
													lastError: waitResult.content,
													definitelyNotExecuted: waitResult.definitely_not_executed === true,
												},
											);
											await new Promise((resolve) => setTimeout(resolve, backoffMs));
											this.config.onActivity?.();
											dispatchResult = await this.executeToolCall(toolCall, toolExecuteCtx);
											continue;
										}

										resultContent = waitResult.content;
										dispatchHandled = true;
									} else if (isClientToolCallRequest(dispatchResult)) {
										// Client tool calls are deferred to the client — track but don't get result yet
										pendingClientCalls.push({ toolCall, request: dispatchResult });
										resultContent = "";
										exitCode = 0;
										// Don't add to toolResults yet — no tool_result message to persist
										const toolDurationMs = Date.now() - toolStartTime;
										this.ctx.logger.info("[agent-loop] Client tool call deferred", {
											turn: turnCount,
											tool: toolCall.name,
											durationMs: toolDurationMs,
										});
										this.config.onActivity?.();
										dispatchHandled = true;
										// Mirror previous behavior: skip result-pushing logic for this call.
										// The outer continue is preserved by the sentinel below.
										deferredToClient = true;
									} else {
										resultContent = dispatchResult.content;
										exitCode = dispatchResult.exitCode;
										dispatchHandled = true;
									}
								}
								if (deferredToClient) {
									continue;
								}
							} finally {
								if (toolHeartbeat) clearInterval(toolHeartbeat);
							}
						} catch (error) {
							const errorMsg = formatError(error);
							resultContent = `Error: ${errorMsg}`;
							exitCode = 1;
						}

						const toolDurationMs = Date.now() - toolStartTime;
						this.ctx.logger.info("[agent-loop] Tool completed", {
							turn: turnCount,
							tool: toolCall.name,
							durationMs: toolDurationMs,
							exitCode,
							resultLength: resultContent.length,
							isError: exitCode !== 0,
						});

						toolResults.push({
							toolCall,
							content: resultContent,
							exitCode,
							durationMs: toolDurationMs,
						});
						this.config.onActivity?.();
					}

					if (this.sandbox.writeFile) {
						for (const result of toolResults) {
							if (result.content.length > TOOL_RESULT_OFFLOAD_THRESHOLD) {
								const filePath = offloadToolResultPath(result.toolCall.id);
								try {
									const originalLength = result.content.length;
									await this.sandbox.writeFile(filePath, result.content);
									result.content = buildOffloadMessage(
										filePath,
										originalLength,
										result.toolCall.name,
									);
									this.ctx.logger.debug("[agent-loop] Tool result offloaded", {
										tool: result.toolCall.name,
										originalBytes: originalLength,
										filePath,
									});
								} catch {
									// If write fails, keep original content — better than losing it
								}
							}
						}
					}

					// Append the duration suffix to each tool result (#77). This runs
					// AFTER the offload decision so:
					//  1. Offload threshold check is on raw tool output (the suffix is
					//     ~22 bytes — without this ordering, a 49,999-byte output
					//     would tip over the 50,000-byte threshold and offload
					//     unexpectedly).
					//  2. Offloaded files contain the raw tool output, not the suffix
					//     (cleaner for inspection / piping).
					//  3. The agent always sees the duration in the message content,
					//     whether the result was offloaded (suffix on the offload
					//     notice) or kept inline (suffix on raw output).
					for (const result of toolResults) {
						result.content = appendToolDuration(result.content, result.durationMs);
					}

					toolExecuteSpan.end();

					// Persist tool messages before next LLM call (pairing invariant)
					this.transition("TOOL_PERSIST");
					const toolPersistSpan = getTracer().startSpan("agent-loop.tool-persist", {}, turnCtx);

					const toolCallBlocks: ContentBlock[] = [];

					// Preserve thinking block for multi-turn reasoning continuity.
					// Anthropic requires the signed thinking block to come FIRST in the
					// assistant message's content blocks during extended thinking.
					// Emit a thinking block when visible thinking text, redacted-
					// reasoning data, OR OpenAI encrypted reasoning state is present —
					// redacted-only and encrypted-only turns still need to round-trip
					// their blob back on the next request. GPT-5.x on Mantle in
					// particular often emits zero reasoning text but carries the
					// encrypted blob, so the encrypted field independently gates
					// emission here.
					if (parsed.thinking || parsed.thinkingRedactedData || parsed.thinkingEncryptedContent) {
						const thinkingBlock: ContentBlock = {
							type: "thinking",
							thinking: parsed.thinking ?? "",
						};
						if (parsed.thinkingSignature) {
							thinkingBlock.signature = parsed.thinkingSignature;
						}
						if (parsed.thinkingRedactedData) {
							thinkingBlock.redacted_data = parsed.thinkingRedactedData;
						}
						if (parsed.thinkingEncryptedContent) {
							thinkingBlock.reasoning_encrypted_content = parsed.thinkingEncryptedContent;
						}
						toolCallBlocks.push(thinkingBlock);
					}

					// Fold inline assistant text ("I'll check that file") INTO this
					// tool_call message's content blocks rather than persisting it as a
					// separate assistant row. Two reasons:
					//   1. It matches Anthropic's native shape (thinking → text → tool_use
					//      in one assistant turn).
					//   2. It avoids a trailing assistant-text row landing between the
					//      tool_call and tool_result on replay, which OpenAI-compatible
					//      providers (qwen3 with enable_thinking, GLM, etc.) reject as a
					//      malformed prefill continuation.
					// Both drivers already extract text blocks from tool_call messages
					// (anthropic-driver.ts, openai-driver.ts toOpenAIMessages).
					if (parsed.textContent) {
						toolCallBlocks.push({
							type: "text",
							text: parsed.textContent,
						});
					}

					for (const tc of parsed.toolCalls) {
						toolCallBlocks.push({
							type: "tool_use",
							id: tc.id,
							name: tc.name,
							input: tc.input,
						});
					}

					const toolCallMsgId = insertThreadMessage(
						this.ctx.db,
						{
							threadId: this.config.threadId,
							role: "tool_call",
							content: JSON.stringify(toolCallBlocks),
							hostOrigin: this.ctx.siteId,
							modelId: resolvedModelId,
						},
						this.ctx.siteId,
					);
					this.broadcastMessage(toolCallMsgId);
					this.messagesCreated++;

					// In-memory context uses ContentBlock array (not JSON string)
					llmMessages.push({ role: "tool_call", content: toolCallBlocks });

					for (const { toolCall, content, exitCode } of toolResults) {
						const toolResultMsgId = insertThreadMessage(
							this.ctx.db,
							{
								threadId: this.config.threadId,
								role: "tool_result",
								content,
								hostOrigin: this.ctx.siteId,
								modelId: resolvedModelId,
								toolName: toolCall.id,
								exitCode,
							},
							this.ctx.siteId,
						);
						this.broadcastMessage(toolResultMsgId);
						this.messagesCreated++;

						llmMessages.push({
							role: "tool_result",
							content: parseContentBlocks(content),
							tool_use_id: toolCall.id,
						});
					}

					// Note: inline assistant text is no longer persisted as a separate
					// row — it's folded into the tool_call message's content blocks above.
					// This avoids a trailing assistant-text row sitting between the
					// tool_call and tool_result on replay, which caused providers like
					// qwen3 (enable_thinking=true) to reject the next request as a
					// malformed prefill continuation.

					toolPersistSpan.end();

					if (this.sandbox.checkMemoryThreshold) {
						const memCheck = this.sandbox.checkMemoryThreshold();
						if (memCheck.overThreshold) {
							this.ctx.logger.warn("Memory threshold exceeded, terminating loop", {
								usage: memCheck.usageBytes,
								threshold: memCheck.thresholdBytes,
							});
							break;
						}
					}

					// Handle pending client tool calls — persist and yield
					if (pendingClientCalls.length > 0) {
						this.ctx.logger.info("[agent-loop] Processing pending client tool calls", {
							count: pendingClientCalls.length,
						});

						for (const { toolCall } of pendingClientCalls) {
							// Persist tool_call message (already persisted as part of the batch above)
							// Enqueue dispatch entry for WS delivery
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

							// Open a `tool.dispatch` span that survives past this handler
							// invocation. The dispatch span lives until the WS handler sees
							// the matching tool_result and calls `closeDispatch`, so it
							// covers the actual round-trip wall-clock — not just the in-loop
							// dispatch instant. `agent-loop.tool-execute` would have been
							// lifetime-inverted as a parent (it ends synchronously while the
							// remote tool is still running), so the carrier we inject for
							// the WS frame has to point at `tool.dispatch` instead.
							//
							// When no tracker is configured (older callers or tests), fall
							// back to the toolExecuteCtx so behavior is unchanged.
							const tracker = this.config.handleMessageTracker;
							const dispatchCtx = tracker
								? (tracker.openDispatch(
										this.config.threadId,
										toolCall.id,
										toolCall.name,
									) as Context)
								: toolExecuteCtx;

							const traceContext = context.with(dispatchCtx, () => injectTraceContext());

							// Emit event for WS handler to deliver tool:call to client
							this.ctx.eventBus.emit("client_tool_call:created", {
								threadId: this.config.threadId,
								callId: toolCall.id,
								entryId,
								toolName: toolCall.name,
								arguments: toolCall.input,
								traceContext,
							});

							this.ctx.logger.debug("[agent-loop] Client tool call enqueued and event emitted", {
								tool: toolCall.name,
								callId: toolCall.id,
								connectionId,
							});
						}

						// Exit loop — resume when tool_result arrives
						this.ctx.logger.info("[agent-loop] Exiting loop for client tool call resolution", {
							count: pendingClientCalls.length,
						});
						continueLoop = false;
						turnSpan.end();
						break;
					}

					// Cooperative cancellation: check after tool results persisted
					if (this.config.shouldYield?.()) {
						this.ctx.logger.info(
							"[agent-loop] Yielding after tool persistence (cooperative cancel)",
						);
						this.yielded = true;
						turnSpan.end();
						break;
					}

					turnSpan.end();
					continue;
				}

				// No tool calls — persist final response and exit
				this.transition("RESPONSE_PERSIST");
				const responsePersistSpan = getTracer().startSpan(
					"agent-loop.response-persist",
					{},
					turnCtx,
				);
				const assistantContent = parsed.textContent || "";

				if (assistantContent) {
					const assistantMsgId = insertThreadMessage(
						this.ctx.db,
						{
							threadId: this.config.threadId,
							role: "assistant",
							content: assistantContent,
							hostOrigin: this.ctx.siteId,
							modelId: resolvedModelId,
						},
						this.ctx.siteId,
					);
					this.broadcastMessage(assistantMsgId);
					this.messagesCreated++;
				}
				responsePersistSpan.end();

				continueLoop = false;
				turnSpan.end();
			}

			this.transition("FS_PERSIST");
			const fsPersistSpan = getTracer().startSpan("agent-loop.fs-persist");
			if (this.sandbox.persistFs) {
				const persistResult = await this.sandbox.persistFs();
				if (persistResult && typeof persistResult.changes === "number") {
					this.filesChanged += persistResult.changes;

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
			fsPersistSpan.end();

			this.transition("QUEUE_CHECK");
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

			this.transition("IDLE");

			const totalDurationMs = Date.now() - loopStartTime;
			this.ctx.logger.info("[agent-loop] Completed", {
				threadId: this.config.threadId,
				taskId: this.config.taskId ?? null,
				turns: turnCount,
				messagesCreated: this.messagesCreated,
				toolCallsMade: this.toolCallsMade,
				filesChanged: this.filesChanged,
				totalDurationMs,
				yielded: this.yielded || false,
				aborted: this.aborted,
			});

			// Summary extraction acquires its backend through cluster-wide resolution, so it
			// runs even when this loop executes on a host with no local backend (it delegates
			// over the relay). Prefer the router's configured default (the cheap summary model
			// on hosts that have one); fall back to the model this loop used this turn when no
			// default resolves — the backendless case, where getDefaultId() returns "".
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

			return {
				messagesCreated: this.messagesCreated,
				toolCallsMade: this.toolCallsMade,
				filesChanged: this.filesChanged,
				yielded: this.yielded || undefined,
			};
		} catch (error) {
			this.state = "ERROR_PERSIST"; // Direct assignment — reachable from any state
			const errorMsg = formatError(error);
			const totalDurationMs = Date.now() - loopStartTime;

			this.ctx.logger.error("[agent-loop] Fatal error", {
				threadId: this.config.threadId,
				taskId: this.config.taskId ?? null,
				turns: turnCount,
				messagesCreated: this.messagesCreated,
				toolCallsMade: this.toolCallsMade,
				totalDurationMs,
				error: errorMsg,
			});

			try {
				this.emitAlert(`Agent loop error: ${errorMsg}`);
			} catch {
				// DB itself may be the problem
			}

			return {
				messagesCreated: this.messagesCreated,
				toolCallsMade: this.toolCallsMade,
				filesChanged: this.filesChanged,
				error: errorMsg,
			};
		} finally {
			// Cleanup reserved for future use (e.g. resource disposal).
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

	/** Execute a tool call via platform tools or sandbox. Returns relay request for remote MCP tools or client tool call request. */
	private async executeToolCall(
		toolCall: ParsedToolCall,
		parentCtx?: Context,
	): Promise<{ content: string; exitCode: number } | RelayToolCallRequest | ClientToolCallRequest> {
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
				let result: { content: string; exitCode: number };

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
							result = { content: JSON.stringify(platformResult), exitCode: hasError ? 1 : 0 };
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
						const sandboxResult = await this.sandbox.exec(command);
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
							result = { content: JSON.stringify(builtinResult), exitCode: hasError ? 1 : 0 };
						} else {
							const exitCode = builtinResult.startsWith("Error:") ? 1 : 0;
							result = { content: builtinResult, exitCode };
						}
						break;
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
				return {
					content: capToolResultContent(JSON.stringify(result)),
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

		const result = await this.sandbox.exec(command);

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
	private parseResponseChunks(chunks: StreamChunk[]): ParsedResponse {
		// Defensive dedup: reassign duplicate tool-use IDs. Sequential chunk ordering
		// (start → args* → end) means idRemap overwrites are safe for 3+ duplicates.
		const seenIds = new Set<string>();
		const idRemap = new Map<string, string>();
		const remappedChunks = chunks.map((chunk) => {
			if (chunk.type === "tool_use_start") {
				if (seenIds.has(chunk.id)) {
					const newId = `${chunk.id}-dedup-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
					this.ctx.logger.warn("[agent-loop] Duplicate tool-use ID detected in turn, reassigning", {
						originalId: chunk.id,
						newId,
					});
					idRemap.set(chunk.id, newId);
					seenIds.add(newId);
					return { ...chunk, id: newId };
				}
				seenIds.add(chunk.id);
			} else if (chunk.type === "tool_use_args" || chunk.type === "tool_use_end") {
				const remappedId = idRemap.get(chunk.id);
				if (remappedId) {
					return { ...chunk, id: remappedId };
				}
			}
			return chunk;
		});

		let textContent = "";
		let thinkingContent = "";
		let thinkingSignature: string | null = null;
		let thinkingRedactedData: string | null = null;
		let thinkingEncryptedContent: string | null = null;
		const toolCalls: ParsedToolCall[] = [];
		const argsAccumulator = new Map<string, string>();
		const nameMap = new Map<string, string>();
		let inputTokens = 0;
		let outputTokens = 0;
		let cacheWriteTokens: number | null = null;
		let cacheReadTokens: number | null = null;
		let usageEstimated = false;
		let costUsdFromHub: number | null = null;

		for (const chunk of remappedChunks) {
			switch (chunk.type) {
				case "text":
					textContent += chunk.content;
					break;
				case "thinking":
					thinkingContent += chunk.content;
					if (chunk.signature) thinkingSignature = chunk.signature;
					if (chunk.redacted_data) thinkingRedactedData = chunk.redacted_data;
					if (chunk.reasoning_encrypted_content)
						thinkingEncryptedContent = chunk.reasoning_encrypted_content;
					break;
				case "tool_use_start":
					argsAccumulator.set(chunk.id, "");
					nameMap.set(chunk.id, chunk.name);
					break;
				case "tool_use_args": {
					const existing = argsAccumulator.get(chunk.id) ?? "";
					argsAccumulator.set(chunk.id, existing + chunk.partial_json);
					break;
				}
				case "tool_use_end": {
					// Empty accumulator = zero-argument tool call (no tool_use_args chunks streamed).
					// `??` only catches undefined, so empty-string would fall through to JSON.parse("")
					// and spuriously flag the call as truncated. Treat "" and undefined alike as "{}".
					const rawArgs = argsAccumulator.get(chunk.id);
					const fullArgsJson = rawArgs && rawArgs.length > 0 ? rawArgs : "{}";
					const name = nameMap.get(chunk.id) ?? chunk.id;
					let input: Record<string, unknown> = {};
					let truncated = false;
					try {
						input = JSON.parse(fullArgsJson);
					} catch {
						truncated = true;
						this.ctx.logger.warn(
							`[agent-loop] Failed to parse tool_use args for "${name}" (id=${chunk.id}), ` +
								`args length=${fullArgsJson.length}. Output likely truncated by max_tokens limit.`,
						);
					}
					toolCalls.push({
						id: chunk.id,
						name,
						input,
						argsJson: fullArgsJson,
						truncated,
					});
					break;
				}
				case "done":
					inputTokens = chunk.usage.input_tokens;
					outputTokens = chunk.usage.output_tokens;
					cacheWriteTokens = chunk.usage.cache_write_tokens;
					cacheReadTokens = chunk.usage.cache_read_tokens;
					usageEstimated = chunk.usage.estimated;
					costUsdFromHub = chunk.cost_usd ?? null;
					break;
				case "error":
					this.ctx.logger.warn("[agent-loop] Stream error chunk in response", {
						error: chunk.error,
					});
					break;
				case "heartbeat":
					break;
				default: {
					const _exhaustive: never = chunk;
					void _exhaustive;
				}
			}
		}

		return {
			textContent,
			thinking: thinkingContent || null,
			thinkingSignature,
			thinkingRedactedData,
			thinkingEncryptedContent,
			toolCalls: dropSupersededToolCallDrafts(toolCalls),
			usage: {
				inputTokens,
				outputTokens,
				cacheWriteTokens,
				cacheReadTokens,
				usageEstimated,
			},
			costUsdFromHub,
		};
	}

	cancel(): void {
		this.aborted = true;
		this.ctx.logger.info("Agent loop cancelled");
	}

	/** Delegates to the standalone withSilenceTimeout. */
	private withSilenceTimeout<T>(
		source: AsyncIterable<T>,
		timeoutMs: number,
		onHeartbeat?: () => void,
	): AsyncGenerator<T> {
		return withSilenceTimeout(source, timeoutMs, onHeartbeat);
	}
}

/**
 * Default interval between `onHeartbeat` firings while waiting for the next
 * chunk. 30s is short enough to keep any upstream inactivity timer (e.g. the
 * outer 35min timer in runLocalAgentLoop) from firing due to LLM warm-up or
 * mid-stream extended-thinking silence, but long enough to not spam callbacks.
 */
export const SILENCE_HEARTBEAT_INTERVAL_MS = 30_000;

/**
 * Rejects if no item yielded within timeoutMs. Optionally calls `onHeartbeat`
 * every `heartbeatIntervalMs` (default SILENCE_HEARTBEAT_INTERVAL_MS) while
 * waiting for the next chunk, so upstream inactivity timers can distinguish
 * "LLM is warming up / thinking silently" from "request is wedged."
 *
 * heartbeatIntervalMs is primarily a test hook; production code should use
 * the default.
 */
export async function* withSilenceTimeout<T>(
	source: AsyncIterable<T>,
	timeoutMs: number,
	onHeartbeat?: () => void,
	heartbeatIntervalMs: number = SILENCE_HEARTBEAT_INTERVAL_MS,
): AsyncGenerator<T> {
	const iterator = source[Symbol.asyncIterator]();

	while (true) {
		const nextChunkPromise = iterator.next();
		let timerId: ReturnType<typeof setTimeout> | null = null;
		let heartbeatId: ReturnType<typeof setInterval> | null = null;
		const timeoutPromise = new Promise<never>((_, reject) => {
			timerId = setTimeout(() => {
				reject(new Error(`LLM silence timeout: no chunk received for ${timeoutMs}ms`));
			}, timeoutMs);
		});
		if (onHeartbeat) {
			heartbeatId = setInterval(() => {
				try {
					onHeartbeat();
				} catch {
					// Heartbeat callbacks should never break the stream.
				}
			}, heartbeatIntervalMs);
		}

		let result: IteratorResult<T>;
		try {
			result = await Promise.race([nextChunkPromise, timeoutPromise]);
			if (timerId) clearTimeout(timerId);
			if (heartbeatId) clearInterval(heartbeatId);
		} catch (err) {
			if (timerId) clearTimeout(timerId);
			if (heartbeatId) clearInterval(heartbeatId);
			if (typeof iterator.return === "function") {
				await iterator.return(undefined).catch(() => {});
			}
			throw err;
		}

		if (result.done) {
			return;
		}

		yield result.value;
	}
}
