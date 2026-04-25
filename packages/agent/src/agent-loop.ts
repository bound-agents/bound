import { randomUUID } from "node:crypto";

import type { AppContext } from "@bound/core";
import {
	enqueueClientToolCall,
	insertRow,
	markProcessed,
	readInboxByRefId,
	readInboxByStreamId,
	recordContextDebug,
	recordTurn,
	recordTurnRelayMetrics,
	resolveRelayConfig,
	updateRow,
	writeOutbox,
} from "@bound/core";
import type { ContentBlock, ModelRouter, StreamChunk, ToolDefinition } from "@bound/llm";
import type { InferenceRequestPayload, StreamChunkPayload } from "@bound/llm";
import { LLMError } from "@bound/llm";
import type {
	ContextDebugInfo,
	EventMap,
	RelayInboxEntry,
	RelayKind,
	SyncConfig,
} from "@bound/shared";
import {
	countContentTokens,
	countTokens,
	errorPayloadSchema,
	formatError,
	parseJsonSafe,
	parseJsonUntyped,
	resultPayloadSchema,
} from "@bound/shared";

import {
	buildCommandOutput,
	calculateTurnCost,
	convertDeltaMessages,
	deriveCapabilityRequirements,
	getResolvedModelId,
	insertThreadMessage,
	isTransientLLMError,
	parseToolResultContent,
} from "./agent-loop-utils";
import { CACHE_TTL_MS, predictCacheState, selectCacheTtl } from "./cache-prediction";
import { type CachedTurnState, computeToolFingerprint } from "./cached-turn-state";
import { assembleContext, buildVolatileContext } from "./context-assembly";
import { trackFilePath } from "./file-thread-tracker";
import { type RelayToolCallRequest, isRelayRequest } from "./mcp-bridge";
import { type ModelResolution, resolveModel, resolveSameTierFallback } from "./model-resolution";
import { type EligibleHost, createRelayOutboxEntry } from "./relay-router";
import { extractSummaryAndMemories } from "./summary-extraction";
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
import { isClientToolCallRequest } from "./types";

export const SILENCE_TIMEOUT_MS = 600_000;
export const MAX_SILENCE_RETRIES = 3;
/** Default max output tokens. Bedrock defaults to 4096 if unset, which truncates large tool calls. */
export const DEFAULT_MAX_OUTPUT_TOKENS = 16_384;

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
	toolCalls: ParsedToolCall[];
	usage: {
		inputTokens: number;
		outputTokens: number;
		cacheWriteTokens: number | null;
		cacheReadTokens: number | null;
		usageEstimated: boolean;
	};
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

	async run(): Promise<AgentLoopResult> {
		const loopStartTime = Date.now();
		let turnCount = 0;

		this.ctx.logger.info("[agent-loop] Starting", {
			threadId: this.config.threadId,
			taskId: this.config.taskId ?? null,
			userId: this.config.userId,
			modelHint: this.config.modelId ?? "default",
			platform: this.config.platform ?? null,
			toolCount: this.config.tools?.length ?? 0,
			hasPlatformTools: this.config.platformTools ? this.config.platformTools.size : 0,
		});

		try {
			this.state = "HYDRATE_FS";
			if (this.sandbox.capturePreSnapshot) {
				await this.sandbox.capturePreSnapshot();
			}

			this.state = "ASSEMBLE_CONTEXT";

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

			// Check if warm path is eligible
			const isWarmPathEligible =
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

			const cachedForWarm = this.getCachedTurnState();
			if (isWarmPathEligible && cachedForWarm) {
				// WARM PATH: Try to reuse stored messages and append delta
				const cached = cachedForWarm;

				// 1. Fetch delta messages from DB (created after lastMessageCreatedAt)
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

				this.ctx.logger.debug("[agent-loop] Warm path: delta messages fetched", {
					storedMessageCount: cached.messages.length,
					deltaMessageCount: deltaMessages.length,
				});

				// 3. Rebuild message array: stored (without old developer tail) + delta
				const storedMessages = [...cached.messages];
				const lastIdx = storedMessages.length - 1;
				if (storedMessages[lastIdx]?.role === "developer") {
					storedMessages.pop();
				}

				storedMessages.push(...deltaMessages);

				// 4. Place rolling cache message at messages[length-2] (before last delta message)
				if (storedMessages.length >= 2) {
					storedMessages.splice(storedMessages.length - 1, 0, { role: "cache", content: "" });
				}

				// 5. Inject fresh volatile developer message at tail
				const volatileContext = buildVolatileContext({
					db: this.ctx.db,
					threadId: this.config.threadId,
					taskId: this.config.taskId,
					userId: this.config.userId,
					siteId: this.ctx.siteId,
					hostName: this.ctx.hostName,
					currentModel: resolvedModelForDebug,
					relayInfo,
					platformContext: this.config.platform
						? {
								platform: this.config.platform,
								toolNames: this.config.platformTools
									? Array.from(this.config.platformTools.keys())
									: undefined,
							}
						: undefined,
					systemPromptAddition: this.config.systemPromptAddition,
				});

				storedMessages.push({
					role: "developer",
					content: volatileContext.content,
				});

				// 6. Check high-water mark: estimate total token count and compare against contextWindow
				const storedTokens = storedMessages.reduce(
					(sum, msg) => sum + countContentTokens(msg.content),
					0,
				);
				const systemTokens = cached.systemPrompt ? countContentTokens(cached.systemPrompt) : 0;
				const estimatedTotal = storedTokens + systemTokens + toolTokenEstimate;

				if (estimatedTotal > contextWindow) {
					// High-water mark exceeded — fall through to cold path
					this.ctx.logger.info(
						"[agent-loop] Warm path exceeded context budget, triggering cold reassembly",
						{
							estimatedTotal,
							contextWindow,
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
					this.setCachedTurnState({
						...cached,
						messages: [...storedMessages],
						cacheMessagePositions: [
							...cached.cacheMessagePositions,
							storedMessages.length - 2, // rolling cache position
						],
						lastMessageCreatedAt: newLastRow?.created_at ?? new Date().toISOString(),
					});

					// 9. Use stored messages directly (no system messages in the array)
					llmMessages = storedMessages;

					// Use cached debug
					contextDebug = {
						contextWindow: contextWindow,
						totalEstimated: estimatedTotal,
						model: resolvedModelForDebug ?? "unknown",
						sections: [],
						budgetPressure: false,
						truncated: 0,
					};
				}
			}

			// Log warm/cold path decision with reason and counts
			this.ctx.logger.info("[agent-loop] Cache path selected", {
				path: usedWarmPath ? "warm" : "cold",
				reason: !this.getCachedTurnState()
					? "no-stored-state"
					: cacheState === "cold"
						? "cache-expired"
						: !isWarmPathEligible &&
								this.getCachedTurnState()?.toolFingerprint !== currentFingerprint
							? "tool-change"
							: usedWarmPath === false
								? "budget-exceeded"
								: "warm-eligible",
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
				const result = assembleContext({
					db: this.ctx.db,
					threadId: this.config.threadId,
					taskId: this.config.taskId,
					userId: this.config.userId,
					currentModel: resolvedModelForDebug,
					contextWindow: contextWindow,
					hostName: this.ctx.hostName,
					siteId: this.ctx.siteId,
					relayInfo,
					platformContext: this.config.platform
						? {
								platform: this.config.platform,
								toolNames: this.config.platformTools
									? Array.from(this.config.platformTools.keys())
									: undefined,
							}
						: undefined,
					targetCapabilities: resolvedCaps ?? undefined,
					toolTokenEstimate,
					compactToolResults: true,
					noHistory: this.config.noHistory,
					systemPromptAddition: this.config.systemPromptAddition,
				});

				// assembleContext now returns systemPrompt separately — no system-role
				// messages in the array, no filtering needed.
				const contextMessages = result.messages;
				const systemPrompt = result.systemPrompt;
				contextDebug = result.debug;

				// Place fixed cache message at messages[length-2] (before last message)
				const fixedCacheIdx = contextMessages.length >= 2 ? contextMessages.length - 2 : -1;
				if (fixedCacheIdx >= 0) {
					contextMessages.splice(fixedCacheIdx + 1, 0, { role: "cache", content: "" });
				}

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
					cacheMessagePositions: fixedCacheIdx >= 0 ? [fixedCacheIdx + 1] : [],
					fixedCacheIdx: fixedCacheIdx >= 0 ? fixedCacheIdx + 1 : -1,
					lastMessageCreatedAt,
					toolFingerprint: currentFingerprint,
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
				const turnStartTime = Date.now();
				this.state = "LLM_CALL";
				const chunks: StreamChunk[] = [];
				let currentTurnId: number | null = null;
				let resolvedModelId: string | null = null;
				const relayMetadataRef: { hostName?: string; firstChunkLatencyMs?: number } = {};

				this.ctx.logger.info("[agent-loop] LLM call starting", {
					turn: turnCount,
					model: getResolvedModelId(this.lastModelResolution, this.config.modelId || "unknown"),
					messageCount: llmMessages.length,
					kind: this.lastModelResolution?.kind ?? "unknown",
				});

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
								max_tokens: DEFAULT_MAX_OUTPUT_TOKENS,
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
								inferencePayload = {
									...inferencePayload,
									messages: [], // Clear inline messages
									messages_file_ref: fileRef,
								};
							}

							for await (const chunk of this.relayStream(
								inferencePayload,
								resolution.hosts,
								relayMetadataRef,
							)) {
								if (this.aborted) break;
								if (chunk.type === "heartbeat") continue;
								chunks.push(chunk);
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
									const chatStream = resolution.backend.chat({
										messages: llmMessages,
										system: systemPrompt || undefined,
										tools: mergedTools,
										max_tokens: DEFAULT_MAX_OUTPUT_TOKENS,
										thinking: resolution.thinkingConfig,
										effort: resolution.effort,
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
										chunks.push(chunk);
									}
									break; // Stream completed — exit retry loop
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
				} catch (error) {
					// Transient transport errors (HTTP/2 drops, socket resets): retry
					// Non-transient errors (4xx client errors like invalid JSON) are NOT retried.
					const errMsg = error instanceof Error ? error.message : String(error);
					if (isTransientLLMError(error) && transportRetries < MAX_SILENCE_RETRIES) {
						transportRetries++;
						this.ctx.logger.warn("[agent-loop] Transport error, retrying", {
							attempt: transportRetries,
							max: MAX_SILENCE_RETRIES,
							error: errMsg,
						});
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
								continue;
							}

							this.ctx.logger.warn(
								"[agent-loop] Rate-limit fallback: no alternative backend available",
								{ backendId },
							);
						}
					}

					this.state = "ERROR_PERSIST";
					const errorMsg = formatError(error);
					this.ctx.logger.error("[agent-loop] LLM call failed (non-retryable)", {
						turn: turnCount,
						error: errorMsg,
						statusCode: error instanceof LLMError ? error.statusCode : null,
						model: getResolvedModelId(this.lastModelResolution, this.config.modelId || "unknown"),
						durationMs: Date.now() - turnStartTime,
					});

					this.emitAlert(`Error: ${errorMsg}`);

					return {
						messagesCreated: this.messagesCreated,
						toolCallsMade: this.toolCallsMade,
						filesChanged: this.filesChanged,
						error: errorMsg,
					};
				}

				this.state = "PARSE_RESPONSE";
				const parsed = this.parseResponseChunks(chunks);
				const llmDurationMs = Date.now() - turnStartTime;

				this.ctx.logger.info("[agent-loop] LLM response received", {
					turn: turnCount,
					durationMs: llmDurationMs,
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
					break;
				}

				try {
					resolvedModelId = getResolvedModelId(
						this.lastModelResolution,
						this.config.modelId || "unknown",
					);

					const backends = this.ctx.config?.modelBackends?.backends ?? [];
					const cost_usd = calculateTurnCost(resolvedModelId, parsed.usage, backends);

					currentTurnId = recordTurn(this.ctx.db, {
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
					});
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
						);
					} catch (error) {
						this.ctx.logger.warn("Failed to record turn relay metrics", {
							threadId: this.config.threadId,
							turnId: currentTurnId,
							error: error instanceof Error ? error.message : String(error),
						});
					}
				}

				// Update context debug with actual LLM-reported token counts
				// (inputTokens may exclude cached tokens on Bedrock)
				if (this.lastContextDebug && parsed.usage.inputTokens > 0) {
					const actualTokens =
						parsed.usage.inputTokens +
						(parsed.usage.cacheReadTokens ?? 0) +
						(parsed.usage.cacheWriteTokens ?? 0);
					const previousEstimated = this.lastContextDebug.totalEstimated;
					const delta = actualTokens - previousEstimated;
					this.lastContextDebug = {
						...this.lastContextDebug,
						totalEstimated: actualTokens,
					};
					if (delta > 0) {
						const historySec = this.lastContextDebug.sections.find((s) => s.name === "history");
						if (historySec) {
							historySec.tokens += delta;
						}
					}
				}

				if (currentTurnId !== null && this.lastContextDebug) {
					try {
						recordContextDebug(this.ctx.db, currentTurnId, this.lastContextDebug);
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
					// Cooperative cancellation: check before executing tools
					if (this.config.shouldYield?.()) {
						this.ctx.logger.info(
							"[agent-loop] Yielding before tool execution (cooperative cancel)",
						);
						this.yielded = true;
						break;
					}

					this.state = "TOOL_EXECUTE";
					const toolResults: Array<{
						toolCall: ParsedToolCall;
						content: string;
						exitCode: number;
					}> = [];
					const pendingClientCalls: Array<{
						toolCall: ParsedToolCall;
						request: ClientToolCallRequest;
					}> = [];

					for (const toolCall of parsed.toolCalls) {
						this.toolCallsMade++;
						let resultContent: string;
						let exitCode = 0;
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
								const result = await this.executeToolCall(toolCall);

								if ("outboxEntryId" in result) {
									resultContent = await this.relayWait(result, toolCall, currentTurnId);
								} else if (isClientToolCallRequest(result)) {
									// Client tool calls are deferred to the client — track but don't get result yet
									pendingClientCalls.push({ toolCall, request: result });
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
									continue;
								} else {
									resultContent = result.content;
									exitCode = result.exitCode;
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

						toolResults.push({ toolCall, content: resultContent, exitCode });
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

					// Persist tool messages before next LLM call (pairing invariant)
					this.state = "TOOL_PERSIST";

					const toolCallBlocks: ContentBlock[] = [];

					// Preserve thinking block for multi-turn reasoning continuity.
					// Anthropic requires the signed thinking block to come FIRST in the
					// assistant message's content blocks during extended thinking.
					if (parsed.thinking) {
						const thinkingBlock: ContentBlock = {
							type: "thinking",
							thinking: parsed.thinking,
						};
						if (parsed.thinkingSignature) {
							thinkingBlock.signature = parsed.thinkingSignature;
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
							content: parseToolResultContent(content),
							tool_use_id: toolCall.id,
						});
					}

					// Note: inline assistant text is no longer persisted as a separate
					// row — it's folded into the tool_call message's content blocks above.
					// This avoids a trailing assistant-text row sitting between the
					// tool_call and tool_result on replay, which caused providers like
					// qwen3 (enable_thinking=true) to reject the next request as a
					// malformed prefill continuation.

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

							// Emit event for WS handler to deliver tool:call to client
							this.ctx.eventBus.emit("client_tool_call:created", {
								threadId: this.config.threadId,
								callId: toolCall.id,
								entryId,
								toolName: toolCall.name,
								arguments: toolCall.input,
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
						break;
					}

					// Cooperative cancellation: check after tool results persisted
					if (this.config.shouldYield?.()) {
						this.ctx.logger.info(
							"[agent-loop] Yielding after tool persistence (cooperative cancel)",
						);
						this.yielded = true;
						break;
					}

					continue;
				}

				// No tool calls — persist final response and exit
				this.state = "RESPONSE_PERSIST";
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

				continueLoop = false;
			}

			this.state = "FS_PERSIST";
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

			this.state = "QUEUE_CHECK";
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

			this.state = "IDLE";

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

			// Summary extraction requires a local LLM backend. On spoke nodes with no local
			// backends, skip extraction — it will be handled by the hub or a node that has one.
			const extractionBackend = this.modelRouter.tryGetBackend(this.modelRouter.getDefaultId());
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
				this.ctx.logger.info("Skipping summary extraction — no local backend available", {
					threadId: this.config.threadId,
				});
			}

			return {
				messagesCreated: this.messagesCreated,
				toolCallsMade: this.toolCallsMade,
				filesChanged: this.filesChanged,
				yielded: this.yielded || undefined,
			};
		} catch (error) {
			this.state = "ERROR_PERSIST";
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

	/** Poll relay inbox for remote tool call response. Handles timeout, failover, and cancellation. */
	private async relayWait(
		relayRequest: RelayToolCallRequest,
		toolCall: ParsedToolCall,
		currentTurnId: number | null,
	): Promise<string> {
		const previousState = this.state;
		this.state = "RELAY_WAIT";

		try {
			return await this._relayWaitImpl(relayRequest, toolCall, currentTurnId);
		} finally {
			this.state = previousState;
		}
	}

	private async _relayWaitImpl(
		relayRequest: RelayToolCallRequest,
		toolCall: ParsedToolCall,
		currentTurnId: number | null,
	): Promise<string> {
		let { outboxEntryId } = relayRequest;
		const { toolName, eligibleHosts } = relayRequest;
		const timeoutMs = 30_000; // 30 second timeout per host
		let currentHostIndex = relayRequest.currentHostIndex;
		let hostStartTime = Date.now();
		const relayStartTime = Date.now();

		while (true) {
			if (this.aborted) {
				const currentHost = eligibleHosts[currentHostIndex];
				const cancelEntry = createRelayOutboxEntry(
					currentHost.site_id,
					this.ctx.siteId,
					"cancel",
					JSON.stringify({}),
					30_000,
					outboxEntryId,
				);
				try {
					writeOutbox(this.ctx.db, cancelEntry);
				} catch (error) {
					this.ctx.logger.warn("Failed to write relay cancel outbox entry in RELAY_WAIT", {
						refId: outboxEntryId,
						error: error instanceof Error ? error.message : String(error),
					});
				}
				return "Cancelled: relay request was cancelled by user";
			}

			const currentHost = eligibleHosts[currentHostIndex];
			this.ctx.logger.info("Relay wait", {
				tool: toolName,
				host: currentHost.host_name,
			});

			// Wait for response via event listener (event-driven approach)
			const response = await new Promise<RelayInboxEntry | null>((resolve) => {
				const timeoutId = setTimeout(() => {
					cleanup();
					resolve(null); // timeout
				}, timeoutMs);

				const onInbox = (event: { ref_id?: string; stream_id?: string; kind: RelayKind }) => {
					if (this.aborted) {
						cleanup();
						resolve(null);
						return;
					}
					if (event.ref_id !== outboxEntryId) return;
					const entry = readInboxByRefId(this.ctx.db, outboxEntryId);
					if (!entry) return; // spurious event
					cleanup();
					resolve(entry);
				};

				const cleanup = () => {
					clearTimeout(timeoutId);
					this.ctx.eventBus.off("relay:inbox", onInbox);
				};

				// Check immediately in case entry arrived before listener
				const existing = readInboxByRefId(this.ctx.db, outboxEntryId);
				if (existing) {
					cleanup();
					resolve(existing);
					return;
				}

				this.ctx.eventBus.on("relay:inbox", onInbox);
			});

			if (response) {
				const latencyMs = Date.now() - relayStartTime;
				const currentHost = eligibleHosts[currentHostIndex];
				if (currentTurnId !== null) {
					try {
						recordTurnRelayMetrics(this.ctx.db, currentTurnId, currentHost.host_name, latencyMs);
					} catch (error) {
						this.ctx.logger.warn("Failed to record turn relay metrics", {
							threadId: this.config.threadId,
							turnId: currentTurnId,
							error: error instanceof Error ? error.message : String(error),
						});
					}
				}

				if (response.kind === "error") {
					const payloadResult = parseJsonSafe(errorPayloadSchema, response.payload, response.kind);
					markProcessed(this.ctx.db, [response.id]);
					if (!payloadResult.ok) {
						return `Remote error: ${response.payload}`;
					}
					return `Remote error: ${payloadResult.value.error || response.payload}`;
				}

				if (response.kind === "result") {
					const payloadResult = parseJsonSafe(resultPayloadSchema, response.payload, response.kind);
					markProcessed(this.ctx.db, [response.id]);
					if (!payloadResult.ok) {
						return `Remote result: ${response.payload}`;
					}
					return buildCommandOutput(
						payloadResult.value.stdout,
						payloadResult.value.stderr,
						payloadResult.value.exit_code,
					);
				}

				markProcessed(this.ctx.db, [response.id]);
				return `Unknown response kind: ${response.kind}`;
			}

			const elapsedMs = Date.now() - hostStartTime;
			if (elapsedMs > timeoutMs) {
				currentHostIndex++;
				if (currentHostIndex >= eligibleHosts.length) {
					return `Timeout: all ${eligibleHosts.length} eligible host(s) did not respond within ${timeoutMs}ms`;
				}

				const nextHost = eligibleHosts[currentHostIndex];
				const nextPayload = JSON.stringify({
					kind: "tool_call",
					toolName,
					args: toolCall.input,
				});
				const nextEntry = createRelayOutboxEntry(
					nextHost.site_id,
					this.ctx.siteId,
					"tool_call",
					nextPayload,
					timeoutMs,
				);
				try {
					writeOutbox(this.ctx.db, nextEntry);
					outboxEntryId = nextEntry.id; // Update polled ref_id for failover host
					hostStartTime = Date.now(); // Reset timeout for next host
				} catch {
					return `Failover failed: could not write outbox entry for host ${nextHost.host_name}`;
				}
			}
		}
	}

	/**
	 * Stream LLM inference from a remote host via relay. Listens for relay:inbox events,
	 * reorders by seq, fails over on timeout, and propagates cancellation.
	 */
	private async *relayStream(
		payload: InferenceRequestPayload,
		eligibleHosts: EligibleHost[],
		relayMetadataRef?: { hostName?: string; firstChunkLatencyMs?: number },
		options?: { pollIntervalMs?: number; perHostTimeoutMs?: number },
	): AsyncGenerator<StreamChunk> {
		const POLL_INTERVAL_MS = options?.pollIntervalMs ?? 500;
		const PER_HOST_TIMEOUT_MS = options?.perHostTimeoutMs ?? this.inferenceTimeoutMs;
		const MAX_GAP_CYCLES = 6; // ~3s at 500ms poll — allow time for sync-based delivery
		const previousState = this.state;
		this.state = "RELAY_STREAM";

		try {
			for (let hostIndex = 0; hostIndex < eligibleHosts.length; hostIndex++) {
				const host = eligibleHosts[hostIndex];
				const streamId = randomUUID();

				// Write inference request to outbox
				const serializedPayload = JSON.stringify(payload);
				const outboxEntry = createRelayOutboxEntry(
					host.site_id,
					this.ctx.siteId,
					"inference",
					serializedPayload,
					PER_HOST_TIMEOUT_MS,
					undefined, // refId — not used for inference (no idempotency key)
					undefined, // idempotencyKey — omitted per spec §3.6
					streamId,
				);
				writeOutbox(this.ctx.db, outboxEntry);

				this.ctx.logger.info("RELAY_STREAM: connecting", {
					host: host.host_name,
					model: payload.model,
					streamId,
				});

				let firstChunkReceived = false;
				const hostStartTime = Date.now(); // when we started waiting on this host
				let lastActivityTime = Date.now(); // updated on each new chunk (for mid-stream silence)
				let firstChunkLatencyMs: number | null = null;
				let nextExpectedSeq = 0;
				// Buffer for out-of-order chunks: seq -> StreamChunkPayload
				const buffer = new Map<number, StreamChunkPayload>();
				let gapCyclesWaited = 0;
				let hostSucceeded = false;
				let streamEndConsumed = false; // persistent flag: true once stream_end chunks are yielded

				// Polling loop for this host attempt with event-driven waiting
				while (true) {
					// Check abort/cancel before every poll
					if (this.aborted) {
						const cancelEntry = createRelayOutboxEntry(
							host.site_id,
							this.ctx.siteId,
							"cancel",
							JSON.stringify({}),
							30_000,
							outboxEntry.id, // ref_id points to original inference request
						);
						try {
							writeOutbox(this.ctx.db, cancelEntry);
						} catch (error) {
							this.ctx.logger.warn("Failed to write relay cancel outbox entry in RELAY_STREAM", {
								streamId,
								error: error instanceof Error ? error.message : String(error),
							});
						}
						return;
					}

					// Check per-host timeout: before first chunk use hostStartTime; after first chunk
					// use lastActivityTime (mid-stream silence). Both use PER_HOST_TIMEOUT_MS.
					const now = Date.now();
					const timeoutSource = firstChunkReceived ? lastActivityTime : hostStartTime;
					const elapsedMs = now - timeoutSource;
					if (elapsedMs > PER_HOST_TIMEOUT_MS) {
						this.ctx.logger.warn("RELAY_STREAM: timeout, failing over", {
							host: host.host_name,
							elapsedMs,
							nextHostAvailable: hostIndex + 1 < eligibleHosts.length,
						});
						break; // Exit inner while(true) — outer for-loop will try next host
					}

					// Wait for relay:inbox event with short timeout to allow periodic checks
					await new Promise<void>((resolve) => {
						const timeoutId = setTimeout(() => {
							cleanup();
							resolve();
						}, POLL_INTERVAL_MS);

						const onInbox = (event: { ref_id?: string; stream_id?: string; kind: RelayKind }) => {
							if (event.stream_id !== streamId) return;
							cleanup();
							resolve();
						};

						const cleanup = () => {
							clearTimeout(timeoutId);
							this.ctx.eventBus.off("relay:inbox", onInbox);
						};

						this.ctx.eventBus.on("relay:inbox", onInbox);
					});

					// Fetch all unprocessed stream_chunk / stream_end for this stream_id
					const inboxEntries = readInboxByStreamId(this.ctx.db, streamId);

					const errorEntry = inboxEntries.find((e) => e.kind === "error");
					if (errorEntry) {
						const errResult = parseJsonSafe(
							errorPayloadSchema,
							errorEntry.payload,
							errorEntry.kind,
						);
						markProcessed(this.ctx.db, [errorEntry.id]);
						if (!errResult.ok) {
							throw new Error(`Remote inference error: ${errorEntry.payload}`);
						}
						throw new Error(errResult.value.error ?? "Remote inference error");
					}

					// Buffer all received stream_chunk and stream_end entries by seq
					const streamEndEntry = inboxEntries.find((e) => e.kind === "stream_end");
					const chunkEntries = inboxEntries.filter((e) => e.kind === "stream_chunk");
					let streamEndSeq: number | null = null;

					for (const entry of [...chunkEntries, ...(streamEndEntry ? [streamEndEntry] : [])]) {
						const chunkResult = parseJsonUntyped(entry.payload, entry.kind);
						markProcessed(this.ctx.db, [entry.id]);
						if (!chunkResult.ok) {
							continue;
						}
						const chunkPayload = chunkResult.value as StreamChunkPayload;
						if (!buffer.has(chunkPayload.seq)) {
							buffer.set(chunkPayload.seq, chunkPayload);
						}
						if (entry.kind === "stream_end") {
							streamEndSeq = chunkPayload.seq;
						}
					}

					while (buffer.has(nextExpectedSeq)) {
						// biome-ignore lint/style/noNonNullAssertion: checked with buffer.has() above
						const chunkPayload = buffer.get(nextExpectedSeq)!;
						buffer.delete(nextExpectedSeq);
						nextExpectedSeq++;

						for (const chunk of chunkPayload.chunks) {
							if (!firstChunkReceived) {
								firstChunkReceived = true;
								firstChunkLatencyMs = Date.now() - hostStartTime; // first-chunk latency
								// Populate the metadata ref so it can be recorded after currentTurnId is set
								if (relayMetadataRef) {
									relayMetadataRef.hostName = host.host_name;
									relayMetadataRef.firstChunkLatencyMs = firstChunkLatencyMs;
								}
								this.ctx.logger.info("RELAY_STREAM: first chunk", {
									host: host.host_name,
									latencyMs: firstChunkLatencyMs,
								});
							}
							lastActivityTime = Date.now(); // reset mid-stream silence timer
							yield chunk;
						}
						// Track when stream_end's seq has been consumed
						if (streamEndSeq !== null && nextExpectedSeq > streamEndSeq) {
							streamEndConsumed = true;
						}
						gapCyclesWaited = 0; // Gap resolved
					}

					// Stream complete when stream_end has been consumed and buffer has no
					// forward entries. Use persistent flag so completion survives stale-entry
					// cleanup that may empty the buffer on a later poll cycle.
					if (streamEndConsumed && buffer.size === 0) {
						hostSucceeded = true;
						break;
					}

					// Detect gap — buffer has entries but next seq is missing
					if (buffer.size > 0) {
						gapCyclesWaited++;
						if (gapCyclesWaited >= MAX_GAP_CYCLES) {
							const sortedSeqs = Array.from(buffer.keys()).sort((a, b) => a - b);
							const lowestBuffered = sortedSeqs[0];
							this.ctx.logger.warn("RELAY_STREAM: seq gap detected, skipping", {
								expectedSeq: nextExpectedSeq,
								bufferedSeqs: sortedSeqs,
							});
							if (lowestBuffered < nextExpectedSeq) {
								// Stale duplicate chunks — discard them instead of jumping backwards
								for (const seq of sortedSeqs) {
									if (seq < nextExpectedSeq) buffer.delete(seq);
								}
							} else {
								// Forward gap — skip missing seqs and advance
								nextExpectedSeq = lowestBuffered;
							}
							gapCyclesWaited = 0;
						}
					}
				}

				if (hostSucceeded) {
					return; // Done
				}
				// Continue outer for-loop to try next host
			}

			// All hosts exhausted
			throw new Error(
				`inference-relay.AC1.5: all ${eligibleHosts.length} eligible host(s) timed out`,
			);
		} finally {
			this.state = previousState;
		}
	}

	/** Merge server tools and client tool definitions into a single LLM tool list. */
	private getMergedTools(): Array<ToolDefinition> | undefined {
		const serverTools = this.config.tools ?? [];
		const clientTools = this.config.clientTools ? Array.from(this.config.clientTools.values()) : [];
		const merged: Array<ToolDefinition> = [...serverTools, ...clientTools];
		return merged.length > 0 ? merged : undefined;
	}

	/** Execute a tool call via platform tools or sandbox. Returns relay request for remote MCP tools or client tool call request. */
	private async executeToolCall(
		toolCall: ParsedToolCall,
	): Promise<{ content: string; exitCode: number } | RelayToolCallRequest | ClientToolCallRequest> {
		const platformTool = this.config.platformTools?.get(toolCall.name);
		if (platformTool) {
			const content = await platformTool.execute(toolCall.input);
			return { content, exitCode: 0 };
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
				return { content: JSON.stringify(result), exitCode: hasError ? 1 : 0 };
			}
			const exitCode = result.startsWith("Error:") ? 1 : 0;
			return { content: result, exitCode };
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
			content: buildCommandOutput(result.stdout, result.stderr, result.exitCode),
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
		const toolCalls: ParsedToolCall[] = [];
		const argsAccumulator = new Map<string, string>();
		const nameMap = new Map<string, string>();
		let inputTokens = 0;
		let outputTokens = 0;
		let cacheWriteTokens: number | null = null;
		let cacheReadTokens: number | null = null;
		let usageEstimated = false;

		for (const chunk of remappedChunks) {
			if (chunk.type === "text") {
				textContent += chunk.content;
			} else if (chunk.type === "thinking") {
				thinkingContent += chunk.content;
				if (chunk.signature) thinkingSignature = chunk.signature;
			} else if (chunk.type === "tool_use_start") {
				argsAccumulator.set(chunk.id, "");
				nameMap.set(chunk.id, chunk.name);
			} else if (chunk.type === "tool_use_args") {
				const existing = argsAccumulator.get(chunk.id) ?? "";
				argsAccumulator.set(chunk.id, existing + chunk.partial_json);
			} else if (chunk.type === "tool_use_end") {
				const fullArgsJson = argsAccumulator.get(chunk.id) ?? "{}";
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
			} else if (chunk.type === "done") {
				inputTokens = chunk.usage.input_tokens;
				outputTokens = chunk.usage.output_tokens;
				cacheWriteTokens = chunk.usage.cache_write_tokens;
				cacheReadTokens = chunk.usage.cache_read_tokens;
				usageEstimated = chunk.usage.estimated;
			}
		}

		return {
			textContent,
			thinking: thinkingContent || null,
			thinkingSignature,
			toolCalls,
			usage: {
				inputTokens,
				outputTokens,
				cacheWriteTokens,
				cacheReadTokens,
				usageEstimated,
			},
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
