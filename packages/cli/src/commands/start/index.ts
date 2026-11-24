/**
 * Bound orchestrator — slim composition hub that initializes all subsystems
 * in the required bootstrap order and wires them together.
 */

export type { StartArgs } from "./bootstrap.js";
export { buildMcpToolDefinitions } from "./mcp.js";

import { HandleMessageTracker } from "@bound/agent";
import { ThreadExecutor, listModelAliases, startHostHeartbeat } from "@bound/core";
import type { AppContext } from "@bound/core";
import { markAwsCredentialCacheStale } from "@bound/llm";
import { registerSighupHandler } from "../../sighup.js";
import { createAgentLoopFactory } from "./agent-factory.js";
import { initBootstrap } from "./bootstrap.js";
import type { StartArgs } from "./bootstrap.js";
import {
	initInference,
	resolveGateApplyAdvertise,
	settleExpandedBackendPasses,
	toRouterConfig,
	wireBackendReadiness,
} from "./inference.js";
import { createMcpOAuthWiring } from "./mcp-oauth-wiring.js";
import { initMcp, reconnectResolvedMcpServer, reloadMcpServers } from "./mcp.js";
import { initRelay } from "./relay.js";
import { initSandbox } from "./sandbox.js";
import { initScheduler } from "./scheduler.js";
import { initServer } from "./server.js";
import { initSync } from "./sync.js";
import { initTelemetry, setTelemetrySiteId, shutdownTelemetry } from "./telemetry.js";
import { createWsTransportHolderStubs, wireWsTransportHolder } from "./wire-ws-transport-holder.js";

/**
 * Explicit network binding options for an in-process boot. Each defaults to the
 * production environment-variable behavior (`PORT`/`WEB_PORT`/`BIND_HOST`/
 * `WEB_BIND_HOST`) so `runStart` is byte-for-byte unchanged, while a test can
 * pass `syncPort: 0` / `webPort: 0` to request OS-assigned ephemeral ports and
 * read the real bound ports back from `NodeHandle`.
 */
export interface StartNodeOptions {
	/** Sync-server port. Defaults to `process.env.PORT` or 3000. Pass 0 for ephemeral. */
	syncPort?: number;
	/** Web-server port. Defaults to `process.env.WEB_PORT` or 3001. Pass 0 for ephemeral. */
	webPort?: number;
	/** Sync-server bind host. Defaults to `process.env.BIND_HOST` or "localhost". */
	syncHost?: string;
	/** Web-server bind host. Defaults to `process.env.WEB_BIND_HOST` or "localhost". */
	webHost?: string;
	/**
	 * When true, register `process.on` SIGINT/SIGTERM/exit signal + PID-lockfile
	 * handlers (the production `runStart` path). Default false: `startNode`
	 * returns a live `NodeHandle` with no process-level listeners, so a test can
	 * boot and `stop()` repeatedly in one process.
	 */
	installSignalHandlers?: boolean;
}

/**
 * A running Bound node. `startNode` resolves this once every subsystem is wired
 * and both servers are listening; `stop()` tears the whole node down (servers,
 * scheduler, heartbeat, pruning, relay processor, sync/ws transport, MCP
 * clients, span tracker, telemetry, PID lockfile) so the host process can exit
 * cleanly with no dangling timers, sockets, or listeners.
 */
export interface NodeHandle {
	appContext: AppContext;
	/** Real listening port of the web server (OS-assigned when `webPort: 0`), or null if no web server booted. */
	webPort: number | null;
	/** Real listening port of the sync server (OS-assigned when `syncPort: 0`), or null if no sync server booted. */
	syncPort: number | null;
	/** Base URL for the web server (`http://<webHost>:<webPort>`), or null if no web server booted. */
	webUrl: string | null;
	stop(): Promise<void>;
	/**
	 * Test-only seams. Undefined in production shape consumers never read it;
	 * `startNode` populates it so in-process boot tests can drive the live MCP
	 * client map (teardown disconnect loop) and the late-bound MCP OAuth
	 * resolve-reconnect wrapper without reaching into module internals.
	 */
	__test?: {
		mcpClients: Map<string, { disconnect(): Promise<void> }>;
		reloadMcpForReconnect(serverName: string): Promise<void>;
	};
}

/**
 * Boot every Bound subsystem in dependency order and return a live
 * {@link NodeHandle}. This is the whole body of what `bound start` does MINUS
 * the process-lifetime signal plumbing: no `process.exit`, no `process.on`
 * signal/exit registration (unless `installSignalHandlers` is set), and nothing
 * that would stop a second node booting in the same process. `runStart` is a
 * thin wrapper that boots with signal handlers and blocks until a shutdown
 * signal fires.
 */
export async function startNode(
	args: StartArgs,
	options: StartNodeOptions = {},
): Promise<NodeHandle> {
	const installSignalHandlers = options.installSignalHandlers ?? false;

	// Phase 0: Telemetry (must be first so all subsequent operations are traced)
	initTelemetry("bound");

	// Phase 1: Bootstrap (config, DB, keypair, users, host, crash recovery)
	const { appContext, keypair, configDir, removePidFile } = await initBootstrap(args, {
		installSignalHandlers,
	});

	// Now that bootstrap has derived the site ID from the host keypair, stamp it
	// onto every subsequently-traced span (issue #152). initTelemetry ran at Phase 0
	// before the site ID existed, so its span processor started empty.
	setTelemetrySiteId(appContext.siteId);

	// Phase 2: MCP connections and command generation. MCP OAuth wiring (slice
	// 3.5) is constructed first so oauth-configured servers get their provider
	// (R-MO2) at connect time; a `reconnect` deferral lets the owner-exchange
	// consumer re-run connect after a resolved grant (R-MO13b) once the client
	// map exists. Null when no http server declares an `auth` block.
	let reloadMcpForReconnect: ((serverName: string) => Promise<void>) | null = null;
	const mcpOAuth = createMcpOAuthWiring(appContext, configDir, (serverName) =>
		reloadMcpForReconnect?.(serverName),
	);
	const { mcpClientsMap, mcpCommands, mcpServerNames, confirmGates } = await initMcp(
		appContext,
		mcpOAuth
			? (server) => ({ ...server, authProvider: mcpOAuth.providerFor(server) ?? undefined })
			: undefined,
	);
	// A resolved grant re-runs connect for the one server so the next call rides an
	// authenticated session, then refreshes the capability surface in place so the
	// web UI Connections view, the sandbox MCP commands, and hosts.mcp_capabilities
	// pick up the server's tools without a daemon restart (R-MO13b + §7). Defined
	// after Phase 3 so `sandbox` + `commandContext` are in scope; the callback is
	// late-bound through the mutable `let` and only fires at resolution time (the
	// relay-processor wires the handoff consumer in Phase 5, after this is set).

	// Phase 3: Sandbox, command registry, VFS hydration
	const { sandbox, clusterFsObj, commandContext } = await initSandbox(
		appContext,
		mcpClientsMap,
		mcpCommands,
		mcpServerNames,
	);
	reloadMcpForReconnect = (serverName: string): Promise<void> =>
		reconnectResolvedMcpServer({
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
			serverName,
		});

	// Phase 4: Model router and inference setup
	const { modelRouter, modelsDevRefresh, modelsDevCache } = await initInference(
		appContext,
		commandContext,
	);

	// Phase 5: Relay processor, KeyManager
	const { relayProcessor, relayProcessorHandle, keyManager, hubSiteId, keyring } = await initRelay(
		appContext,
		keypair,
		mcpClientsMap,
		modelRouter,
		clusterFsObj,
		confirmGates,
	);

	// MCP OAuth (slice 3.5): wire the owner-exchange handoff consumer so incoming
	// mcp_auth_handoff durable_work rows are consumed (R-MO19/R-MO20) — both
	// self-owned (LOCAL_WORK_TARGET) and peer-transferred. Without this the
	// relay-processor logs "no MCP OAuth owner-exchange consumer wired" and cannot
	// exchange the code for a token.
	if (mcpOAuth) {
		relayProcessor.setMcpAuthHandoffConsumer(mcpOAuth.consumeHandoffPayload);
		// LEG B (R-MO27b): the owning host consumes a relayed browser MCP-App proxy
		// request, resolves URL + token from its own config/store, and returns the
		// upstream response over the response:<requestId> awaiter.
		relayProcessor.setMcpAppProxyConsumer(mcpOAuth.handleMcpAppProxy);
	}

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
					oauthMcpBridge: mcpOAuth?.bridge ?? null,
					ports: {
						syncPort: options.syncPort,
						webPort: options.webPort,
						syncHost: options.syncHost,
						webHost: options.webHost,
					},
				})
			: {
					webServer: null,
					syncServer: null,
					statusForwardCache: new Map(),
					threadExecutor: new ThreadExecutor(appContext.db, appContext.logger),
					platformMcpRegistry: null,
					handleMessageTracker: new HandleMessageTracker({ watchdogIntervalMs: 0 }),
					stopLeaderElections: () => {},
					// Single-host fallback (no model router / no sync): the holder is never
					// wired — initSync returns wsTransport: undefined by design — so these
					// stubs are live forever. Benign mode keeps the pre-#253 semantics
					// (log-once-at-debug, neutral return) so reachable single-host paths
					// like POST /consistency stay working instead of 500ing on a throw.
					wsTransportHolder: createWsTransportHolderStubs(appContext.logger, { unwired: "benign" }),
				};

	// Phase 5b: Register SIGHUP handler for config hot-reload (after sync init for wsClient reference)
	const unregisterSighup = registerSighupHandler({
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
				// R-MO2/R-MO13: thread the SAME oauth provider wiring the startup path uses
				// (shared store + raise debouncer, R-MO22) so an oauth server added or
				// changed via SIGHUP raises a challenge on a connect-time 401 instead of
				// dead-failing. Undefined when no oauth-configured server exists.
				provideAuth: mcpOAuth
					? (server) => ({ ...server, authProvider: mcpOAuth.providerFor(server) ?? undefined })
					: undefined,
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
			appContext.config.modelBackends = newConfig;
			// Re-resolve the catalog and re-apply resolved metadata to the local
			// routing path: `reload()` rebuilt the router from static config, dropping
			// the applied max_context / max_output_tokens, so a plain advertise would
			// ship the sentinel-0 windows again. `resolveGateApplyAdvertise` runs the
			// R-MC4 gate, applies resolved metadata (requirement 1), and advertises.
			const aliases = new Map<string, string | null>(
				listModelAliases(appContext.db).map((a) => [a.provider_key, a.logical_model]),
			);
			await resolveGateApplyAdvertise(
				appContext,
				modelRouter,
				newConfig,
				modelsDevCache ?? null,
				aliases,
			);
			wireBackendReadiness(appContext, modelRouter, { modelsDevCache: modelsDevCache ?? null });
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

	const webServer = serverResult.webServer;
	const syncServer = serverResult.syncServer;
	const realWebPort = webServer ? webServer.port() : null;
	const realSyncPort = syncServer ? syncServer.port() : null;
	const webHost = options.webHost ?? process.env.WEB_BIND_HOST ?? "localhost";
	const webUrl = realWebPort !== null ? `http://${webHost}:${realWebPort}` : null;

	appContext.logger.info(`
Bound is running!
Operator: ${appContext.config.allowlist.default_web_user}
${webUrl ? `\nOpen ${webUrl} in your browser to start chatting.\n` : ""}
Press Ctrl+C to stop.
`);

	// Build the single teardown path. This is exactly the body of the former
	// setupGracefulShutdown shutdown handler, minus the signal registration:
	// everything that holds the process open (servers, scheduler, heartbeat,
	// pruning, relay processor, ws transport + changelog bus, ws client, MCP
	// clients, span tracker, telemetry) is stopped here, plus the PID lockfile.
	// runStart drives it from a signal; startNode callers (tests) drive it from
	// NodeHandle.stop(). Idempotent via the `stopped` latch so a double stop() or
	// a stop() racing a signal does not double-free.
	let stopped = false;
	const stop = async (): Promise<void> => {
		if (stopped) return;
		stopped = true;
		// Everything that touches the node-owned DB (workers, clients, servers,
		// telemetry) must stop before we close the handle. The close itself and the
		// PID-file removal run in a finally so a mid-teardown throw above cannot leak
		// the open bun:sqlite handle — a leaked handle holds a Windows mandatory lock
		// on bound.db/-wal/-shm and makes a recursive rm of the data dir fail EBUSY,
		// which under the serial Windows CI lane cascades into later start tests.
		try {
			unregisterSighup();
			// Await the detached models.dev background refresh (slice 6, R-MC6) before
			// closing the DB it re-advertises off of. Its continuation guards against a
			// closed handle, but awaiting it here keeps teardown orderly and avoids a
			// post-close no-op warning. Never rejects.
			await modelsDevRefresh;
			// Same for any post-registration catalog pass of expanded backends.
			if (modelRouter) await settleExpandedBackendPasses(modelRouter);
			heartbeatHandle?.stop();
			schedulerHandle?.stop();
			pruningHandle?.stop();
			relayProcessorHandle?.stop();
			// Leader-election intervals query the DB; stop them before it closes.
			serverResult.stopLeaderElections();
			if (wsTransport) {
				wsTransport.stop();
				const { setChangelogEventBus } = await import("@bound/core");
				setChangelogEventBus(null);
			}
			wsClient?.close();
			for (const [, client] of mcpClientsMap) {
				try {
					await client.disconnect();
				} catch {
					// Ignore disconnect errors during shutdown
				}
			}
			if (webServer) await webServer.stop();
			if (syncServer) await syncServer.stop();
			// Stop the watchdog and end any still-open turn / dispatch spans so
			// BatchSpanProcessor exports them on final flush. Must run BEFORE
			// shutdownTelemetry.
			serverResult.handleMessageTracker?.stopWatchdog();
			serverResult.handleMessageTracker?.endAllOpenSpans("shutdown");
			await shutdownTelemetry();
		} finally {
			// Close the node-owned DB handle after all DB users, clients, servers and
			// telemetry have stopped, and before removing the PID lockfile. In the
			// finally so a stop-side failure above cannot leak the handle.
			//
			// The default close() is graceful: it marks the Database closed but defers
			// releasing the underlying sqlite connection until every prepared statement
			// is finalized, and bun:sqlite caches the statements the repositories compile
			// via db.query(sql) (keyed by SQL text) on the Database itself. Those cached
			// Statement objects are only finalized when GC collects them, which does not
			// happen synchronously at stop() — so after a bare close() the data dir still
			// has bound.db, bound.db-wal and bound.db-shm (plus the mmap_size=256MiB
			// mappings) held open. Confirmed on macOS via `lsof -p` after stop(): five fds
			// still held. On Windows those are mandatory file locks, so a retry-less
			// recursive rm of the data dir fails EBUSY, which under the serial Windows CI
			// lane cascades into later start tests. Closing then forcing a synchronous GC
			// collects the cached Statement objects now, so every fd + mapping is released
			// before teardown continues and nothing under the data dir survives the close
			// (lsof then shows zero). close(true) is not enough on its own: it still leans
			// on GC to reclaim the cached statements, so the release stays racy.
			appContext.db.close(false);
			Bun.gc(true);
			// Remove the PID lockfile last. Under runStart the process.on("exit")
			// handler also calls this (idempotent by PID guard); under startNode this is
			// the only caller.
			removePidFile();
		}
	};

	return {
		appContext,
		webPort: realWebPort,
		syncPort: realSyncPort,
		webUrl,
		stop,
		__test: {
			mcpClients: mcpClientsMap,
			reloadMcpForReconnect: (serverName: string): Promise<void> =>
				reloadMcpForReconnect?.(serverName) ?? Promise.resolve(),
		},
	};
}

/**
 * Production `bound start`: boot a node with full process-lifetime signal
 * wiring and block until SIGINT / SIGTERM fires, then tear it down. A thin
 * wrapper over `startNode` — all subsystem init lives there.
 */
export async function runStart(args: StartArgs): Promise<void> {
	const handle = await startNode(args, { installSignalHandlers: true });

	// Keep the process alive until a shutdown signal arrives, then run the full
	// node teardown and resolve. bootstrap.ts already registered the PID-lockfile
	// process.on("exit"|"SIGINT"|"SIGTERM") handlers under installSignalHandlers;
	// these listeners add the graceful subsystem teardown on top.
	await new Promise<void>((resolve) => {
		const shutdown = (signal: string) => async () => {
			handle.appContext.logger.info(
				`\n${signal === "SIGINT" ? "Shutting down gracefully" : "Terminating"}...`,
			);
			await handle.stop();
			resolve();
		};
		process.on("SIGINT", shutdown("SIGINT"));
		process.on("SIGTERM", shutdown("SIGTERM"));
	});
}
