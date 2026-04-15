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
import type { AppContext } from "@bound/core";
import type { ModelRouter } from "@bound/llm";
import type { CronSchedulesConfig } from "@bound/shared";
import { formatError } from "@bound/shared";

export type AgentLoopFactory = (config: AgentLoopConfig) => AgentLoop;

export interface SchedulerResult {
	schedulerHandle: { stop: () => void } | null;
}

export interface ShutdownHandles {
	heartbeatHandle: { stop: () => void } | null;
	schedulerHandle: { stop: () => void } | null;
	syncLoopHandle: { stop: () => void } | null;
	pruningHandle: { stop: () => void } | null;
	overlayHandle: { stop: () => void } | null;
	relayProcessorHandle: { stop: () => void } | null;
	platformRegistry: { start(): void; stop(): void } | null;
	mcpClientsMap: Map<string, MCPClient>;
	webServer: { stop(): Promise<void> } | null;
	syncServer: { stop(): Promise<void> } | null;
	wsClient: { close: () => void } | null;
}

export function initScheduler(
	appContext: AppContext,
	agentLoopFactory: AgentLoopFactory,
	modelRouter: ModelRouter | null,
	// biome-ignore lint/suspicious/noExplicitAny: sandbox type is opaque from @bound/sandbox createSandbox
	sandbox: any,
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
								return { ok: false as const, error: resolution.error };
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
			},
			sandbox?.bash,
		);
		schedulerHandle = scheduler.start(30_000);
		appContext.logger.info("[scheduler] Scheduler started (30s poll interval)");
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
			if (handles.syncLoopHandle) handles.syncLoopHandle.stop();
			if (handles.pruningHandle) handles.pruningHandle.stop();
			if (handles.overlayHandle) handles.overlayHandle.stop();
			if (handles.relayProcessorHandle) handles.relayProcessorHandle.stop();
			if (handles.wsClient) handles.wsClient.close();
			if (handles.platformRegistry) {
				try {
					handles.platformRegistry.stop();
				} catch (err) {
					appContext.logger.error("[platforms] Error stopping platform registry", {
						error: err,
					});
				}
			}
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
			resolve();
		};

		process.on("SIGINT", () => shutdown("SIGINT"));
		process.on("SIGTERM", () => shutdown("SIGTERM"));
	});
}
