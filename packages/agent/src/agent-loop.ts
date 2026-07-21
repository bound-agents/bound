import {
	findLatestLiveMessageCreatedAtByThread,
	listLiveMessageDeltaByThreadSince,
} from "@bound/core";
import type { ContentBlock } from "@bound/llm";
import type { ContextDebugInfo, ContextSection, SyncConfig } from "@bound/shared";
import { countContentTokens, countTokens, formatError } from "@bound/shared";
import { context, trace } from "@opentelemetry/api";

import { convertDeltaMessages, getResolvedModelId, hasOrphanedToolCall } from "./agent-loop-utils";
import {
	buildCacheMarkers,
	coldPathPlaceCacheMarker,
	maybePlaceCacheMarker,
	refreshInnerLoopRollingMarker,
} from "./cache-marker";
import { selectCacheTtl } from "./cache-prediction";
import { type CachedTurnState, computeToolFingerprint } from "./cached-turn-state";
import {
	assembleContext,
	buildVolatileContext,
	computeBaseTruncationTarget,
	computeVolatileTailSection,
	realTimeClock,
	rebuildWarmSections,
} from "./context-assembly";
import { resolveAdaptiveTruncationTarget } from "./inflation-ratio";
import { resolveTargetCapabilities } from "./model-resolution";
import { sharedStableSubsectionCache } from "./stable-prefix";
import { extractAssistantSeedText, extractSummaryAndMemories } from "./summary-extraction";
import { compactStoredMessagesInPlace, computeRecentWindow } from "./warm-compaction";

import { BoundAgentLoop, type BoundPreparedFrame } from "./bound-agent-loop";

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

export class MainAgentLoop extends BoundAgentLoop {
	protected _visionAdvisoryEmitted?: Set<string>;

	/**
	 * Accessor for this thread's cached turn state. Lives in ctx.turnStateStore
	 * so it survives MainAgentLoop instance teardown (e.g. across client-tool
	 * defer/wakeup cycles). Previously an instance field, which meant every
	 * fresh MainAgentLoop started cold regardless of upstream cache liveness.
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
	 * stale snapshot. (Observed in production: the agent kept re-stating
	 * a stale file-deletion request on every inner-loop turn even after
	 * its own tool calls had already deleted the row.)
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

	protected override async afterRun(): Promise<void> {
		await super.afterRun();

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
			this.ctx.logger.info("Skipping summary extraction \u2014 model unresolvable cluster-wide", {
				threadId: this.config.threadId,
				summaryModelId,
			});
		}
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

		const resolvedCaps = resolveTargetCapabilities(resolution, this.modelRouter);
		const cacheMarkerCaps = resolvedCaps;
		const contextWindow = resolution.max_context;
		const mergedTools = this.getMergedTools();
		const toolTokenEstimate = mergedTools ? countTokens(JSON.stringify(mergedTools)) : 0;
		const resolvedModelForDebug = getResolvedModelId(resolution, this.config.modelId);
		const threadInterface = this.config.platform ?? "web";
		const cacheTtl = selectCacheTtl(threadInterface);
		const maxOutputTokens = this.effectiveMaxOutputTokens();
		const baseTruncationTarget = computeBaseTruncationTarget(contextWindow, maxOutputTokens);
		const { target: truncationTargetTokens, inflation: measuredInflation } =
			resolveAdaptiveTruncationTarget(this.ctx.db, this.config.threadId, baseTruncationTarget);
		// Scaling factor for the physical `recentHardCeiling` (see context-assembly.ts
		// comment at its use site): 1 / measuredInflation, clamped to ≤ 1 so an
		// over-counting estimator (inflation < 1.0) never loosens the ceiling.
		// Defaults to 1 (no tightening) on cold-start threads with no EMA yet.
		const recentHardCeilingDeflator =
			measuredInflation !== null ? Math.min(1, 1 / Math.max(1.0, measuredInflation)) : 1;
		// Fingerprint the merged set the model actually receives — registry
		// (built-ins + native agent tools) + client + platform + config extras —
		// not the partial config.tools slice. Otherwise client/registry tool
		// changes go undetected while the warm/cold decision keys off a set that
		// doesn't match what was sent.
		const currentFingerprint = computeToolFingerprint(mergedTools);
		let cachePathReason: ContextDebugInfo["cachePathReason"] = this.config.noHistory
			? "no-history"
			: "no-stored-state";
		// Warm-path eligibility does NOT consult predictCacheState. That heuristic
		// guesses warm/cold from the prior turn's cache-token counts, which is
		// noisy on an active thread: it flipped to "cold" on turns where the
		// provider prefix cache was in fact still warm, discarding usable cached
		// state and forcing an expensive cold rebuild (observed live: 77 such
		// false-cold turns in one thread). The TTL concern it nominally guarded —
		// a thread idle past the prompt-cache lifetime — is already handled, and
		// more precisely, by the turn-state store's own eviction (constructed at
		// 55m, shorter than the 1h upstream cache TTL): an idle thread's state is
		// evicted, so getCachedTurnState returns undefined and the path falls to
		// "no-stored-state" cold. predictCacheState remains for cache-warm-poke.
		const cachedForWarm = this.getCachedTurnState();
		const isWarmPathEligible =
			!this.config.noHistory &&
			cachedForWarm !== undefined &&
			cachedForWarm.toolFingerprint === currentFingerprint;

		if (isWarmPathEligible && cachedForWarm) {
			const assembleContextSpan = getTracer().startSpan("agent-loop.assemble-context", {
				attributes: {
					"context.cache_path": "warm",
					"context.truncation_target_tokens": truncationTargetTokens,
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
				const warmEffectiveBudget = truncationTargetTokens;
				let warmCompactionTokensSaved = 0;
				if (estimatedTotal > warmEffectiveBudget) {
					const compactionResult = compactStoredMessagesInPlace(storedMessages, {
						recentWindow: computeRecentWindow(contextWindow),
						contextWindow,
						truncationTargetTokens,
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
						truncationTargetTokens,
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
							// Reuse the cold-path assembly instant so a delegated warm turn
							// ships the same nowMs the stored history was annotated under,
							// keeping the consumer's range re-annotation byte-identical (R-UD4).
							assemblyNowMs: cached.assemblyNowMs ?? Date.now(),
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
						truncationTargetTokens,
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
		}

		const assembleContextSpan = getTracer().startSpan("agent-loop.assemble-context", {
			attributes: {
				"context.cache_path": "cold",
				"context.cold_reason": cachePathReason,
				"context.truncation_target_tokens": truncationTargetTokens,
			},
		});
		// One clock per assembly (R-UD4). The instant is captured so the producer
		// can stamp it onto the inference relay payload — the consumer threads the
		// SAME nowMs into resolveSegments so range bytes match the producer's.
		const assemblyClock = realTimeClock();
		const assemblyNowMs = assemblyClock.nowMs();
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
					truncationTargetTokens,
					recentHardCeilingDeflator,
					noHistory: this.config.noHistory,
					systemPromptAddition: this.config.systemPromptAddition,
					platformInstructions: this.config.platformInstructions,
					commandRegistry: this.ctx.commandRegistry,
					stableSubsectionCache: sharedStableSubsectionCache,
					clock: assemblyClock,
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
			truncationTargetTokens,
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
			assemblyNowMs,
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
			assembled: {
				messages,
				systemPrompt: result.systemPrompt,
				debug: contextDebug,
				assemblyNowMs,
			},
			messages,
			toolDefinitions: mergedTools ?? [],
			mergedTools,
			relayInfo,
			resolvedModelForDebug,
			resolvedCaps,
			cacheMarkerCaps,
			contextWindow,
			toolTokenEstimate,
			truncationTargetTokens,
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

	/**
	 * Persist a developer-role notification telling the model its previous turn
	 * produced no actionable output. checkDegenerateRetry then returns a
	 * frame-rebuilding retry, so the next turn's context-assembly picks this
	 * message up from the thread — the model reads it and responds (concisely, if
	 * it was truncated) on the retry.
	 */
	protected override beforeFrameRebuild(): void {
		// Drop the warm-path prompt-cache turn state so the rebuilt frame takes
		// the cold path and recomputes cache-marker placement against the
		// post-retry message set (which now includes the degenerate-turn
		// notification), instead of reusing positions captured for the prior set.
		this.clearCachedTurnState();
	}
}

// Re-export loop-guard constants and silence utilities for backward compatibility.
// These were previously re-exported from this file directly; they now live in
// bound-agent-loop.ts, which is the BoundAgentLoop base class module.
export {
	SILENCE_TIMEOUT_MS,
	MAX_SILENCE_RETRIES,
	MAX_DEGENERATE_RETRIES,
	SILENCE_HEARTBEAT_INTERVAL_MS,
	withSilenceTimeout,
	MAX_CONSECUTIVE_TRUNCATED_TURNS,
	MAX_CONSECUTIVE_DUPLICATE_TOOL_CALLS,
	MAX_CONSECUTIVE_ERROR_TOOL_CALLS,
	ERROR_SIGNATURE_NUDGE_AT,
	MAX_CONSECUTIVE_ROUTING_ERROR_TOOL_CALLS,
} from "./bound-agent-loop";
