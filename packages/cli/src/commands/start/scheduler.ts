/**
 * Scheduler subsystem: cron task seeding, heartbeat seeding, scheduler start,
 * and graceful shutdown handlers.
 */

import {
	Scheduler,
	generateThreadTitle,
	resolveModel,
	resolveModelTier,
	seedCronTasks,
	seedHeartbeat,
} from "@bound/agent";
import type { AgentLoop, AgentLoopConfig } from "@bound/agent";
import type { MCPClient } from "@bound/agent";
import { createRelayOutboxEntry } from "@bound/agent";
import {
	type AppContext,
	findFreshPlatformHost,
	markProcessed,
	readInboxByRefId,
	writeOutbox,
} from "@bound/core";
import type { ModelRouter } from "@bound/llm";
import {
	type ConnectorToolContext,
	type PlatformMcpRegistry,
	type PlatformRegisteredTool,
	createConnectorTool,
	registerConnectorEventDelivery,
} from "@bound/platforms";
import type { CronSchedulesConfig } from "@bound/shared";
import { formatError, parseJsonSafe, resultPayloadSchema } from "@bound/shared";
import { shutdownTelemetry } from "./telemetry.js";

export type AgentLoopFactory = (config: AgentLoopConfig) => AgentLoop;

export interface SchedulerResult {
	schedulerHandle: { stop: () => void } | null;
}

export interface ShutdownHandles {
	heartbeatHandle: { stop: () => void } | null;
	schedulerHandle: { stop: () => void } | null;
	pruningHandle: { stop: () => void } | null;
	overlayHandle: { stop: () => void } | null;
	relayProcessorHandle: { stop: () => void } | null;
	mcpClientsMap: Map<string, MCPClient>;
	webServer: { stop(): Promise<void> } | null;
	syncServer: { stop(): Promise<void> } | null;
	wsClient: { close: () => void } | null;
	wsTransport: { start(): void; stop(): void } | undefined;
	/**
	 * Cross-handler-invocation span tracker. Stopped and flushed before
	 * `shutdownTelemetry` so any open `agent.handle-message` and
	 * `tool.dispatch` spans get exported in the OTLP final flush.
	 */
	handleMessageTracker: {
		stopWatchdog(): void;
		endAllOpenSpans(reason?: string): void;
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
	// 16. Seed cron tasks from config
	appContext.logger.info("Seeding cron tasks...");
	{
		const cronResult = appContext.optionalConfig.cronSchedules;
		if (cronResult?.ok) {
			const cronSchedules = cronResult.value as Record<
				string,
				{ schedule: string; payload?: string }
			>;
			const cronConfigs = Object.entries(cronSchedules)
				.filter(([name]) => name !== "heartbeat")
				.map(([name, cfg]) => ({
					name,
					cron: cfg.schedule,
					payload: cfg.payload,
				}));
			try {
				seedCronTasks(appContext.db, cronConfigs, appContext.siteId);
				appContext.logger.info(`[scheduler] Seeded ${cronConfigs.length} cron task(s)`);
			} catch (error) {
				appContext.logger.warn("[scheduler] Failed to seed cron tasks", {
					error: formatError(error),
				});
			}
		} else {
			appContext.logger.info("[scheduler] No cron schedules configured");
		}
	}

	// 16b. Seed heartbeat task
	{
		const cronResult = appContext.optionalConfig.cronSchedules;
		const parsed = cronResult?.ok ? (cronResult.value as CronSchedulesConfig) : undefined;
		const heartbeatConfig = parsed?.heartbeat;
		try {
			seedHeartbeat(appContext.db, heartbeatConfig, appContext.siteId);
			appContext.logger.info("[scheduler] Heartbeat task seeded");
		} catch (error) {
			appContext.logger.warn("[scheduler] Failed to seed heartbeat", {
				error: formatError(error),
			});
		}
	}

	// 17. Scheduler
	appContext.logger.info("Starting scheduler...");
	let schedulerHandle: { stop: () => void } | null = null;
	try {
		// Create unified connector tool (replaces 4 dispatcher-specific tools)
		let connectorTool: PlatformRegisteredTool | null = null;
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

					// Write platform_request relay outbox entry
					const entry = createRelayOutboxEntry(
						targetSiteId,
						appContext.siteId,
						"platform_request",
						JSON.stringify({
							server_name: serverName,
							method,
							params,
							timeout_ms: 15_000,
						}),
						15_000,
					);
					writeOutbox(appContext.db, entry, undefined, appContext.eventBus);

					// Poll for response (synchronous context — tool execute awaits result)
					const deadline = Date.now() + 15_000;
					while (Date.now() < deadline) {
						const response = readInboxByRefId(appContext.db, entry.id);
						if (response) {
							markProcessed(appContext.db, [response.id]);
							if (response.kind === "error") {
								const errPayload = JSON.parse(response.payload) as { error?: string };
								throw new Error(errPayload.error ?? response.payload);
							}
							const parsed = parseJsonSafe(
								resultPayloadSchema,
								response.payload,
								"platform_request result",
							);
							if (!parsed.ok) {
								throw new Error(`Invalid platform_request response: ${parsed.error}`);
							}
							return JSON.parse(parsed.value.stdout);
						}
						await new Promise((r) => setTimeout(r, 200));
					}
					throw new Error(`Timeout waiting for platform_request response from ${targetSiteId}`);
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

		const scheduler = new Scheduler(
			appContext,
			agentLoopFactory,
			{
				modelValidator: modelRouter
					? (modelId: string) => {
							const resolution = resolveModel(
								modelId,
								modelRouter,
								appContext.db,
								appContext.siteId,
							);
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
				modelTierResolver: modelRouter
					? (modelId: string) =>
							resolveModelTier(modelId, modelRouter, appContext.db, appContext.siteId)
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
					? (threadId: string) => {
							// Event task threads: scoped to their bound server's full tool set
							const scopedTools = platformMcpRegistry.getToolsForThread(threadId);
							if (scopedTools.size > 0) {
								return Array.from(scopedTools.values());
							}
							// All other threads: read-only platform tools + connector tool
							const readOnlyTools = Array.from(
								platformMcpRegistry.getReadOnlyPlatformTools().values(),
							);
							if (connectorTool) {
								return [...readOnlyTools, connectorTool];
							}
							return readOnlyTools;
						}
					: undefined,
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

	return { schedulerHandle };
}

/**
 * Register graceful shutdown handlers for SIGINT and SIGTERM.
 * Returns a Promise that resolves when a shutdown signal is received.
 */
export function setupGracefulShutdown(
	appContext: AppContext,
	handles: ShutdownHandles,
): Promise<void> {
	return new Promise<void>((resolve) => {
		const shutdown = async (signal: string) => {
			appContext.logger.info(
				`\n${signal === "SIGINT" ? "Shutting down gracefully" : "Terminating"}...`,
			);
			if (handles.heartbeatHandle) handles.heartbeatHandle.stop();
			if (handles.schedulerHandle) handles.schedulerHandle.stop();
			if (handles.pruningHandle) handles.pruningHandle.stop();
			if (handles.overlayHandle) handles.overlayHandle.stop();
			if (handles.relayProcessorHandle) handles.relayProcessorHandle.stop();
			if (handles.wsTransport) {
				handles.wsTransport.stop();
				const { setChangelogEventBus } = await import("@bound/core");
				setChangelogEventBus(null);
			}
			if (handles.wsClient) handles.wsClient.close();
			// Disconnect MCP clients
			for (const [, client] of handles.mcpClientsMap) {
				try {
					await client.disconnect();
				} catch (_err) {
					// Ignore disconnect errors during shutdown
				}
			}
			if (handles.webServer) await handles.webServer.stop();
			if (handles.syncServer) await handles.syncServer.stop();
			// Stop the watchdog and end any still-open turn / dispatch spans
			// so BatchSpanProcessor exports them on final flush. Ordering
			// matters: this must run BEFORE shutdownTelemetry.
			if (handles.handleMessageTracker) {
				handles.handleMessageTracker.stopWatchdog();
				handles.handleMessageTracker.endAllOpenSpans("shutdown");
			}
			await shutdownTelemetry();
			resolve();
		};

		process.on("SIGINT", () => shutdown("SIGINT"));
		process.on("SIGTERM", () => shutdown("SIGTERM"));
	});
}
