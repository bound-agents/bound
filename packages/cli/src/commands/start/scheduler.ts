/**
 * Scheduler subsystem: cron task seeding, heartbeat seeding, and scheduler
 * start. Graceful shutdown now lives in the single NodeHandle.stop() teardown
 * built in index.ts; this module no longer owns signal handlers.
 */

import {
	Scheduler,
	generateThreadTitle,
	resolveModel,
	seedConsolidation,
	seedHeartbeat,
} from "@bound/agent";
import type { AgentLoopConfig, MainAgentLoop } from "@bound/agent";
import { resolveTopologyRole, routeRelayRequest, serializeRelayTraceCarrier } from "@bound/agent";
import { awaitPlatformRequestResponse } from "@bound/agent";
import { type AppContext, findFreshPlatformHost } from "@bound/core";
import type { ModelRouter } from "@bound/llm";
import {
	type ConnectorToolContext,
	type PlatformMcpRegistry,
	type PlatformRegisteredTool,
	createConnectorTool,
	registerConnectorEventDelivery,
} from "@bound/platforms";
import { formatError, injectTraceContext } from "@bound/shared";
import { resolvePlatformToolsForThread } from "./platform-tools.js";

export type AgentLoopFactory = (config: AgentLoopConfig) => MainAgentLoop;

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
		modelDefaultResolver?: () => string;
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

	// 17. Scheduler
	appContext.logger.info("Starting scheduler...");
	let schedulerHandle: { stop: () => void } | null = null;
	// Create unified connector tool (replaces 4 dispatcher-specific tools). Hoisted
	// to function scope so it can be returned for callers/tests that drive its
	// remotePlatformRequest-backed actions; null when no platform registry exists.
	let connectorTool: PlatformRegisteredTool | null = null;
	// Hoisted to function scope alongside connectorTool so the built resolver
	// closures can be returned for callers/tests that drive them directly; null
	// until the scheduler is wired, and all fields undefined with no modelRouter.
	let resolvers: SchedulerResult["resolvers"] = null;
	try {
		if (platformMcpRegistry) {
			const connectorCtx: ConnectorToolContext = {
				registry: platformMcpRegistry,
				db: appContext.db,
				siteId: appContext.siteId,
				remotePlatformRequest: async (
					serverName: string,
					method: string,
					params: Record<string, unknown>,
				): Promise<unknown> => {
					// Pick a fresh remote host advertising this platform. See
					// `findFreshPlatformHost` for why we filter on heartbeat freshness
					// rather than just "platforms IS NOT NULL". Mirrors the identical
					// callback factory in `server.ts`.
					const targetSiteId = findFreshPlatformHost(appContext.db, serverName, appContext.siteId);
					if (!targetSiteId) {
						throw new Error(
							`No fresh remote host found for platform server '${serverName}' (no advertising peer has heart-beated within the stale threshold)`,
						);
					}

					// platform_request relay request (durable-or-legacy per toggle+capability)
					const routed = routeRelayRequest(appContext.db, {
						targetSiteId,
						sourceSiteId: appContext.siteId,
						kind: "platform_request",
						payload: JSON.stringify({
							server_name: serverName,
							method,
							params,
							timeout_ms: 15_000,
						}),
						timeoutMs: 15_000,
						// Legacy carried no key here; the minted row id is a deterministic,
						// redelivery-stable key (R-DW5/6).
						traceContext: serializeRelayTraceCarrier(injectTraceContext()) ?? undefined,
						topologyRole: resolveTopologyRole(appContext.optionalConfig),
					});
					if (routed.path === "error") throw new Error(routed.reason);
					const entry = { id: routed.id };

					// Poll for response (synchronous context — tool execute awaits result).
					// 4D-D union await: resolves whether the response arrived over the
					// legacy relay_inbox (pre-drop) or the durable spool (post-4E). The
					// shared helper consumes a durable row exactly-once via the
					// token-fenced claim → deliver → ack lifecycle.
					return await awaitPlatformRequestResponse(
						{ db: appContext.db, siteId: appContext.siteId },
						entry.id,
						{ deadline: Date.now() + 15_000, targetSiteId },
					);
				},
			};
			const rawConnectorTool = createConnectorTool(connectorCtx);
			// Adapt ConnectorToolDef (kind: "builtin") to PlatformRegisteredTool (kind: "platform") for the platform tools array
			connectorTool = {
				kind: "platform" as const,
				toolDefinition: rawConnectorTool.toolDefinition,
				execute: rawConnectorTool.execute,
				idempotent: rawConnectorTool.idempotent,
				readOnly: rawConnectorTool.readOnly,
				resolveAnnotations: rawConnectorTool.resolveAnnotations,
			};
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
			modelDefaultResolver: modelRouter ? () => modelRouter.getDefaultId() : undefined,
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
				modelDefaultResolver: resolvers.modelDefaultResolver,
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
