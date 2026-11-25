import {
	acknowledgeBatch,
	acknowledgeToolResultForCall,
	claimPendingNotifications,
	enqueueClientToolCall,
	expireClientToolCallIfInFlight,
	findThreadParentIdById,
	findToolResultByThreadAndCallId,
	getClientToolCallStatus,
} from "@bound/core";
import type { LoopToolExecutionBatch, LoopTurnDecision, ParsedResponse } from "@bound/loop";
import { countTokens, injectTraceContext } from "@bound/shared";
import type { ContextDebugInfo, SyncConfig } from "@bound/shared";
import { context } from "@opentelemetry/api";

import { parseContentBlocks } from "./agent-loop-utils";
import { BoundAgentLoop, type BoundPreparedFrame } from "./bound-agent-loop";
import { buildCacheMarkers, coldPathPlaceCacheMarker } from "./cache-marker";
import { selectCacheTtl } from "./cache-prediction";
import { assembleContext, computeBaseTruncationTarget, realTimeClock } from "./context-assembly";
import { resolveClientSessionHost } from "./delegation";
import { injectNotificationMessage } from "./notification-injection";
import { sharedStableSubsectionCache } from "./stable-prefix";
import type { AgentLoopResult } from "./types";

/** Poll cadence for the inline client-tool wait. */
const CLIENT_TOOL_POLL_MS = 150;
/** Wait floor when the call names no timeout of its own. */
export const CLIENT_TOOL_TIMEOUT_MS = 300_000;
/** Headroom past the call's own timeout for the client's kill grace and the result's trip back. */
export const CLIENT_TOOL_TIMEOUT_GRACE_MS = 30_000;

type ClientToolWaitOutcome =
	| { kind: "result"; content: string; isError: boolean }
	| { kind: "timeout" }
	| { kind: "aborted" }
	| { kind: "dropped" };

function requestedClientToolTimeoutMs(input: Record<string, unknown>): number | null {
	const timeout = input.timeout;
	return typeof timeout === "number" && Number.isFinite(timeout) && timeout > 0 ? timeout : null;
}

/**
 * How long the aux waits on one client tool call (#278): the call's own
 * `timeout` (ms, as boundless tools take it) plus a grace margin, never less
 * than {@link CLIENT_TOOL_TIMEOUT_MS}.
 */
export function clientToolWaitMs(input: Record<string, unknown>): number {
	const requested = requestedClientToolTimeoutMs(input);
	return Math.max(
		CLIENT_TOOL_TIMEOUT_MS,
		requested === null ? 0 : requested + CLIENT_TOOL_TIMEOUT_GRACE_MS,
	);
}

/** The result text for a call the aux stopped waiting on, naming the real reason. */
export function describeClientToolGiveUp(
	toolName: string,
	reason: "timeout" | "aborted" | "dropped",
	waitMs: number,
	input: Record<string, unknown>,
): string {
	if (reason === "aborted") {
		return `Error: client tool "${toolName}" was cancelled because the aux loop was aborted before it returned`;
	}
	if (reason === "dropped") {
		return `Error: client tool "${toolName}" lost its client session before returning a result`;
	}
	const requested = requestedClientToolTimeoutMs(input);
	const budget =
		requested === null
			? `the ${Math.round(waitMs / 1000)}s default wait`
			: `its ${Math.round(requested / 1000)}s timeout plus ${Math.round(CLIENT_TOOL_TIMEOUT_GRACE_MS / 1000)}s grace`;
	return `Error: client tool "${toolName}" exceeded ${budget} with the session still connected; the call was cancelled on the client`;
}

/**
 * Aux threads with a nested loop running in THIS process. The dispatcher never
 * claims for an aux thread (its nested loop owns it), so `notify` uses this to
 * tell a deliverable target from one whose notification would strand (#294).
 */
const runningAuxLoops = new Map<string, number>();

export function isAuxLoopRunning(threadId: string): boolean {
	return (runningAuxLoops.get(threadId) ?? 0) > 0;
}

/** Thread ids with a nested aux loop running in this process. */
export function listRunningAuxLoopThreadIds(): string[] {
	return [...runningAuxLoops.keys()];
}

/** Mark a nested aux loop live on `threadId`; the returned function releases it. */
export function registerRunningAuxLoop(threadId: string): () => void {
	runningAuxLoops.set(threadId, (runningAuxLoops.get(threadId) ?? 0) + 1);
	let released = false;
	return () => {
		if (released) return;
		released = true;
		const remaining = (runningAuxLoops.get(threadId) ?? 1) - 1;
		if (remaining > 0) runningAuxLoops.set(threadId, remaining);
		else runningAuxLoops.delete(threadId);
	};
}

export class AuxAgentLoop extends BoundAgentLoop {
	override async run(): Promise<AgentLoopResult> {
		const release = registerRunningAuxLoop(this.config.threadId);
		try {
			return await super.run();
		} finally {
			release();
		}
	}

	/**
	 * Inject this thread's pending notifications as `developer` rows and ack
	 * them. Claims notification entries ONLY: tool_result re-wakes belong to the
	 * inline client-tool resolver and must never be consumed here. Returns the
	 * number delivered.
	 */
	protected drainPendingNotifications(): number {
		const threadId = this.config.threadId;
		const claimed = claimPendingNotifications(this.ctx.db, threadId, this.ctx.siteId);
		if (claimed.length === 0) return 0;
		let delivered = 0;
		for (const entry of claimed) {
			try {
				if (
					injectNotificationMessage(
						this.ctx.db,
						this.ctx.siteId,
						this.ctx.hostName,
						threadId,
						entry,
					)
				) {
					delivered++;
				}
			} catch (error) {
				this.ctx.logger.error("[aux-agent-loop] Failed to inject notification", {
					threadId,
					messageId: entry.message_id,
					error: error instanceof Error ? error.message : String(error),
				});
			}
		}
		acknowledgeBatch(this.ctx.db, claimed);
		this.ctx.logger.info("[aux-agent-loop] Delivered notifications between turns", {
			threadId,
			count: delivered,
		});
		return delivered;
	}

	/**
	 * A notification that lands while the model writes its final answer would
	 * strand once the loop exits. Deliver it and run one more turn instead of
	 * completing.
	 */
	protected override async runTurn(
		input: Parameters<BoundAgentLoop["runTurn"]>[0],
	): ReturnType<BoundAgentLoop["runTurn"]> {
		const outcome = await super.runTurn(input);
		if (
			outcome.action === "return" &&
			outcome.result.outcome === "completed" &&
			!this.aborted &&
			this.drainPendingNotifications() > 0
		) {
			return { action: "retry", rebuildFrame: true };
		}
		return outcome;
	}

	protected prepareAuxCacheMarker(
		messages: import("@bound/llm").LLMMessage[],
		cacheMarkerCaps: BoundPreparedFrame["cacheMarkerCaps"],
	) {
		return coldPathPlaceCacheMarker(
			messages,
			{
				bucketTokens: 0,
				estimateTokens: (message) => countTokens(JSON.stringify(message.content)),
			},
			cacheMarkerCaps ?? undefined,
		);
	}
	protected override async prepareFrame(input: {
		resolution: BoundPreparedFrame["resolution"];
	}): Promise<Omit<BoundPreparedFrame, "resolution">> {
		const resolution = input.resolution;
		// Between-turn steering (#294): every frame build (start + each
		// rebuildFrame retry) delivers queued notifications before assembly.
		this.drainPendingNotifications();
		const {
			relayInfo,
			resolvedCaps,
			cacheMarkerCaps,
			contextWindow,
			mergedTools,
			toolTokenEstimate,
			resolvedModelForDebug,
			maxOutputTokens,
		} = this.prepareSharedFrameInputs(resolution);
		const truncationTargetTokens = computeBaseTruncationTarget(contextWindow, maxOutputTokens);
		const cacheTtl = selectCacheTtl("aux");
		const assemblyClock = realTimeClock();
		const assemblyNowMs = assemblyClock.nowMs();

		const syncResult = this.ctx.optionalConfig?.sync;
		const syncConfig = syncResult?.ok ? (syncResult.value as SyncConfig) : undefined;
		const topologyRole: "hub" | "spoke" = syncConfig?.hub ? "spoke" : "hub";

		const result = assembleContext({
			db: this.ctx.db,
			threadId: this.config.threadId,
			taskId: this.config.taskId,
			userId: this.config.userId,
			currentModel: resolvedModelForDebug,
			contextWindow,
			noHistory: this.config.noHistory,
			hostName: this.ctx.hostName,
			siteId: this.ctx.siteId,
			topologyRole,
			targetCapabilities: resolvedCaps ?? undefined,
			toolTokenEstimate,
			truncationTargetTokens,
			recentHardCeilingDeflator: 1,
			platformInstructions: this.config.platformInstructions,
			systemPromptAddition: this.config.systemPromptAddition,
			// The aux identity IS the persona: replaces the main persona in the
			// stable prefix instead of riding as a suffix under it (aux threads
			// used to speak as the main agent).
			personaOverride: this.config.personaOverride,
			commandRegistry: this.ctx.commandRegistry,
			stableSubsectionCache: sharedStableSubsectionCache,
			clock: assemblyClock,
		});

		const fixedPlacement = this.prepareAuxCacheMarker(result.messages, cacheMarkerCaps);
		const contextDebug: ContextDebugInfo = {
			...result.debug,
			cacheMarkers: buildCacheMarkers({
				sections: result.debug.sections,
				messagePlacement: fixedPlacement,
				ttl: cacheTtl,
			}),
			cachePath: "cold",
			cachePathReason: "no-stored-state",
			truncationTargetTokens,
			measuredInflation: null,
		};
		this.lastContextDebug = contextDebug;

		this.ctx.logger.info("[aux-agent-loop] Context assembled", {
			threadId: this.config.threadId,
			messageCount: result.messages.length,
			contextWindow,
			toolTokenEstimate,
			totalEstimatedTokens: contextDebug.totalEstimated,
		});

		return {
			assembled: {
				messages: result.messages,
				systemPrompt: result.systemPrompt,
				debug: contextDebug,
				assemblyNowMs,
			},
			messages: result.messages,
			toolDefinitions: mergedTools ?? [],
			mergedTools,
			relayInfo,
			resolvedModelForDebug,
			resolvedCaps,
			cacheMarkerCaps,
			contextWindow,
			toolTokenEstimate,
			truncationTargetTokens,
			measuredInflation: null,
			cacheTtl,
		};
	}

	/**
	 * Resolve client (WS) tools INLINE instead of deferring the turn.
	 *
	 * The main-agent track defers: it enqueues the call, returns `{action:"stop"}`,
	 * and relies on `enqueueToolResult` waking the thread through `handleThread`.
	 * A nested aux loop cannot use that path — it runs inside the dispatching
	 * thread's turn, and a re-wake would construct a fresh MainAgentLoop on the aux
	 * thread, losing the persona, the `agentId` memory scoping, AND the
	 * `EXCLUDED_TOOLS` capability boundary. So the aux loop drives the same WS
	 * dispatch machinery and then blocks on the result, keeping one loop in charge
	 * of the thread for its whole lifetime.
	 *
	 * Delivery reaches the operator's client because the WS layer falls back to the
	 * PARENT thread's subscriptions — nothing ever subscribes to an aux thread.
	 */
	protected override async afterToolPersistence(
		parsed: ParsedResponse,
		frame: BoundPreparedFrame,
		batch: LoopToolExecutionBatch,
	): Promise<LoopTurnDecision> {
		if (batch.deferred.length === 0) {
			const decision = await super.afterToolPersistence(parsed, frame, batch);
			if (decision.action !== "continue") return decision;

			// Aux loops used to keep appending tool results to one in-memory frame
			// forever. Reassemble after every completed tool round so Stage 6 can
			// truncate against the CURRENT transcript rather than the invocation's
			// opening size. Run the normal post-execution guards here first because
			// returning retry makes the base runTurn skip its guard call.
			const guardDecision = await this.runPostExecutionGuards(batch, frame);
			if (guardDecision.action !== "continue") return guardDecision;
			return { action: "retry", rebuildFrame: true };
		}

		for (const { toolCall } of batch.deferred) {
			const connectionId = this.config.connectionId;
			if (!connectionId) {
				// No local WS connection. The parent's session may live on another
				// host (#295): relay the call there (invariant #21). The session
				// host's WS layer routes an aux thread's call to the parent's
				// subscriptions, so the aux thread id rides the payload unchanged.
				const parentThreadId = findThreadParentIdById(
					this.ctx.db,
					this.config.threadId,
				)?.parent_thread_id;
				const sessionHost = parentThreadId
					? resolveClientSessionHost(this.ctx.db, parentThreadId, this.ctx.siteId)
					: null;
				if (sessionHost) {
					// The session host waits as long as a local aux would (#278) and
					// owns the call's expiry there.
					const relayed = await this.relayDeferredClientTool(
						toolCall,
						sessionHost,
						clientToolWaitMs(toolCall.input),
					);
					const isError = relayed.exitCode !== 0;
					this.persistRelayedClientToolResult(toolCall.id, relayed.content, isError);
					frame.messages.push({
						role: "tool_result",
						content: parseContentBlocks(relayed.content),
						tool_use_id: toolCall.id,
					});
					acknowledgeToolResultForCall(this.ctx.db, this.config.threadId, toolCall.id);
					continue;
				}
				// No session anywhere: this tool can never execute. Persist the
				// failure as the result so the model reacts instead of stalling.
				this.persistRelayedClientToolResult(
					toolCall.id,
					`Error: client tool "${toolCall.name}" needs a live client session; the dispatching thread has none`,
					true,
				);
				acknowledgeToolResultForCall(this.ctx.db, this.config.threadId, toolCall.id);
				continue;
			}

			const entryId = enqueueClientToolCall(
				this.ctx.db,
				this.config.threadId,
				{ call_id: toolCall.id, tool_name: toolCall.name, arguments: toolCall.input },
				connectionId,
			);
			this.ctx.eventBus.emit("client_tool_call:created", {
				threadId: this.config.threadId,
				callId: toolCall.id,
				entryId,
				toolName: toolCall.name,
				arguments: toolCall.input,
				traceContext: context.with(context.active(), () => injectTraceContext()),
			});

			const waitMs = clientToolWaitMs(toolCall.input);
			const outcome = await this.awaitClientToolResultInline(toolCall.id, entryId, waitMs);
			let resolved: { content: string; isError: boolean } | null =
				outcome.kind === "result" ? outcome : null;
			let giveUpReason: string | null = null;
			if (outcome.kind !== "result") {
				// Timeout-vs-real-return arbitration (#278): whoever moves the entry
				// out of flight owns the call's single result. Winning the expiry means
				// the WS handler will discard a late client result; losing it means
				// the real result was acknowledged first and is already persisted.
				const won =
					outcome.kind !== "dropped" && expireClientToolCallIfInFlight(this.ctx.db, entryId);
				if (won) {
					giveUpReason = describeClientToolGiveUp(
						toolCall.name,
						outcome.kind,
						waitMs,
						toolCall.input,
					);
					this.persistRelayedClientToolResult(toolCall.id, giveUpReason, true);
					this.ctx.eventBus.emit("client_tool_call:cancel", {
						threadId: this.config.threadId,
						entryId,
						callId: toolCall.id,
						reason: outcome.kind === "aborted" ? "aborted" : "timeout",
					});
				} else {
					resolved = this.readClientToolResult(toolCall.id);
					if (!resolved) {
						// Someone else (connection-close or TTL reaper) expired the entry
						// without a result row: the session is gone.
						giveUpReason = describeClientToolGiveUp(
							toolCall.name,
							"dropped",
							waitMs,
							toolCall.input,
						);
						this.persistRelayedClientToolResult(toolCall.id, giveUpReason, true);
					}
				}
			}
			const content = resolved ? resolved.content : (giveUpReason ?? "");
			const isError = resolved ? resolved.isError : true;

			// Pair the result into the IN-MEMORY frame, not just the DB.
			//
			// `persistToolMessages` pushes a tool_result onto `frame.messages` only
			// for `batch.results`; deferred calls live in `batch.deferred` and never
			// enter `results`. The main-agent track gets away with that because it
			// returns {action:"stop"} and the next turn re-assembles from the DB,
			// discarding this frame. We CONTINUE on the same frame, so an unpaired
			// tool_call reaches the provider and the bridge's orphan repair
			// (packages/llm/src/bridge/messages.ts) substitutes "[no tool result
			// recorded: the call did not complete]". Observed live: a scout read the
			// probe file three times, every call returned exit_code 0 with correct
			// content, and the model still reported total failure — because its
			// context said so.
			frame.messages.push({
				role: "tool_result",
				content: parseContentBlocks(content),
				tool_use_id: toolCall.id,
			});
			this.ctx.logger.debug("[aux-agent-loop] Client tool resolved inline", {
				threadId: this.config.threadId,
				tool: toolCall.name,
				callId: toolCall.id,
				isError,
				timedOut: !resolved,
			});

			// The result row is already persisted (by the WS handler on success, or
			// by the branch above on failure) and the loop continues in-process, so
			// nothing will ever claim the queued re-wake. Close it here or crash
			// recovery re-dispatches a phantom wakeup on the next boot.
			acknowledgeToolResultForCall(this.ctx.db, this.config.threadId, toolCall.id);
		}

		// Every deferred call now has a persisted result AND an in-frame pairing.
		// Check the ordinary loop guards, then discard the growing live frame and
		// reassemble from persisted rows so context budgeting runs before the next
		// inference call.
		const guardDecision = await this.runPostExecutionGuards(batch, frame);
		if (guardDecision.action !== "continue") return guardDecision;
		return { action: "retry", rebuildFrame: true };
	}

	private readClientToolResult(callId: string): { content: string; isError: boolean } | null {
		const row = findToolResultByThreadAndCallId(this.ctx.db, this.config.threadId, callId);
		if (!row) return null;
		return { content: row.content, isError: (row.exit_code ?? 0) !== 0 };
	}

	/**
	 * Block until the WS layer persists this call's `tool_result` row (it writes
	 * `role='tool_result'`, `tool_name=call_id`), the wait budget elapses, the
	 * loop aborts, or the dispatch entry leaves flight without a result (the
	 * session dropped and a reaper expired it).
	 *
	 * Event-driven with a polling backstop, mirroring
	 * `RelayProcessor.awaitClientResult`: the event alone would be enough in the
	 * happy path, but the poll covers a result that landed between the enqueue and
	 * the subscription.
	 */
	private async awaitClientToolResultInline(
		callId: string,
		entryId: string,
		waitMs: number,
	): Promise<ClientToolWaitOutcome> {
		const settledOutcome = (): ClientToolWaitOutcome | null => {
			const found = this.readClientToolResult(callId);
			if (found) return { kind: "result", ...found };
			const status = getClientToolCallStatus(this.ctx.db, entryId);
			if (status !== "pending" && status !== "processing" && status !== "acknowledged") {
				return { kind: "dropped" };
			}
			return null;
		};

		const existing = settledOutcome();
		if (existing) return existing;

		return new Promise((resolve) => {
			let settled = false;
			const finish = (value: ClientToolWaitOutcome): void => {
				if (settled) return;
				settled = true;
				this.ctx.eventBus.off("message:created", onMessage);
				clearInterval(poll);
				clearTimeout(timer);
				resolve(value);
			};
			const check = (): void => {
				if (this.aborted) {
					finish({ kind: "aborted" });
					return;
				}
				const outcome = settledOutcome();
				if (outcome) finish(outcome);
			};
			const onMessage = (event: { thread_id: string }): void => {
				if (event.thread_id === this.config.threadId) check();
			};

			this.ctx.eventBus.on("message:created", onMessage);
			const poll = setInterval(check, CLIENT_TOOL_POLL_MS);
			const timer = setTimeout(() => finish({ kind: "timeout" }), waitMs);
			check();
		});
	}
}
