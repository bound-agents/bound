import {
	acknowledgeToolResultForCall,
	enqueueClientToolCall,
	findToolResultByThreadAndCallId,
} from "@bound/core";
import type { LoopToolExecutionBatch, LoopTurnDecision, ParsedResponse } from "@bound/loop";
import { countTokens, injectTraceContext } from "@bound/shared";
import type { ContextDebugInfo, SyncConfig } from "@bound/shared";
import { context } from "@opentelemetry/api";

import { getResolvedModelId } from "./agent-loop-utils";
import { BoundAgentLoop, type BoundPreparedFrame } from "./bound-agent-loop";
import { selectCacheTtl } from "./cache-prediction";
import { assembleContext, computeBaseTruncationTarget, realTimeClock } from "./context-assembly";
import { resolveTargetCapabilities } from "./model-resolution";
import { sharedStableSubsectionCache } from "./stable-prefix";

/** Poll cadence and ceiling for the inline client-tool wait. */
const CLIENT_TOOL_POLL_MS = 150;
const CLIENT_TOOL_TIMEOUT_MS = 300_000;

export class AuxAgentLoop extends BoundAgentLoop {
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
		const contextWindow = resolution.max_context;
		const mergedTools = this.getMergedTools();
		const toolTokenEstimate = mergedTools ? countTokens(JSON.stringify(mergedTools)) : 0;
		const resolvedModelForDebug = getResolvedModelId(resolution, this.config.modelId);
		const maxOutputTokens = this.effectiveMaxOutputTokens();
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
			systemPromptAddition: this.config.systemPromptAddition,
			commandRegistry: this.ctx.commandRegistry,
			stableSubsectionCache: sharedStableSubsectionCache,
			clock: assemblyClock,
		});

		const contextDebug: ContextDebugInfo = {
			...result.debug,
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
			cacheMarkerCaps: undefined,
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
			return super.afterToolPersistence(parsed, frame, batch);
		}

		for (const { toolCall } of batch.deferred) {
			const connectionId = this.config.connectionId;
			if (!connectionId) {
				// No inherited WS connection: the aux was dispatched from a surface
				// with no client session, so this tool can never execute. Persist the
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

			const resolved = await this.awaitClientToolResultInline(toolCall.id);
			if (!resolved) {
				this.persistRelayedClientToolResult(
					toolCall.id,
					`Error: client tool "${toolCall.name}" timed out or the session dropped before returning a result`,
					true,
				);
			}
			// The result row is already persisted (by the WS handler on success, or
			// by the branch above on failure) and the loop continues in-process, so
			// nothing will ever claim the queued re-wake. Close it here or crash
			// recovery re-dispatches a phantom wakeup on the next boot.
			acknowledgeToolResultForCall(this.ctx.db, this.config.threadId, toolCall.id);
		}

		// Every deferred call now has a persisted result, so the wire-legal
		// tool_call/tool_result pairing holds and the loop can take another turn.
		return { action: "continue" };
	}

	/**
	 * Block until the WS layer persists this call's `tool_result` row (it writes
	 * `role='tool_result'`, `tool_name=call_id`), or the ceiling elapses.
	 *
	 * Event-driven with a polling backstop, mirroring
	 * `RelayProcessor.awaitClientResult`: the event alone would be enough in the
	 * happy path, but the poll covers a result that landed between the enqueue and
	 * the subscription.
	 */
	private async awaitClientToolResultInline(
		callId: string,
	): Promise<{ content: string; isError: boolean } | null> {
		const read = (): { content: string; isError: boolean } | null => {
			const row = findToolResultByThreadAndCallId(this.ctx.db, this.config.threadId, callId);
			if (!row) return null;
			return { content: row.content, isError: (row.exit_code ?? 0) !== 0 };
		};

		const existing = read();
		if (existing) return existing;

		return new Promise((resolve) => {
			let settled = false;
			const finish = (value: { content: string; isError: boolean } | null): void => {
				if (settled) return;
				settled = true;
				this.ctx.eventBus.off("message:created", onMessage);
				clearInterval(poll);
				clearTimeout(timer);
				resolve(value);
			};
			const check = (): void => {
				if (this.aborted) {
					finish(null);
					return;
				}
				const found = read();
				if (found) finish(found);
			};
			const onMessage = (event: { thread_id: string }): void => {
				if (event.thread_id === this.config.threadId) check();
			};

			this.ctx.eventBus.on("message:created", onMessage);
			const poll = setInterval(check, CLIENT_TOOL_POLL_MS);
			const timer = setTimeout(() => finish(null), CLIENT_TOOL_TIMEOUT_MS);
			check();
		});
	}
}
