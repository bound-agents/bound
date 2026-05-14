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
import { type AppContext, markProcessed, readInboxByRefId, writeOutbox } from "@bound/core";
import type { ModelRouter } from "@bound/llm";
import {
	type PlatformMcpRegistry,
	type PlatformRegisteredTool,
	createConnectorAttachTool,
	createConnectorChannelsTool,
	createConnectorDetachTool,
	createConnectorListTool,
	registerConnectorEventListeners,
} from "@bound/platforms";
import type { CronSchedulesConfig } from "@bound/shared";
import { formatError, parseJsonSafe, resultPayloadSchema } from "@bound/shared";

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
		// Create dispatcher-specific tools (connector_list, connector_channels, connector_attach).
		// These are only given to the dispatcher task, which manages connector handle setup.
		let dispatcherTools: PlatformRegisteredTool[] = [];
		if (platformMcpRegistry) {
			const dispatcherCtx = {
				registry: platformMcpRegistry,
				db: appContext.db,
				siteId: appContext.siteId,
				remotePlatformRequest: async (
					serverName: string,
					method: string,
					params: Record<string, unknown>,
				): Promise<unknown> => {
					// Find which remote host owns this platform server
					const rows = appContext.db
						.query(
							"SELECT site_id, platforms FROM hosts WHERE deleted = 0 AND platforms IS NOT NULL AND site_id != ?",
						)
						.all(appContext.siteId) as Array<{ site_id: string; platforms: string }>;
					let targetSiteId: string | null = null;
					for (const row of rows) {
						try {
							const platforms = JSON.parse(row.platforms) as string[];
							if (Array.isArray(platforms) && platforms.includes(serverName)) {
								targetSiteId = row.site_id;
								break;
							}
						} catch {
							// Skip hosts with corrupted platforms JSON
						}
					}
					if (!targetSiteId) {
						throw new Error(`No remote host found for platform server '${serverName}'`);
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
			const rawTools = [
				createConnectorListTool(dispatcherCtx),
				createConnectorChannelsTool(dispatcherCtx),
				createConnectorAttachTool(dispatcherCtx),
				createConnectorDetachTool(dispatcherCtx),
			];
			// Adapt DispatcherTool (kind: "builtin") to PlatformRegisteredTool (kind: "platform")
			dispatcherTools = rawTools.map((t) => ({
				kind: "platform" as const,
				toolDefinition: t.toolDefinition,
				execute: t.execute,
			}));
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
				platformToolResolver: platformMcpRegistry
					? (threadId: string) => {
							// Dispatcher task receives ALL platform tools + dispatcher-specific tools
							if (platformMcpRegistry.isDispatcherThread(threadId)) {
								const allPlatformTools = Array.from(
									platformMcpRegistry.getAllPlatformTools().values(),
								);
								return [...allPlatformTools, ...dispatcherTools];
							}
							const tools = platformMcpRegistry.getToolsForThread(threadId);
							return Array.from(tools.values());
						}
					: undefined,
			},
			sandbox?.bash,
		);
		schedulerHandle = scheduler.start(30_000);
		appContext.logger.info("[scheduler] Scheduler started (30s poll interval)");

		// Wire connector event listeners to scheduler for task wakeups (AC7.1)
		registerConnectorEventListeners(appContext.eventBus, scheduler);
		appContext.logger.info("[scheduler] Connector event listeners registered");

		// Emit synthetic list_changed to wake the dispatcher task. Platform servers
		// register during Phase 7 (before the scheduler exists), so the real
		// connector:list_changed event is lost. This kick ensures the dispatcher
		// runs at least once after startup.
		if (platformMcpRegistry) {
			appContext.eventBus.emit("connector:list_changed", { server_name: "__startup" });
		}
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
			resolve();
		};

		process.on("SIGINT", () => shutdown("SIGINT"));
		process.on("SIGTERM", () => shutdown("SIGTERM"));
	});
}
