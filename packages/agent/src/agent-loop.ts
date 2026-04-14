import { randomUUID } from "node:crypto";

import type { AppContext } from "@bound/core";
import {
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
import type { ModelRouter, StreamChunk } from "@bound/llm";
import type { InferenceRequestPayload, StreamChunkPayload } from "@bound/llm";
import { LLMError } from "@bound/llm";
import type { ContextDebugInfo, SyncConfig } from "@bound/shared";
import {
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
	deriveCapabilityRequirements,
	getResolvedModelId,
	insertThreadMessage,
	isTransientLLMError,
} from "./agent-loop-utils";
import { assembleContext } from "./context-assembly";
import { trackFilePath } from "./file-thread-tracker";
import { type RelayToolCallRequest, isRelayRequest } from "./mcp-bridge";
import { type ModelResolution, resolveModel } from "./model-resolution";
import { type EligibleHost, createRelayOutboxEntry } from "./relay-router";
import { extractSummaryAndMemories } from "./summary-extraction";
import {
	TOOL_RESULT_OFFLOAD_THRESHOLD,
	buildOffloadMessage,
	offloadToolResultPath,
} from "./tool-result-offload";
import type { AgentLoopConfig, AgentLoopResult, AgentLoopState } from "./types";

export const SILENCE_TIMEOUT_MS = 60_000;
export const MAX_SILENCE_RETRIES = 10;

/**
 * Scale silence timeout based on estimated context size.
 * Bedrock cold-cache processing at 200k+ tokens can take 2-3+ minutes
 * for the first streaming chunk. Use tiered scaling:
 *   <= 50k: base (60s)
 *   50k-100k: base + 2s per 10k over 50k
 *   100k+: minimum 180s + 3s per 10k over 100k
 */
export function scaledSilenceTimeout(baseMs: number, estimatedTokens: number): number {
	if (estimatedTokens <= 50_000) return baseMs;
	if (estimatedTokens <= 100_000) {
		const extraMs = Math.floor((estimatedTokens - 50_000) / 10_000) * 2_000;
		return baseMs + extraMs;
	}
	// Large context tier: 180s floor + 3s per 10k over 100k
	const largeBaseMs = 180_000;
	const extraMs = Math.floor((estimatedTokens - 100_000) / 10_000) * 3_000;
	return Math.max(largeBaseMs, baseMs) + extraMs;
}

/**
 * Scale max silence retries based on context size.
 * For large cold-cache contexts, each retry resends the full context
 * and has the same chance of timing out. Retrying 10 times at 210s
 * each wastes 35 minutes. Use fewer retries for larger contexts.
 *   <= 100k: 10 retries (standard)
 *   100k-150k: 5 retries
 *   150k+: 3 retries
 */
export function scaledMaxRetries(estimatedTokens: number): number {
	if (estimatedTokens <= 100_000) return MAX_SILENCE_RETRIES;
	if (estimatedTokens <= 150_000) return 5;
	return 3;
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
}

/** Parsed tool call accumulated from stream chunks */
interface ParsedToolCall {
	id: string;
	name: string;
	input: Record<string, unknown>;
	argsJson: string;
}

/** Full parse result from an LLM response stream */
interface ParsedResponse {
	textContent: string;
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
				const fallbackResolution = resolveModel(
					undefined,
					this.modelRouter,
					this.ctx.db,
					this.ctx.siteId,
					requirements,
				);
				if (fallbackResolution.kind !== "error") {
					const warningMsg = `Model "${this.config.modelId}" is unavailable (${this.lastModelResolution.error}). Falling back to default model "${fallbackResolution.modelId}".`;
					this.ctx.logger.warn("[agent-loop] Model hint unavailable, falling back to default", {
						requestedModel: this.config.modelId,
						fallbackModel: fallbackResolution.modelId,
					});
					insertThreadMessage(
						this.ctx.db,
						{
							threadId: this.config.threadId,
							role: "alert",
							content: warningMsg,
							hostOrigin: this.ctx.siteId,
						},
						this.ctx.siteId,
					);
					this.lastModelResolution = fallbackResolution;
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

			const toolTokenEstimate = this.config.tools
				? countTokens(JSON.stringify(this.config.tools))
				: 0;

			const resolvedModelForDebug = getResolvedModelId(
				this.lastModelResolution,
				this.config.modelId,
			);

			// Deterministic compaction keeps cached prefixes stable while reducing context size
			const {
				messages: contextMessages,
				debug: contextDebug,
				systemSuffix,
			} = assembleContext({
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
			});

			this.lastContextDebug = contextDebug;

			this.ctx.logger.info("[agent-loop] Context assembled", {
				messageCount: contextMessages.length,
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

			const llmMessages = [...contextMessages];
			let continueLoop = true;
			let transportRetries = 0;

			while (continueLoop) {
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
					const systemMessages = llmMessages.filter((m) => m.role === "system");
					const nonSystemMessages = llmMessages.filter((m) => m.role !== "system");
					const systemPrompt = systemMessages
						.map((m) => (typeof m.content === "string" ? m.content : ""))
						.join("\n\n");

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
								messages: nonSystemMessages,
								tools: this.config.tools,
								system: systemPrompt || undefined,
								system_suffix: systemSuffix || undefined,
								max_tokens: undefined,
								temperature: undefined,
								cache_breakpoints: undefined,
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
								this.ctx.eventBus.emit("sync:trigger", { reason: "relay-large-prompt" });
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
								chunks.push(chunk);
							}
							break;
						}

						case "local": {
							// Place cache breakpoint at second-to-last message for prompt-cache reuse
							const cacheBreakpoints: number[] | undefined =
								nonSystemMessages.length >= 2 ? [nonSystemMessages.length - 2] : undefined;

							const totalEstimatedTokens = contextDebug.totalEstimated + toolTokenEstimate;
							const effectiveSilenceTimeout = scaledSilenceTimeout(
								SILENCE_TIMEOUT_MS,
								totalEstimatedTokens,
							);
							const effectiveMaxRetries = scaledMaxRetries(totalEstimatedTokens);

							let silenceRetries = 0;
							for (;;) {
								try {
									const chatStream = resolution.backend.chat({
										messages: nonSystemMessages,
										system: systemPrompt || undefined,
										system_suffix: systemSuffix || undefined,
										tools: this.config.tools,
										cache_breakpoints: cacheBreakpoints,
										signal: this.config.abortSignal,
									});
									for await (const chunk of this.withSilenceTimeout(
										chatStream,
										effectiveSilenceTimeout,
									)) {
										if (this.aborted) break;
										// Cooperative yield: check on every chunk during streaming
										if (this.config.shouldYield?.()) {
											this.yielded = true;
											this.aborted = true;
											break;
										}
										// Reset the inactivity timeout — the LLM is producing output
										this.config.onActivity?.();
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
									llmMessages.push({ role: "system", content: switchMsg });
									insertThreadMessage(
										this.ctx.db,
										{
											threadId: this.config.threadId,
											role: "system",
											content: switchMsg,
											hostOrigin: this.ctx.siteId,
										},
										this.ctx.siteId,
									);
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

					insertThreadMessage(
						this.ctx.db,
						{
							threadId: this.config.threadId,
							role: "alert",
							content: `Error: ${errorMsg}`,
							hostOrigin: this.ctx.siteId,
						},
						this.ctx.siteId,
					);

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
				});

				// Aborted mid-stream with no done chunk — persist notice and exit.
				// Skip the notice if this was a cooperative yield (shouldYield) — the
				// executor will retry the loop and the message will be processed.
				if (this.aborted && parsed.usage.inputTokens === 0 && parsed.usage.outputTokens === 0) {
					if (!this.yielded) {
						insertThreadMessage(
							this.ctx.db,
							{
								threadId: this.config.threadId,
								role: "system",
								content:
									"[Turn cancelled] The previous inference was cancelled before it could complete. " +
									"No response was generated for the last user message.",
								hostOrigin: this.ctx.siteId,
							},
							this.ctx.siteId,
						);
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

						try {
							const result = await this.executeToolCall(toolCall);

							if ("outboxEntryId" in result) {
								resultContent = await this.relayWait(result, toolCall, currentTurnId);
							} else {
								resultContent = result.content;
								exitCode = result.exitCode;
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

					const toolCallBlocks = parsed.toolCalls.map((tc) => ({
						type: "tool_use" as const,
						id: tc.id,
						name: tc.name,
						input: tc.input,
					}));

					insertThreadMessage(
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
					this.messagesCreated++;

					// In-memory context uses ContentBlock array (not JSON string)
					llmMessages.push({ role: "tool_call", content: toolCallBlocks });

					for (const { toolCall, content, exitCode } of toolResults) {
						insertThreadMessage(
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
						this.messagesCreated++;

						llmMessages.push({
							role: "tool_result",
							content,
							tool_use_id: toolCall.id,
						});
					}

					// Timestamp computed AFTER tool_result loop to sort after all results
					// (avoids sub-ms collisions that break Bedrock tool_call pairing)
					if (parsed.textContent) {
						insertThreadMessage(
							this.ctx.db,
							{
								threadId: this.config.threadId,
								role: "assistant",
								content: parsed.textContent,
								hostOrigin: this.ctx.siteId,
								modelId: resolvedModelId,
							},
							this.ctx.siteId,
						);
						this.messagesCreated++;
					}

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
				const assistantContent =
					parsed.textContent || (this.toolCallsMade > 0 ? "[turn complete]" : "");

				if (assistantContent) {
					insertThreadMessage(
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
				insertThreadMessage(
					this.ctx.db,
					{
						threadId: this.config.threadId,
						role: "alert",
						content: `Agent loop error: ${errorMsg}`,
						hostOrigin: this.ctx.siteId,
					},
					this.ctx.siteId,
				);
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
		const pollIntervalMs = 500;
		const timeoutMs = 30_000; // 30 second timeout per host
		let currentHostIndex = relayRequest.currentHostIndex;
		let hostStartTime = Date.now();
		const relayStartTime = Date.now();

		this.ctx.eventBus.emit("sync:trigger", { reason: "relay-wait" });

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
					this.ctx.eventBus.emit("sync:trigger", { reason: "relay-cancel" });
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

			const response = readInboxByRefId(this.ctx.db, outboxEntryId);
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
					this.ctx.eventBus.emit("sync:trigger", { reason: "relay-failover" });
					hostStartTime = Date.now(); // Reset timeout for next host
				} catch {
					return `Failover failed: could not write outbox entry for host ${nextHost.host_name}`;
				}
				continue;
			}

			// Wait before next poll
			await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
		}
	}

	/**
	 * Stream LLM inference from a remote host via relay. Polls for stream_chunk/stream_end,
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
				this.ctx.eventBus.emit("sync:trigger", { reason: "relay-stream" });

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

				// Polling loop for this host attempt
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
							this.ctx.eventBus.emit("sync:trigger", { reason: "relay-cancel" });
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

					// Wait before next poll
					await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
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

	/** Execute a tool call via platform tools or sandbox. Returns relay request for remote MCP tools. */
	private async executeToolCall(
		toolCall: ParsedToolCall,
	): Promise<{ content: string; exitCode: number } | RelayToolCallRequest> {
		const platformTool = this.config.platformTools?.get(toolCall.name);
		if (platformTool) {
			const content = await platformTool.execute(toolCall.input);
			return { content, exitCode: 0 };
		}

		if (!this.sandbox.exec) {
			return { content: "Error: sandbox execution not available", exitCode: 1 };
		}

		const result = await this.sandbox.exec(toolCall.input.command as string);

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
				try {
					input = JSON.parse(fullArgsJson);
				} catch {
					// leave as empty object
				}
				toolCalls.push({
					id: chunk.id,
					name,
					input,
					argsJson: fullArgsJson,
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

	/** Rejects if no item yielded within timeoutMs. */
	private async *withSilenceTimeout<T>(
		source: AsyncIterable<T>,
		timeoutMs: number,
	): AsyncGenerator<T> {
		const iterator = source[Symbol.asyncIterator]();

		while (true) {
			const nextChunkPromise = iterator.next();
			let timerId: ReturnType<typeof setTimeout> | null = null;
			const timeoutPromise = new Promise<never>((_, reject) => {
				timerId = setTimeout(() => {
					reject(new Error(`LLM silence timeout: no chunk received for ${timeoutMs}ms`));
				}, timeoutMs);
			});

			let result: IteratorResult<T>;
			try {
				result = await Promise.race([nextChunkPromise, timeoutPromise]);
				if (timerId) clearTimeout(timerId);
			} catch (err) {
				if (timerId) clearTimeout(timerId);
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
}
