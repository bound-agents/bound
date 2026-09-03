/**
 * Bound orchestrator — slim composition hub that initializes all subsystems
 * in the required bootstrap order and wires them together.
 */

export type { StartArgs } from "./bootstrap.js";
export { buildMcpToolDefinitions } from "./mcp.js";

import { HandleMessageTracker } from "@bound/agent";
import { ThreadExecutor, startHostHeartbeat } from "@bound/core";
import { markAwsCredentialCacheStale } from "@bound/llm";
import { registerSighupHandler } from "../../sighup.js";
import { createAgentLoopFactory } from "./agent-factory.js";
import { initBootstrap } from "./bootstrap.js";
import type { StartArgs } from "./bootstrap.js";
import {
	advertiseLocalModels,
	initInference,
	toRouterConfig,
	wireBackendReadiness,
} from "./inference.js";
import { initMcp, reloadMcpServers } from "./mcp.js";
import { initRelay } from "./relay.js";
import { initSandbox } from "./sandbox.js";
import { initScheduler, setupGracefulShutdown } from "./scheduler.js";
import { initServer } from "./server.js";
import { initSync } from "./sync.js";
import { initTelemetry, setTelemetrySiteId } from "./telemetry.js";
import { createWsTransportHolderStubs, wireWsTransportHolder } from "./wire-ws-transport-holder.js";

export async function runStart(args: StartArgs): Promise<void> {
	// Phase 0: Telemetry (must be first so all subsequent operations are traced)
	initTelemetry("bound");

	// Phase 1: Bootstrap (config, DB, keypair, users, host, crash recovery)
	const { appContext, keypair, configDir } = await initBootstrap(args);

	// Now that bootstrap has derived the site ID from the host keypair, stamp it
	// onto every subsequently-traced span (issue #152). initTelemetry ran at Phase 0
	// before the site ID existed, so its span processor started empty.
	setTelemetrySiteId(appContext.siteId);

	// Phase 2: MCP connections and command generation
	const { mcpClientsMap, mcpCommands, mcpServerNames, confirmGates } = await initMcp(appContext);

	// Phase 3: Sandbox, command registry, VFS hydration
	const { sandbox, clusterFsObj, commandContext } = await initSandbox(
		appContext,
		mcpClientsMap,
		mcpCommands,
		mcpServerNames,
	);

	// Phase 4: Model router and inference setup
	const { modelRouter } = await initInference(appContext, commandContext);

	// Phase 5: Relay processor, KeyManager
	const { relayProcessor, relayProcessorHandle, keyManager, hubSiteId, keyring } = await initRelay(
		appContext,
		keypair,
		mcpClientsMap,
		modelRouter,
		clusterFsObj,
		confirmGates,
	);

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
					agentLoopFactory,
					keyManager,
					keyring,
					hubSiteId,
					clusterFsObj,
					relayProcessor,
				})
			: {
					webServer: null,
					syncServer: null,
					statusForwardCache: new Map(),
					threadExecutor: new ThreadExecutor(appContext.db, appContext.logger),
					platformMcpRegistry: null,
					handleMessageTracker: new HandleMessageTracker({ watchdogIntervalMs: 0 }),
					// Single-host fallback (no model router / no sync): the holder is never
					// wired — initSync returns wsTransport: undefined by design — so these
					// stubs are live forever. Benign mode keeps the pre-#253 semantics
					// (log-once-at-debug, neutral return) so reachable single-host paths
					// like POST /consistency stay working instead of 500ing on a throw.
					wsTransportHolder: createWsTransportHolderStubs(appContext.logger, { unwired: "benign" }),
				};

	// Phase 5b: Register SIGHUP handler for config hot-reload (after sync init for wsClient reference)
	registerSighupHandler({
		appContext,
		configDir,
		keyManager,
		logger: appContext.logger,
		// Bust the AWS shared-config credential cache once per reload so an
		// edited ~/.aws profile (or a newly-added one) is picked up on SIGHUP
		// instead of staying invisible until a full process restart.
		onReloadStart: () => markAwsCredentialCacheStale(),
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
					"[sighup] model backends config changed but no router is registered — restart to apply",
				);
				return;
			}

			// loadModelBackendsConfig() has already evaluated, schema-validated,
			// sample-validated, and atomically published the candidate pricing
			// callbacks. Schema rows no longer contain those functions, so compiling
			// oldConfig here would clear the live registry rather than restore it.
			modelRouter.reload(toRouterConfig(newConfig));
			advertiseLocalModels(appContext, modelRouter, newConfig);
			appContext.config.modelBackends = newConfig;
			wireBackendReadiness(appContext, modelRouter);
			appContext.logger.info("[sighup] Model router reloaded", {
				backends: modelRouter.listBackends().map((b) => b.id),
				default: modelRouter.getDefaultId(),
			});
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

	// Phase 8: Sync loop, pruning
	const syncResult = await initSync(appContext, keypair, keyManager, args.reseed);
	wsClient = syncResult.wsClient;
	const { pruningHandle, wsTransport } = syncResult;

	// Wire WsTransport into the sync server's deferred holder (for hub-side frame
	// dispatch). `wireWsTransportHolder` copies the real instance's methods on and
	// asserts every required method was wired — a hub that can't receive a
	// spool/changelog/relay/snapshot frame throws at startup rather than silently
	// booting half-wired (the #253 spool wedge, where the copy list had drifted).
	if (wsTransport && serverResult.wsTransportHolder) {
		wireWsTransportHolder(serverResult.wsTransportHolder, wsTransport);
	}

	// Phase 9: Host heartbeat, cron seeding, scheduler
	const heartbeatHandle = startHostHeartbeat(appContext.db, appContext.siteId, {
		logger: appContext.logger,
	});
	const { schedulerHandle } = agentLoopFactory
		? initScheduler(
				appContext,
				agentLoopFactory,
				modelRouter,
				sandbox,
				serverResult.platformMcpRegistry,
			)
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
		relayProcessorHandle,
		mcpClientsMap,
		webServer: serverResult.webServer,
		syncServer: serverResult.syncServer,
		wsClient,
		wsTransport,
		handleMessageTracker: serverResult.handleMessageTracker,
	});
}
