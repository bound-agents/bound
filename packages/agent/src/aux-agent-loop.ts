import { countTokens } from "@bound/shared";
import type { ContextDebugInfo, SyncConfig } from "@bound/shared";

import { getResolvedModelId } from "./agent-loop-utils";
import { BoundAgentLoop, type BoundPreparedFrame } from "./bound-agent-loop";
import { selectCacheTtl } from "./cache-prediction";
import { assembleContext, computeBaseTruncationTarget, realTimeClock } from "./context-assembly";
import { resolveTargetCapabilities } from "./model-resolution";
import { sharedStableSubsectionCache } from "./stable-prefix";

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
}
