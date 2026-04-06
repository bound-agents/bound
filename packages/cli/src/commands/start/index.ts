/**
 * Bound orchestrator — slim composition hub that initializes all subsystems
 * in the required bootstrap order and wires them together.
 */

export { type StartArgs, ensureMcpUser } from "./bootstrap.js";
export { buildMcpToolDefinitions } from "./mcp.js";

import { createAgentLoopFactory } from "./agent-factory.js";
import { initBootstrap } from "./bootstrap.js";
import type { StartArgs } from "./bootstrap.js";
import { ThreadExecutor } from "@bound/core";
import { initInference } from "./inference.js";
import { initMcp } from "./mcp.js";
import { initRelay } from "./relay.js";
import { initSandbox } from "./sandbox.js";
import { initScheduler, setupGracefulShutdown } from "./scheduler.js";
import { initServer } from "./server.js";
import { initSync } from "./sync.js";

export async function runStart(args: StartArgs): Promise<void> {
	// Phase 1: Bootstrap (config, DB, keypair, users, host, crash recovery)
	const { appContext, keypair, configDir } = await initBootstrap(args);

	// Phase 2: MCP connections and command generation
	const { mcpClientsMap, mcpCommands, mcpServerNames } = await initMcp(appContext);

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

	// Phase 5: Relay processor, KeyManager, reachability
	const {
		relayProcessor,
		relayProcessorHandle,
		relayExecutor,
		reachabilityTracker,
		keyManager,
		hubSiteId,
		keyring,
	} = await initRelay(appContext, keypair, mcpClientsMap, modelRouter, clusterFsObj, configDir);

	// Phase 6: Agent loop factory
	if (!modelRouter) {
		appContext.logger.warn("[agent] No model router — agent loops will not be available");
	}
	const agentLoopFactory = modelRouter
		? createAgentLoopFactory(appContext, modelRouter, sandbox, clusterFsObj)
		: null;

	// Phase 7: Web server, message handler, platform connectors
	// Transport ref is lazily resolved — sync phase initializes it after the server.
	// biome-ignore lint/style/useConst: intentionally mutable — set after server init, read lazily by getTransport
	let transportRef: import("@bound/sync").SyncTransport | undefined;

	const serverResult =
		agentLoopFactory && modelRouter
			? await initServer({
					appContext,
					keypair,
					modelRouter,
					routerConfig,
					agentLoopFactory,
					relayExecutor,
					reachabilityTracker,
					keyManager,
					keyring,
					hubSiteId,
					getTransport: () => transportRef,
					relayProcessor,
				})
			: {
					webServer: null,
					statusForwardCache: new Map(),
					activeDelegations: new Map(),
					threadExecutor: new ThreadExecutor(appContext.db, appContext.logger),
					platformRegistry: null,
				};

	// Phase 8: Sync loop, pruning, overlay scanner
	const { syncLoopHandle, pruningHandle, overlayHandle, transport } = await initSync(
		appContext,
		keypair,
		keyManager,
	);
	// Back-patch the transport reference for eager push
	transportRef = transport;

	// Phase 9: Cron seeding, heartbeat, scheduler
	const { schedulerHandle } = agentLoopFactory
		? initScheduler(appContext, agentLoopFactory, modelRouter, sandbox)
		: { schedulerHandle: null };

	appContext.logger.info(`
Bound is running!
Operator: ${appContext.config.allowlist.default_web_user}

Open http://localhost:3000 in your browser to start chatting.

Press Ctrl+C to stop.
`);

	// Keep process alive until shutdown signal
	await setupGracefulShutdown(appContext, {
		schedulerHandle,
		syncLoopHandle,
		pruningHandle,
		overlayHandle,
		relayProcessorHandle,
		platformRegistry: serverResult.platformRegistry,
		mcpClientsMap,
		webServer: serverResult.webServer,
	});
}
