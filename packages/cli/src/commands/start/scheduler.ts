/** Scheduler subsystem: heartbeat/consolidation seeding and scheduler start. */

import {
	Scheduler,
	generateThreadTitle,
	resolveModel,
	seedConsolidation,
	seedHeartbeat,
} from "@bound/agent";
import type { AppContext } from "@bound/core";
import type { ModelRouter } from "@bound/llm";
import {
	type PlatformMcpRegistry,
	type PlatformRegisteredTool,
	registerConnectorEventDelivery,
} from "@bound/platforms";
import { formatError } from "@bound/shared";
import type { AgentLoopFactory } from "./agent-factory.js";
import { createPlatformConnectorTool, resolvePlatformToolsForThread } from "./platform-tools.js";
import { createRemotePlatformRequest } from "./server.js";

export interface SchedulerResult {
	schedulerHandle: { stop: () => void } | null;
	/**
	 * The unified connector tool built for this node, or null when no platform
	 * MCP registry was supplied. Exposed so callers (and tests) can reach the
	 * tool's `remotePlatformRequest`-backed actions without reconstructing the
	 * closure; `index.ts` ignores this field (reads only `schedulerHandle`).
	 */
	connectorTool: PlatformRegisteredTool | null;
	/**
	 * The modelRouter-gated resolver closures handed to the `Scheduler` — model
	 * validation, default/tier resolution, and post-run title generation — plus
	 * the platformMcpRegistry-gated platform-tool and platform-instructions
	 * resolvers. The model closures are null when no `modelRouter` was supplied
	 * (all four then `undefined`); the two platform closures are `undefined` when
	 * no `platformMcpRegistry` was supplied. Exposed so callers (and tests) can
	 * drive these closures directly instead of waiting out the scheduler's 30s
	 * poll to reach them through a task run; `index.ts` ignores this field (reads
	 * only `schedulerHandle`).
	 */
	resolvers: {
		modelValidator?: (
			modelId: string,
		) => { ok: true } | { ok: false; error: string; permanent?: boolean };
		generateTitle?: (threadId: string) => Promise<void>;
		platformToolResolver?: (threadId: string) => PlatformRegisteredTool[];
		platformInstructionsResolver?: (threadId: string) => string | undefined;
	} | null;
}

export function initScheduler(
	appContext: AppContext,
	agentLoopFactory: AgentLoopFactory,
	modelRouter: ModelRouter | null,
	// biome-ignore lint/suspicious/noExplicitAny: sandbox type is opaque from @bound/sandbox createSandbox
	sandbox: any,
	platformMcpRegistry?: PlatformMcpRegistry | null,
): SchedulerResult {
	try {
		seedHeartbeat(appContext.db, appContext.siteId);
		appContext.logger.info("[scheduler] Heartbeat task seeded");
	} catch (error) {
		appContext.logger.warn("[scheduler] Failed to seed heartbeat", {
			error: formatError(error),
		});
	}

	try {
		seedConsolidation(appContext.db, appContext.siteId);
		appContext.logger.info("[scheduler] Consolidation task seeded");
	} catch (error) {
		appContext.logger.warn("[scheduler] Failed to seed consolidation", {
			error: formatError(error),
		});
	}

	appContext.logger.info("Starting scheduler...");
	let schedulerHandle: { stop: () => void } | null = null;
	let connectorTool: PlatformRegisteredTool | null = null;
	let resolvers: SchedulerResult["resolvers"] = null;
	try {
		if (platformMcpRegistry) {
			connectorTool = createPlatformConnectorTool({
				registry: platformMcpRegistry,
				db: appContext.db,
				siteId: appContext.siteId,
				remotePlatformRequest: createRemotePlatformRequest(appContext),
				logger: appContext.logger,
			});
		}

		resolvers = {
			modelValidator: modelRouter
				? (modelId: string) => {
						const resolution = resolveModel(modelId, modelRouter, appContext.db, appContext.siteId);
						if (resolution.kind === "error") {
							return {
								ok: false as const,
								error: resolution.error,
								// Permanent iff the model is registered nowhere in the cluster
								// (decommissioned). Drives poison-pill parking in the scheduler:
								// a permanent failure parks the task instead of rescheduling it
								// forever. A transient/capability reason stays retryable.
								permanent: resolution.reason === "unknown-model",
							};
						}
						return { ok: true as const };
					}
				: undefined,
			generateTitle:
				modelRouter && modelRouter.listBackends().length > 0
					? async (threadId: string) => {
							const result = await generateThreadTitle(
								appContext.db,
								threadId,
								modelRouter.getDefault(),
								appContext.siteId,
							);
							if (result.ok) {
								appContext.logger.info(`[scheduler] Thread title: ${result.value}`);
							}
						}
					: undefined,
			platformToolResolver: platformMcpRegistry
				? (threadId: string) =>
						resolvePlatformToolsForThread(platformMcpRegistry, threadId, connectorTool)
				: undefined,
			platformInstructionsResolver: platformMcpRegistry
				? (threadId: string) => platformMcpRegistry.getInstructionsForThread(threadId)
				: undefined,
		};

		const scheduler = new Scheduler(
			appContext,
			agentLoopFactory,
			{
				modelValidator: resolvers.modelValidator,
				generateTitle: resolvers.generateTitle,
				platformToolResolver: resolvers.platformToolResolver,
				platformInstructionsResolver: resolvers.platformInstructionsResolver,
			},
			sandbox?.bash,
		);
		schedulerHandle = scheduler.start(30_000);
		appContext.logger.info("[scheduler] Scheduler started (30s poll interval)");

		// Wire connector event listeners to scheduler for task wakeups (AC7.1)
		registerConnectorEventDelivery(appContext.eventBus, scheduler);
		appContext.logger.info("[scheduler] Connector event listeners registered");
	} catch (error) {
		appContext.logger.warn("[scheduler] Failed to start scheduler", {
			error: formatError(error),
		});
	}

	return { schedulerHandle, connectorTool, resolvers };
}
