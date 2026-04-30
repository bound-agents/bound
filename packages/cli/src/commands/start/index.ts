/**
 * Bound orchestrator — slim composition hub that initializes all subsystems
 * in the required bootstrap order and wires them together.
 */

export { type StartArgs, ensureMcpUser } from "./bootstrap.js";
export { buildMcpToolDefinitions } from "./mcp.js";

import { ThreadExecutor, startHostHeartbeat } from "@bound/core";
import { registerSighupHandler } from "../../sighup.js";
import { createAgentLoopFactory } from "./agent-factory.js";
import { initBootstrap } from "./bootstrap.js";
import type { StartArgs } from "./bootstrap.js";
import { advertiseLocalModels, initInference, toRouterConfig } from "./inference.js";
import { initMcp, reloadMcpServers } from "./mcp.js";
import { initRelay } from "./relay.js";
import { initSandbox } from "./sandbox.js";
import { initScheduler, setupGracefulShutdown } from "./scheduler.js";
import { initServer } from "./server.js";
import { initSync } from "./sync.js";

export async function runStart(args: StartArgs): Promise<void> {
	// Phase 1: Bootstrap (config, DB, keypair, users, host, crash recovery)
	const { appContext, keypair, configDir } = await initBootstrap(args);

	// Phase 2: MCP connections and command generation
	const { mcpClientsMap, mcpCommands, mcpServerNames, confirmGates } = await initMcp(appContext);

	// Phase 3: Sandbox, command registry, VFS hydration, persona
	const { sandbox, clusterFsObj, commandContext } = await initSandbox(
		appContext,
		mcpClientsMap,
		mcpCommands,
		mcpServerNames,
		configDir,
	);

	// Phase 4: Model router and inference setup
	const { modelRouter, routerConfig } = await initInference(appContext, commandContext);

	// Phase 5: Relay processor, KeyManager
	const { relayProcessor, relayProcessorHandle, relayExecutor, keyManager, hubSiteId, keyring } =
		await initRelay(appContext, keypair, mcpClientsMap, modelRouter, clusterFsObj);

	// Initialize wsClient reference for SIGHUP callback
	let wsClient: {
		close: () => void;
		updateReconnectConfig: (max?: number) => void;
		updateBackpressureLimit: (limit?: number) => void;
		updateBackfillInterval: (seconds?: number) => void;
	} | null = null;

	// Phase 6: Agent loop factory
	if (!modelRouter) {
		appContext.logger.warn("[agent] No model router — agent loops will not be available");
	}
	const agentLoopFactory = modelRouter
		? createAgentLoopFactory(appContext, modelRouter, sandbox, clusterFsObj)
		: null;

	// Phase 7: Web server, message handler, platform connectors
	const serverResult =
		agentLoopFactory && modelRouter
			? await initServer({
					appContext,
					modelRouter,
					routerConfig,
					agentLoopFactory,
					relayExecutor,
					keyManager,
					keyring,
					hubSiteId,
					relayProcessor,
				})
			: {
					webServer: null,
					syncServer: null,
					statusForwardCache: new Map(),
					activeDelegations: new Map(),
					threadExecutor: new ThreadExecutor(appContext.db, appContext.logger),
					platformRegistry: null,
					wsTransportHolder: {
						addPeer: () => {},
						removePeer: () => {},
						handleChangelogPush: () => {},
						handleChangelogAck: () => {},
						drainChangelog: () => {},
						handleRelaySend: () => {},
						handleRelayAck: () => {},
						drainRelayInbox: () => {},
						seedNewPeer: () => {},
						handleSnapshotAck: () => {},
						continueSnapshotSeed: () => {},
						applySnapshotChunk: () => 0,
						handleReseedRequest: () => {},
					},
				};

	// Phase 5b: Register SIGHUP handler for config hot-reload (after sync init for wsClient reference)
	registerSighupHandler({
		appContext,
		configDir,
		keyManager,
		logger: appContext.logger,
		onMcpConfigChanged: async (oldConfig, newConfig) => {
			await reloadMcpServers({
				appContext,
				mcpClientsMap,
				mcpServerNames,
				confirmGates,
				sandbox,
				commandContext: commandContext ?? {
					db: appContext.db,
					siteId: appContext.siteId,
					eventBus: appContext.eventBus,
					logger: appContext.logger,
					mcpClients: mcpClientsMap,
				},
				oldConfig,
				newConfig,
			});
		},
		onModelBackendsChanged: async (_oldConfig, newConfig) => {
			if (!modelRouter) {
				appContext.logger.warn(
					"[sighup] model_backends.json changed but no router is registered — restart to apply",
				);
				return;
			}
			try {
				modelRouter.reload(toRouterConfig(newConfig));
				advertiseLocalModels(appContext, modelRouter, newConfig);
				appContext.logger.info("[sighup] Model router reloaded", {
					backends: modelRouter.listBackends().map((b) => b.id),
					default: modelRouter.getDefaultId(),
				});
			} catch (err) {
				appContext.logger.error(
					"[sighup] Failed to reload model router — keeping previous backends",
					{ error: err instanceof Error ? err.message : String(err) },
				);
			}
		},
		onWsConfigChanged: async (newWsConfig) => {
			// Update WS client config. Changes take effect on next reconnection/connection.
			// - reconnect_max_interval: takes effect on next reconnection
			// - backpressure_limit: takes effect on next send
			// - idle_timeout: server-side, takes effect on next connection
			if (newWsConfig && wsClient) {
				appContext.logger.info("[sighup] Applying WS config changes", {
					reconnect_max_interval: newWsConfig.reconnect_max_interval,
					backpressure_limit: newWsConfig.backpressure_limit,
					backfill_interval: newWsConfig.backfill_interval,
					idle_timeout: newWsConfig.idle_timeout,
				});
				wsClient.updateReconnectConfig(newWsConfig.reconnect_max_interval);
				wsClient.updateBackpressureLimit(newWsConfig.backpressure_limit);
				wsClient.updateBackfillInterval(newWsConfig.backfill_interval);
			}
		},
	});

	// Phase 8: Sync loop, pruning, overlay scanner
	const syncResult = await initSync(appContext, keypair, keyManager, args.reseed);
	wsClient = syncResult.wsClient;
	const { pruningHandle, overlayHandle, wsTransport } = syncResult;

	// Wire WsTransport into the sync server's deferred holder (for hub-side frame dispatch)
	if (wsTransport && serverResult.wsTransportHolder) {
		Object.assign(serverResult.wsTransportHolder, {
			addPeer: wsTransport.addPeer.bind(wsTransport),
			removePeer: wsTransport.removePeer.bind(wsTransport),
			handleChangelogPush: wsTransport.handleChangelogPush.bind(wsTransport),
			handleChangelogAck: wsTransport.handleChangelogAck.bind(wsTransport),
			drainChangelog: wsTransport.drainChangelog.bind(wsTransport),
			handleRelaySend: wsTransport.handleRelaySend.bind(wsTransport),
			handleRelayAck: wsTransport.handleRelayAck.bind(wsTransport),
			drainRelayInbox: wsTransport.drainRelayInbox.bind(wsTransport),
			seedNewPeer: wsTransport.seedNewPeer.bind(wsTransport),
			handleSnapshotAck: wsTransport.handleSnapshotAck.bind(wsTransport),
			continueSnapshotSeed: wsTransport.continueSnapshotSeed.bind(wsTransport),
			applySnapshotChunk: wsTransport.applySnapshotChunk.bind(wsTransport),
			handleReseedRequest: wsTransport.handleReseedRequest.bind(wsTransport),
			handleConsistencyRequest: wsTransport.handleConsistencyRequest.bind(wsTransport),
			requestConsistency: wsTransport.requestConsistency.bind(wsTransport),
			handleRowPullRequest: wsTransport.handleRowPullRequest.bind(wsTransport),
			handleRowPullAck: wsTransport.handleRowPullAck.bind(wsTransport),
			continueRowPull: wsTransport.continueRowPull.bind(wsTransport),
			continueConsistencyStream: wsTransport.continueConsistencyStream.bind(wsTransport),
		});
	}

	// Phase 9: Host heartbeat, cron seeding, scheduler
	const heartbeatHandle = startHostHeartbeat(appContext.db, appContext.siteId, {
		logger: appContext.logger,
	});
	const { schedulerHandle } = agentLoopFactory
		? initScheduler(appContext, agentLoopFactory, modelRouter, sandbox)
		: { schedulerHandle: null };

	const webPort = process.env.WEB_PORT || "3001";
	appContext.logger.info(`
Bound is running!
Operator: ${appContext.config.allowlist.default_web_user}

Open http://localhost:${webPort} in your browser to start chatting.

Press Ctrl+C to stop.
`);

	// Keep process alive until shutdown signal
	await setupGracefulShutdown(appContext, {
		heartbeatHandle,
		schedulerHandle,
		pruningHandle,
		overlayHandle,
		relayProcessorHandle,
		platformRegistry: serverResult.platformRegistry,
		mcpClientsMap,
		webServer: serverResult.webServer,
		syncServer: serverResult.syncServer,
		wsClient,
		wsTransport,
	});
}
