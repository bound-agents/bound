/**
 * Server subsystem: web server creation, message:created handler wiring,
 * and platform connector initialization.
 */
import type { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import {
	HandleMessageTracker,
	WARM_POKE_MAX_OUTPUT_TOKENS,
	generateThreadTitle,
	getClientSessions,
	injectNotificationMessage,
	isWarmPokeNotificationPayload,
	listRunningAuxLoopThreadIds,
	resolveTopologyRole,
	routeNotificationWakeup,
	routeRelayRequest,
	runIntrospectResponseStamp,
	selectWarmPokeTargets,
	serializeRelayTraceCarrier,
} from "@bound/agent";
import { awaitPlatformRequestResponse, resolveDefaultModelId } from "@bound/agent";
import type { AgentLoopConfig, ClientToolResolver } from "@bound/agent";
import { type AppContext, resolveRelayConfig } from "@bound/core";
import {
	DEFAULT_MODEL_HINT,
	type DispatchEntry,
	ThreadExecutor,
	acknowledgeBatch,
	claimPending,
	countBackgroundToolCallsByThread,
	enqueueMessage,
	enqueueNotification,
	expireClientToolCalls,
	findAgentById,
	findBackgroundAuxSeed,
	findBackgroundPlaceholderDeliveryState,
	findFreshPlatformHost,
	findLatestTaskSettingsForThread,
	findThreadAgentIdById,
	findThreadModelHintById,
	findThreadUserAndInterfaceById,
	findUnresolvedBackgroundPlaceholder,
	hasPendingClientToolCalls,
	insertRow,
	resolveDeferredToolResult,
	softDelete,
	updateRow,
} from "@bound/core";
import type { ModelRouter } from "@bound/llm";
import type { PlatformMcpRegistry, PlatformRegisteredTool } from "@bound/platforms";
import {
	type ConnectorToolContext,
	PlatformLeaderElection,
	PlatformMcpRegistry as PlatformMcpRegistryClass,
	RssPoller,
	getConnectorHandle,
	isSubscriptionRejected,
} from "@bound/platforms";
import type { ClusterFsResult } from "@bound/sandbox";
import { parseDurationMs } from "@bound/shared";
import type {
	KeyringConfig,
	Logger,
	McpConfig,
	RouteHealthSnapshot,
	StatusForwardPayload,
	SyncConfig,
} from "@bound/shared";
import {
	BOUND_NAMESPACE,
	DEFAULT_WARM_POKE_ACTIVE_WINDOW_MS,
	WARM_POKE_SCAN_INTERVAL_MS,
	deterministicUUID,
	extractTraceContext,
	formatError,
	injectTraceContext,
	isUserFacingInterface,
	routeHealthSnapshotSchema,
	wsSchema,
} from "@bound/shared";
import type { KeyManager } from "@bound/sync";
import { createSyncServer, createWebServer } from "@bound/web";
import type { OauthMcpResolverBridge } from "@bound/web";
import { SpanStatusCode, context, trace } from "@opentelemetry/api";
import { resolveThreadModel, runLocalAgentLoop } from "../../lib/message-handler";
import type { AgentLoopFactory } from "./agent-factory.js";
import { createPlatformConnectorTool, resolvePlatformToolsForThread } from "./platform-tools.js";
import {
	type WsTransportHolder,
	createWsTransportHolderStubs,
} from "./wire-ws-transport-holder.js";
const getTracer = () => trace.getTracer("bound.web");

/**
 * Client tools advertised by the WS sessions subscribed to a thread, the
 * connection that owns them, and the session's system-prompt addition.
 */
function resolveThreadClientTools(
	wsRegistry: ClientToolResolver | undefined,
	threadId: string,
): {
	clientTools: AgentLoopConfig["clientTools"];
	connectionId: string | undefined;
	systemPromptAddition: string | undefined;
} {
	const registered = wsRegistry?.getClientToolsForThread(threadId);
	const clientTools = registered && registered.size > 0 ? registered : undefined;
	const firstToolName = clientTools?.keys().next().value;
	return {
		clientTools,
		connectionId: firstToolName
			? wsRegistry?.getConnectionForTool(threadId, firstToolName)
			: undefined,
		systemPromptAddition: wsRegistry?.getSystemPromptAdditionForThread(threadId),
	};
}

function readSyncConfig(optionalConfig: AppContext["optionalConfig"]): SyncConfig | undefined {
	const result = optionalConfig.sync;
	return result?.ok ? (result.value as SyncConfig) : undefined;
}

function injectRelayTraceCarrier(): Record<string, string> | null {
	const injected = injectTraceContext();
	if (injected) return injected;
	const span = trace.getActiveSpan();
	if (!span) return null;
	const { traceId, spanId, traceFlags } = span.spanContext();
	return { traceparent: `00-${traceId}-${spanId}-${traceFlags.toString(16).padStart(2, "0")}` };
}

export function createRemotePlatformRequest(
	deps: Pick<AppContext, "db" | "siteId" | "eventBus" | "optionalConfig">,
): NonNullable<ConnectorToolContext["remotePlatformRequest"]> {
	return async (
		serverName: string,
		method: string,
		params: Record<string, unknown>,
	): Promise<unknown> => {
		// Pick a *fresh* remote host (heartbeat within stale threshold) that
		// advertises this platform. Filtering on freshness here is what
		// turns the failure mode of "remote daemon crashed silently" from
		// a 15s relay timeout into an immediate descriptive error.
		const targetSiteId = findFreshPlatformHost(deps.db, serverName, deps.siteId);
		if (!targetSiteId) {
			throw new Error(
				`No fresh remote host found for platform server '${serverName}' (no advertising peer has heart-beated within the stale threshold)`,
			);
		}

		const routed = routeRelayRequest(deps.db, {
			targetSiteId,
			sourceSiteId: deps.siteId,
			kind: "platform_request",
			payload: JSON.stringify({
				server_name: serverName,
				method,
				params,
				timeout_ms: 15_000,
			}),
			timeoutMs: 15_000,
			// The minted row id is the deterministic, redelivery-stable key (R-DW5/6).
			traceContext: serializeRelayTraceCarrier(injectRelayTraceCarrier()) ?? undefined,
			topologyRole: resolveTopologyRole(deps.optionalConfig),
		});
		if (routed.path === "error") throw new Error(routed.reason);
		const entry = { id: routed.id };

		return await awaitPlatformRequestResponse({ db: deps.db, siteId: deps.siteId }, entry.id, {
			deadline: Date.now() + 15_000,
			targetSiteId,
		});
	};
}

/**
 * Build the cross-host MCP-App proxy relay dispatcher (R-MO27b LEG B). The web
 * MCP-Apps route calls this when a browser reaches an app-bearing server owned
 * by a peer: relay the JSON-RPC request to `ownerSiteId` over the
 * `mcp_app_proxy` durable-work kind and await the owner's response over the
 * `response:<requestId>` awaiter. Bounds the wait to the relay inference timeout
 * (`sync.relay.inference_timeout_ms`, default 300s) and throws on expiry so the
 * route maps it to a 504. Tokens never cross the relay; the owner attaches its
 * own at its own edge, and the payload the route built carries no browser
 * credential.
 */
export function createMcpAppProxyRelay(
	deps: Pick<AppContext, "db" | "siteId" | "eventBus" | "optionalConfig">,
): (
	ownerSiteId: string,
	payload: {
		server_name: string;
		method: string;
		headers: Record<string, string>;
		body_base64: string;
	},
) => Promise<{ status: number; headers: Record<string, string>; body_base64: string }> {
	return async (ownerSiteId, payload) => {
		const timeoutMs = resolveRelayConfig(readSyncConfig(deps.optionalConfig)).inference_timeout_ms;
		const routed = routeRelayRequest(deps.db, {
			targetSiteId: ownerSiteId,
			sourceSiteId: deps.siteId,
			kind: "mcp_app_proxy",
			payload: JSON.stringify(payload),
			timeoutMs,
			traceContext: serializeRelayTraceCarrier(injectRelayTraceCarrier()) ?? undefined,
			topologyRole: resolveTopologyRole(deps.optionalConfig),
		});
		if (routed.path === "error") throw new Error(routed.reason);
		const result = (await awaitPlatformRequestResponse(
			{ db: deps.db, siteId: deps.siteId },
			routed.id,
			{ deadline: Date.now() + timeoutMs, targetSiteId: ownerSiteId },
		)) as { status: number; headers: Record<string, string>; body_base64: string };
		return result;
	};
}

/**
 * Build the cross-host route-health snapshot reader for Settings › Models and
 * the model picker. Asks `targetSiteId` for its own RouteHealth snapshot over the
 * `route_health` durable-work kind (Ed25519-authenticated sync transport; no
 * HTTP fetch to a peer URL) and awaits the `response:<requestId>` result within
 * `timeoutMs`. Throws on a routing error (target not `work_spool_capable`),
 * a remote error, a malformed snapshot, or expiry — the caller maps every throw
 * to `unknown`, never to a provider failure.
 */
export function createRouteHealthRelay(
	deps: Pick<AppContext, "db" | "siteId" | "optionalConfig">,
): (targetSiteId: string, timeoutMs: number) => Promise<RouteHealthSnapshot> {
	return async (targetSiteId, timeoutMs) => {
		const routed = routeRelayRequest(deps.db, {
			targetSiteId,
			sourceSiteId: deps.siteId,
			kind: "route_health",
			payload: JSON.stringify({}),
			timeoutMs,
			topologyRole: resolveTopologyRole(deps.optionalConfig),
		});
		if (routed.path === "error") throw new Error(routed.reason);
		const raw = await awaitPlatformRequestResponse(
			{ db: deps.db, siteId: deps.siteId },
			routed.id,
			{ deadline: Date.now() + timeoutMs, targetSiteId, pollIntervalMs: 50 },
		);
		const parsed = routeHealthSnapshotSchema.safeParse(raw);
		if (!parsed.success) {
			throw new Error(
				`Invalid route_health snapshot from ${targetSiteId}: ${parsed.error.message}`,
			);
		}
		return parsed.data;
	};
}

export interface ResolveDelegationMessageIdParams {
	db: Database;
	siteId: string;
	hostName: string;
	threadId: string;
	claimed: DispatchEntry[];
	logger?: Logger;
}

export interface ResolveDelegationMessageIdResult {
	/**
	 * A real `messages.id` representing the claimed batch — the last injected
	 * notification's id, or a non-notification claim's id (which already equals
	 * its `messages.id`), or empty string when there are no claims.
	 *
	 * Preference order (highest wins):
	 * 1. A non-notification claim (user / tool_result — dispatch entry id
	 *    already equals the messages.id).
	 * 2. The id of the last notification this call injected into messages.
	 * 3. Empty string (no claims).
	 */
	delegationMessageId: string;
	/** IDs of newly inserted notification messages, in insertion order. */
	insertedMessageIds: string[];
}

/**
 * Inject any claimed notification entries into the `messages` table (as
 * `role: "developer"` rows so they survive Stage 2.5 of context assembly and
 * reach the agent), and return a real `messages.id` for the claimed batch.
 *
 * This is the notification-injection step of the local turn. Its load-bearing
 * job is the side effect: a notification claim's dispatch_queue id is a
 * synthetic UUID (from `enqueueNotification`), so the real developer-role
 * message must be written here before assembly so the agent sees it. The
 * returned id maps the batch to a real row (see the result type).
 */
export function resolveDelegationMessageId(
	params: ResolveDelegationMessageIdParams,
): ResolveDelegationMessageIdResult {
	const { db, siteId, hostName, threadId, claimed, logger } = params;
	const insertedMessageIds: string[] = [];
	let firstRealMessageId: string | undefined;

	for (const entry of claimed) {
		if (entry.event_type === "notification" && entry.event_payload) {
			try {
				// Invariant #19: injected system-generated context uses role='developer'.
				const messageId = injectNotificationMessage(db, siteId, hostName, threadId, entry);
				if (messageId) insertedMessageIds.push(messageId);
			} catch (err) {
				logger?.error("[notify] Failed to inject notification message", {
					messageId: entry.message_id,
					threadId,
					error: formatError(err),
				});
			}
		} else if (firstRealMessageId === undefined) {
			// enqueueMessage / enqueueToolResult store the real messages.id
			// in dispatch_queue.message_id, so it's safe to forward verbatim.
			firstRealMessageId = entry.message_id;
		}
	}

	const delegationMessageId =
		firstRealMessageId ??
		(insertedMessageIds.length > 0 ? insertedMessageIds[insertedMessageIds.length - 1] : "");

	return { delegationMessageId, insertedMessageIds };
}

export interface ServerResult {
	webServer: Awaited<ReturnType<typeof createWebServer>> | null;
	syncServer: Awaited<ReturnType<typeof createSyncServer>> | null;
	statusForwardCache: Map<string, StatusForwardPayload>;
	threadExecutor: ThreadExecutor;
	platformMcpRegistry: PlatformMcpRegistry | null;
	handleMessageTracker: HandleMessageTracker;
	/**
	 * Stops every leader election initServer started (platform connectors,
	 * RSS poller). Their ownership/staleness intervals hold the DB handle, so
	 * the node's teardown must stop them before the DB closes. Idempotent.
	 */
	stopLeaderElections: () => void;
	/**
	 * Stops the background intervals initServer started (client-tool-call
	 * expiry scan, warm-poke driver, remote platform-tool refresh) and removes
	 * the process-exit listeners that back them. They hold the event loop open,
	 * so the node's teardown must stop them. Idempotent.
	 */
	stopScanIntervals: () => void;
	wsTransportHolder: WsTransportHolder;
}

export interface ServerDeps {
	appContext: AppContext;
	modelRouter: ModelRouter;
	agentLoopFactory: AgentLoopFactory;
	keyManager: KeyManager | undefined;
	keyring: KeyringConfig | undefined;
	hubSiteId: string | undefined;
	/** Cluster FS reference, exposed via `/api/sandbox/file` for `boundless_copy`. */
	clusterFsObj: ClusterFsResult | null;
	/** RelayProcessor to wire platform MCP registry and factories into. */
	relayProcessor: {
		setPlatformMcpRegistry(registry: PlatformMcpRegistry): void;
		setAgentLoopFactory(factory: AgentLoopFactory): void;
		setThreadExecutor(executor: ThreadExecutor): void;
		setWsRegistry(registry: ClientToolResolver): void;
	};
	/**
	 * The resolving host's in-process MCP OAuth resolver bridge (slice 3.5,
	 * R-MO17/R-MO27). Threaded to `createWebServer` so `GET /oauth/mcp/callback`
	 * and `POST /oauth/mcp/claim` correlate callbacks to live attempts. Null on a
	 * host with no oauth-configured MCP server.
	 */
	oauthMcpBridge?: OauthMcpResolverBridge | null;
	/**
	 * Co-location token accessor (R-MO27b LEG A). Forwarded to the web server so the
	 * MCP-Apps proxy attaches the owner's OAuth token at this host's fetch edge for a
	 * locally-owned app-bearing server. Null on a host with no oauth MCP server.
	 */
	getMcpAppAccessToken?: import("@bound/web").WebServerConfig["getMcpAppAccessToken"] | null;
	/**
	 * Explicit network binding, threaded from `startNode`. Each field defaults to
	 * the production environment-variable behavior when omitted, so the `bound
	 * start` path is unchanged. Tests pass `webPort: 0` / `syncPort: 0` for
	 * OS-assigned ephemeral ports and read the real ports back from `ServerResult`.
	 */
	ports?: {
		/** Sync server port. Default: `process.env.PORT` or 3000. */
		syncPort?: number;
		/** Web server port. Default: `process.env.WEB_PORT` or 3001. */
		webPort?: number;
		/** Sync server bind host. Default: `process.env.BIND_HOST` or "localhost". */
		syncHost?: string;
		/** Web server bind host. Default: `process.env.WEB_BIND_HOST` or "localhost". */
		webHost?: string;
	};
	/**
	 * Override periods for the two background scan intervals (milliseconds).
	 * Defaults to the production constants (expiry scan 60s, warm-poke scan
	 * `WARM_POKE_SCAN_INTERVAL_MS`). Injected only by tests that need the scans
	 * to fire within a deterministic window; production omits it and the timing
	 * is unchanged.
	 */
	scanIntervals?: {
		/** Period of the stale client-tool-call expiry scan. Default 60000. */
		expiryScanIntervalMs?: number;
		/** Period of the cache-warming poke driver. Default WARM_POKE_SCAN_INTERVAL_MS. */
		warmPokeScanIntervalMs?: number;
	};
}

export async function initServer(deps: ServerDeps): Promise<ServerResult> {
	const leaderElectionStops: Array<() => void> = [];
	const stopLeaderElections = (): void => {
		for (const stop of leaderElectionStops.splice(0)) stop();
	};
	const scanIntervalStops: Array<() => void> = [];
	const stopScanIntervals = (): void => {
		for (const stop of scanIntervalStops.splice(0)) stop();
	};
	const {
		appContext,
		modelRouter,
		agentLoopFactory,
		keyManager,
		keyring,
		hubSiteId,
		clusterFsObj,
		relayProcessor,
		oauthMcpBridge,
		getMcpAppAccessToken,
		ports,
		scanIntervals,
	} = deps;

	// Wire the factory into the relay processor so process relays run with full sandbox + tools.
	relayProcessor.setAgentLoopFactory(agentLoopFactory);

	appContext.logger.info("Starting servers...");
	let webServer: Awaited<ReturnType<typeof createWebServer>> | null = null;
	let syncServer: Awaited<ReturnType<typeof createSyncServer>> | null = null;
	const statusForwardCache = new Map<string, StatusForwardPayload>();
	const threadExecutor = new ThreadExecutor(appContext.db, appContext.logger);
	const handleMessageTracker = new HandleMessageTracker();
	handleMessageTracker.startWatchdog();

	// `maybeCloseTurnIfIdle` lives on the tracker — it's the close-condition
	// counterpart to `openTurn`/`closeTurn` and shares the dispatch_queue
	// semantics, so co-locating keeps invariants discoverable. See
	// `packages/agent/src/handle-message-tracker.ts` and the integration test
	// `handle-message-tracker.integration.test.ts` for the lifecycle contract.

	// Placeholders log + throw until `wireWsTransportHolder` (index.ts) copies
	// the real WsTransport methods on after sync init (#253).
	const wsTransportHolder: WsTransportHolder = createWsTransportHolderStubs(appContext.logger);

	// Wire the executor into the relay processor for Discord/platform process relays.
	relayProcessor.setThreadExecutor(threadExecutor);

	// MCP platform registry — declared here so message:created handler can reference it,
	// populated in the platform connectors section below.
	let platformMcpRegistry: PlatformMcpRegistry | null = null;
	// Connector tool — created after platform registry setup, used by message handler
	// for user-facing threads that need connector access.
	let connectorTool: PlatformRegisteredTool | null = null;

	try {
		const modelBackends = appContext.config.modelBackends;

		// Sync server: primary port, externally accessible for hub-spoke replication.
		// Explicit startNode options take precedence; otherwise the production env
		// behavior is unchanged (PORT/BIND_HOST, defaults 3000/localhost).
		const syncPort = ports?.syncPort ?? Number.parseInt(process.env.PORT || "3000", 10);
		const syncHost = ports?.syncHost ?? process.env.BIND_HOST ?? "localhost";

		// Web server: internal management interface
		const webPort = ports?.webPort ?? Number.parseInt(process.env.WEB_PORT || "3001", 10);
		const webHost = ports?.webHost ?? process.env.WEB_BIND_HOST ?? "localhost";

		const operatorUserId = deterministicUUID(
			BOUND_NAMESPACE,
			appContext.config.allowlist.default_web_user,
		);

		webServer = await createWebServer(appContext.db, appContext.eventBus, {
			port: webPort,
			host: webHost,
			// Forwarded to the pending-MCP-challenges route so the web-chat consent
			// card gates its live authorize flow on a loopback bind (R-MO27c).
			webBindHost: webHost,
			hostName: appContext.hostName,
			operatorUserId,
			// Live getter (not a boot snapshot): the /models discovery endpoint
			// must reflect SIGHUP reloads, which reassign appContext.config.modelBackends
			// in place. A captured snapshot would leave models added via reload
			// (e.g. gpt-5.x) invisible to the editor's model dropdown even though
			// the router routes them fine. Dedup is recomputed per request.
			models: () => {
				const live = appContext.config.modelBackends;
				const seen = new Set<string>();
				const models: Array<{ id: string; provider: string }> = [];
				for (const b of live.backends) {
					if (!seen.has(b.id)) {
						seen.add(b.id);
						models.push({ id: b.id, provider: b.provider });
					}
				}
				return { models, default: live.default };
			},
			backendPricing: modelBackends.backends.map((b) => ({
				id: b.id,
				price_per_m_input: b.price_per_m_input,
				price_per_m_output: b.price_per_m_output,
				price_per_m_cache_read: b.price_per_m_cache_read,
				price_per_m_cache_write: b.price_per_m_cache_write,
				price_per_m_cache_write_1h: b.price_per_m_cache_write_1h,
			})),
			siteId: appContext.siteId,
			// Sync server config — forwarded to the webhooks route so it can
			// enumerate the local webhook delivery URL alongside any cluster
			// peers' URLs (#36). Webhook ingestion is on the sync port.
			syncBindHost: syncHost,
			syncPort,
			hubUrl: readSyncConfig(appContext.optionalConfig)?.hub || undefined,
			// Agent-side MCP servers (mcp.json) — forwarded to the web app so the
			// MCP-Apps route can source app-bearing http servers and proxy the
			// browser to them. Web-router only; never the sync router.
			mcpConfig: ((): McpConfig | null => {
				const cfg = appContext.optionalConfig.mcp;
				return cfg?.ok ? (cfg.value as McpConfig) : null;
			})(),
			statusForwardCache,
			activeLoops: threadExecutor.activeThreads as Set<string>,
			requestConsistency: (tables: string[]) => wsTransportHolder.requestConsistency(tables),
			handleMessageTracker,
			clusterFs: clusterFsObj?.fs ?? null,
			modelRouter,
			topologyRole: resolveTopologyRole(appContext.optionalConfig),
			oauthMcpBridge: oauthMcpBridge ?? null,
			// R-MO27b LEG A: attach the owner's OAuth token at this host's fetch edge.
			getMcpAppAccessToken: getMcpAppAccessToken ?? undefined,
			// R-MO27b LEG B: relay a browser MCP-App proxy request to the owning host.
			relayMcpAppProxy: createMcpAppProxyRelay(appContext),
			// Settings › Models / model picker: read peers' own route-health snapshots.
			relayRouteHealth: createRouteHealthRelay(appContext),
			// Relayed /v1/responses inference honors sync.relay.inference_timeout_ms.
			inferenceTimeoutMs: resolveRelayConfig(readSyncConfig(appContext.optionalConfig))
				.inference_timeout_ms,
		});
		await webServer.start();

		// Capture connection registry from web server for client tool lookup in handleThread
		const wsRegistry = webServer?.wsRegistry;

		// The relay processor resolves client tools for a notify/introspect wakeup
		// routed here because the live session lives here (issue #91).
		if (wsRegistry) {
			relayProcessor.setWsRegistry(wsRegistry);
		}

		// Start sync server if sync prerequisites are available
		if (appContext.siteId && keyring && appContext.logger) {
			const wsBlock = readSyncConfig(appContext.optionalConfig)?.ws;
			const wsConfig = wsBlock ? wsSchema.parse(wsBlock) : undefined;

			syncServer = await createSyncServer(appContext.db, appContext.eventBus, {
				port: syncPort,
				host: syncHost,
				siteId: appContext.siteId,
				keyring,
				logger: appContext.logger,
				hubSiteId,
				keyManager,
				wsConfig: wsConfig
					? {
							idleTimeout: wsConfig.idle_timeout,
							backpressureLimit: wsConfig.backpressure_limit,
						}
					: undefined,
				wsTransportHolder,
			});
			if (syncServer) {
				await syncServer.start();
			}
		}

		// Wire message:created events to the agent loop
		const activeLoopAbortControllers = new Map<string, AbortController>();

		// Listen for status:forward events from RelayProcessor
		appContext.eventBus.on("status:forward", (payload: StatusForwardPayload) => {
			statusForwardCache.set(payload.thread_id, payload);
		});

		// #76: dispatcher-owned background aux execution. See the ownership comment
		// in handleThread. Runs under the same thread-exclusive executor lock as
		// ordinary dispatch, so a straggler tool_result wakeup (an inline client
		// tool acking late) cannot start a second loop on the thread mid-run.
		const runBackgroundAuxThread = async (
			thread_id: string,
			agentId: string,
			seed: { parentThreadId: string; parentCallId: string; instructions: string },
		): Promise<void> => {
			await threadExecutor.execute(thread_id, async () => {
				const claimed = claimPending(appContext.db, thread_id, appContext.siteId);
				if (claimed.length === 0) return {};
				const claimedIds = claimed.map((e) => e.message_id);

				// Guard on proof-of-delivery, not on the in-flight marker: a spurious
				// re-wake after the placeholder already RESOLVED must not clobber a
				// delivered result — but a placeholder that missed its `background`
				// stamp (#220 defect 1, observed twice more on 2026-08-24) must still
				// receive its only delivery. resolveDeferredToolResult stamps
				// `background_delivered` when it lands a result, so "delivered" is
				// provable from the row itself; anything else fails safe toward
				// delivering. A missing row entirely is the placeholder-not-yet-
				// persisted race, which resolveDeferredToolResult already handles
				// (enqueue-only no-op).
				const finishParent = (content: string, isError: boolean): void => {
					const placeholder = findBackgroundPlaceholderDeliveryState(
						appContext.db,
						seed.parentThreadId,
						seed.parentCallId,
					);
					if (!placeholder?.delivered) {
						if (
							placeholder &&
							!findUnresolvedBackgroundPlaceholder(
								appContext.db,
								seed.parentThreadId,
								seed.parentCallId,
							)
						) {
							// The in-flight stamp is missing but the result is deliverable —
							// keep the loud log so the stamp defect stays visible while the
							// consequence (lost delivery) no longer occurs.
							appContext.logger.error(
								"[agent] Background placeholder missing its background stamp — delivering anyway (#220)",
								{
									parentThreadId: seed.parentThreadId,
									parentCallId: seed.parentCallId,
									auxThreadId: thread_id,
									placeholderId: placeholder.id,
								},
							);
						}
						resolveDeferredToolResult(
							appContext.db,
							seed.parentThreadId,
							seed.parentCallId,
							content,
							isError,
							appContext.siteId,
							appContext.eventBus,
						);
						appContext.eventBus.emit("aux:completed", {
							thread_id,
							parent_thread_id: seed.parentThreadId,
						});
					} else {
						// Already delivered — this is the spurious re-wake the guard exists
						// for. Push the recomputed count so a stale client indicator
						// converges, and leave the delivered result untouched.
						appContext.logger.warn(
							"[agent] Background aux re-wake after delivery — skipping duplicate resolution",
							{
								parentThreadId: seed.parentThreadId,
								parentCallId: seed.parentCallId,
								auxThreadId: thread_id,
							},
						);
						appContext.eventBus.emit("background:count", {
							thread_id: seed.parentThreadId,
							count: countBackgroundToolCallsByThread(appContext.db, seed.parentThreadId),
						});
					}
					// #220: re-drive the parent loop unconditionally. resolveDeferredToolResult
					// only ENQUEUES the tool_result wakeup — its updateRow fires no
					// message:created, and this dispatcher never called handleThread for
					// the parent — so a resolution landing while the parent loop was idle
					// stranded the pending entry until an unrelated message arrived
					// (observed live: two entries pending for 10h). notify:enqueued is
					// the existing wake channel; enqueueToolResult's (thread, call_id)
					// dedup makes the re-drive idempotent, and handleThread with nothing
					// pending is a no-op.
					appContext.eventBus.emit("notify:enqueued", { thread_id: seed.parentThreadId });
				};

				try {
					const agent = findAgentById(appContext.db, agentId);
					if (!agent) {
						finishParent(
							`Error: auxiliary agent identity ${agentId} not found for background invocation`,
							true,
						);
						acknowledgeBatch(appContext.db, claimed);
						return { claimedIds };
					}
					const threadInfo = findThreadUserAndInterfaceById(appContext.db, thread_id);
					const parentThreadInfo = findThreadUserAndInterfaceById(
						appContext.db,
						seed.parentThreadId,
					);
					const modelHint =
						findThreadModelHintById(appContext.db, thread_id)?.model_hint ??
						agent.model_hint ??
						null;

					// Inherit the complete dispatching surface context, not only its
					// client tool registry. For boundless this includes the frozen cwd,
					// git context, and injected context-file bodies. For connector/event
					// surfaces it includes their platform-authored instructions.
					const { clientTools, connectionId, systemPromptAddition } = resolveThreadClientTools(
						wsRegistry,
						seed.parentThreadId,
					);
					const platformInstructions = platformMcpRegistry?.getInstructionsForThread(
						seed.parentThreadId,
					);
					const parentInterface = parentThreadInfo?.interface;
					const platform =
						parentInterface && isUserFacingInterface(parentInterface) ? parentInterface : undefined;

					const runner = agentLoopFactory.createAuxLoopRunner?.({
						clientTools,
						connectionId,
						platform,
						systemPromptAddition,
						platformInstructions,
					});
					if (!runner) {
						finishParent(
							"Error: this host's agent loop factory cannot construct auxiliary loops",
							true,
						);
						acknowledgeBatch(appContext.db, claimed);
						return { claimedIds };
					}

					appContext.logger.info("[agent] Running background aux thread", {
						threadId: thread_id,
						agentId,
						parentThreadId: seed.parentThreadId,
						parentCallId: seed.parentCallId,
					});
					const result = await runner({
						threadId: thread_id,
						agentId: agent.id,
						persona: agent.persona,
						modelHint,
						allowlistedTools: agent.tools ? (JSON.parse(agent.tools) as string[]) : null,
						instructions: seed.instructions,
						userId: threadInfo?.user_id ?? operatorUserId,
						parentThreadId: seed.parentThreadId,
					});
					// The child-thread link rides the placeholder row's metadata
					// (aux_thread, stamped by the loop's persist seam from the
					// DeferredToolResult) — resolveDeferredToolResult preserves
					// sibling metadata keys, so the web card keeps its link after
					// resolution without a content trailer.
					finishParent(
						result.error ? `Auxiliary agent errand failed: ${result.error}` : result.summary,
						!!result.error,
					);
					acknowledgeBatch(appContext.db, claimed);
					return { claimedIds };
				} catch (error) {
					finishParent(
						`Error: background auxiliary invocation failed: ${formatError(error)}`,
						true,
					);
					try {
						acknowledgeBatch(appContext.db, claimed);
					} catch (ackError) {
						// Claimed entries reset via the executor error path.
						appContext.logger.debug("[agent] Background aux batch ack failed", {
							threadId: thread_id,
							error: formatError(ackError),
						});
					}
					return {};
				}
			});
		};

		// The ThreadExecutor owns the thread-exclusive lock and drain loop.
		const handleThread = async (thread_id: string, traceContext?: string) => {
			if (!modelRouter) {
				appContext.logger.warn("[agent] No model router configured, cannot process message");
				return;
			}

			// An aux thread (#201) has two ownership modes, distinguished by durable
			// state on its seed message (#76):
			//
			// FOREGROUND (no background_parent correlation on the seed): a nested
			// AuxAgentLoop inside the dispatching thread's turn owns it for the
			// invocation's lifetime. Never claim one here: this dispatcher would
			// build a MainAgentLoop, losing the persona, the agent_id memory
			// scoping, AND the EXCLUDED_TOOLS capability boundary
			// (aux/task/cancel/notify/introspect) — a capability breach, not just a
			// behavioral regression. Its inherited client tools persist tool_result
			// rows that fire this listener; the inline resolver in AuxAgentLoop
			// consumes those, and `acknowledgeToolResultForCall` closes the entry.
			//
			// BACKGROUND (seed stamped with metadata.background_parent): the
			// dispatcher owns it. aux.invoke(background) enqueued the seed through
			// dispatch_queue and returned a placeholder to the parent; this branch
			// runs the capability-scoped AuxAgentLoop over the child thread and
			// resolves the parent's placeholder on completion. Restart durability is
			// the ordinary dispatch machinery — bootstrap resets interrupted entries
			// to pending, recovery re-dispatches the thread, and the errand re-runs
			// from its durable seed.
			//
			// Keyed on `agent_id IS NOT NULL`, never the `interface` tag — `interface`
			// is descriptive only.
			const auxOwner = findThreadAgentIdById(appContext.db, thread_id);
			if (auxOwner?.agent_id) {
				const seed = findBackgroundAuxSeed(appContext.db, thread_id);
				if (!seed) {
					appContext.logger.debug(
						"[agent] Skipping dispatch for aux thread — its nested loop owns it",
						{ threadId: thread_id },
					);
					return;
				}
				await runBackgroundAuxThread(thread_id, auxOwner.agent_id, seed);
				return;
			}

			const needsRetrigger = await threadExecutor.execute(
				thread_id,
				// runFn: claim → inject notification messages → resolve model → run inference
				async (shouldYield) => {
					const claimed = claimPending(appContext.db, thread_id, appContext.siteId);
					if (claimed.length === 0) return {};

					const claimedIds = claimed.map((e) => e.message_id);

					// Warm-poke detection (issue #10). A poke wakeup runs tool-less with
					// clamped output — it exists only to re-read the cached prefix. We
					// require EVERY claimed entry to be a warm poke: if a real user
					// message or tool result was co-claimed, the turn must run normally
					// with full tools.
					const isCacheWarmPoke =
						claimed.length > 0 &&
						claimed.every(
							(c) =>
								c.event_type === "notification" && isWarmPokeNotificationPayload(c.event_payload),
						);

					try {
						// Inject notification context as developer-role messages so the
						// agent can see and respond to non-user events (task completions,
						// etc.). The rows must exist before local assembly.
						resolveDelegationMessageId({
							db: appContext.db,
							siteId: appContext.siteId,
							hostName: appContext.hostName,
							threadId: thread_id,
							claimed,
							logger: appContext.logger,
						});

						const taskBinding = findLatestTaskSettingsForThread(appContext.db, thread_id);
						// Use the same task > thread > default precedence as scheduler
						// wakeups. The symbolic default lets resolveModel apply the
						// cluster default role; a local backend id would bypass it.
						const activeModelId = resolveThreadModel(
							appContext.db,
							thread_id,
							DEFAULT_MODEL_HINT,
							taskBinding?.id,
						);

						const threadRow = appContext.db
							.query("SELECT user_id, interface FROM threads WHERE id = ?")
							.get(thread_id) as { user_id: string; interface: string } | null;
						const userId = threadRow?.user_id || operatorUserId;

						// `agent.handle-message` and `web.handle-message` keep the whole
						// logical cycle on one trace regardless of where inference runs.
						const inboundCtx = traceContext
							? extractTraceContext(
									(() => {
										try {
											return JSON.parse(traceContext) as Record<string, string>;
										} catch {
											return {};
										}
									})(),
								)
							: undefined;

						const triggerEventTypes = new Set(claimed.map((c) => c.event_type));
						const isToolResultResume =
							triggerEventTypes.has("tool_result") && !triggerEventTypes.has("user_message");

						let turnCtx = handleMessageTracker.getTurnContext(thread_id);
						if (!isToolResultResume || turnCtx === null) {
							turnCtx = handleMessageTracker.openTurn(thread_id, inboundCtx);
						}
						handleMessageTracker.touchTurn(thread_id);

						{
							// R-UD1: the loop always runs on the trigger host, assembling
							// from its own authoritative state and relaying only inference
							// and tool calls (R-UD12: affinity is an optimization).
							// Derive the platform tag and platform tools for
							// this thread. The tag tells the agent which surface the
							// current turn originated from — web, boundless, discord, etc.
							// — which is injected into the volatile context as
							// "## Platform Context: <name>". Scheduler- and MCP-driven
							// threads have no user-facing surface and stay filtered out.
							const threadInterface = threadRow?.interface;
							const platform =
								threadInterface && isUserFacingInterface(threadInterface)
									? threadInterface
									: undefined;

							// Event task threads additionally receive the connector tool so they
							// can detach a malfunctioning subscription without external help.
							let platformTools: PlatformRegisteredTool[] | undefined;
							// Connector-authored instructions, surfaced only to event-bound
							// threads (mirrors getInstructionsForThread's scoping).
							let platformInstructions: string | undefined;
							if (platformMcpRegistry) {
								const scopedTools = platformMcpRegistry.getToolsForThread(thread_id);
								const resolvedTools = resolvePlatformToolsForThread(
									platformMcpRegistry,
									thread_id,
									connectorTool,
								);
								if (resolvedTools.length > 0) {
									platformTools = resolvedTools;
								}
								if (scopedTools.size > 0) {
									platformInstructions = platformMcpRegistry.getInstructionsForThread(thread_id);
								}
							}

							const {
								clientTools: resolvedClientTools,
								connectionId: resolvedConnectionId,
								systemPromptAddition,
							} = resolveThreadClientTools(wsRegistry, thread_id);

							// Emit "thinking" status so WebSocket clients (TUI) show thinking indicator
							appContext.eventBus.emit("status:forward", {
								thread_id: thread_id,
								status: "thinking",
								tokens: 0,
								detail: null,
							});

							// Capture turn boundary for metrics recording and context tracking.
							const turnStartAt = new Date().toISOString();

							const tracer = getTracer();
							const rootSpan = tracer.startSpan(
								"web.handle-message",
								{
									attributes: {
										"thread.id": thread_id,
										"user.id": userId,
										"message.id": claimedIds[0] ?? "",
										"agent.execution": "local",
										platform: platform ?? "web",
									},
								},
								turnCtx,
							);

							let agentLoopResult: Awaited<ReturnType<typeof runLocalAgentLoop>>;
							try {
								const result = await context.with(trace.setSpan(turnCtx, rootSpan), () =>
									runLocalAgentLoop({
										eventBus: appContext.eventBus,
										threadId: thread_id,
										userId,
										modelId: activeModelId,
										activeLoopAbortControllers,
										agentLoopFactory,
										shouldYield,
										platform,
										clientTools: resolvedClientTools,
										connectionId: resolvedConnectionId,
										systemPromptAddition,
										platformTools,
										platformInstructions,
										handleMessageTracker,
										noTools: isCacheWarmPoke,
										maxOutputTokens: isCacheWarmPoke ? WARM_POKE_MAX_OUTPUT_TOKENS : undefined,
									}),
								);
								agentLoopResult = result;
								rootSpan.setStatus({ code: SpanStatusCode.OK });
							} catch (err) {
								rootSpan.setStatus({
									code: SpanStatusCode.ERROR,
									message: err instanceof Error ? err.message : String(err),
								});
								throw err;
							} finally {
								rootSpan.end();
								handleMessageTracker.touchTurn(thread_id);
							}

							const { agentResult: result } = agentLoopResult;

							if (result.yielded) {
								appContext.logger.info(
									`[agent] Inference yielded for thread ${thread_id}, re-batching`,
								);
								return { yielded: true, claimedIds };
							}

							if (result.error) {
								appContext.logger.error(`[agent] Error: ${result.error}`);
							} else {
								appContext.logger.info(
									`[agent] Done: ${result.messagesCreated} messages, ${result.toolCallsMade} tool calls`,
								);
							}

							// Platform delivery is now handled through MCP connectors and event tasks.

							// Stamp introspect responses after turn completes
							await runIntrospectResponseStamp({
								db: appContext.db,
								siteId: appContext.siteId,
								threadId: thread_id,
								turnStartAt,
							});

							// NOTE: No post-loop message:broadcast needed here. The agent loop's
							// broadcastMessage() already emits message:broadcast for every message
							// (including the final assistant response) as it's created. A redundant
							// broadcast here caused duplicate delivery to WebSocket clients.

							// Emit status:forward with active: false to signal completion to MCP handler
							appContext.eventBus.emit("status:forward", {
								thread_id: thread_id,
								status: "idle",
								tokens: 0,
								detail: null,
							});
						}

						// Acknowledge the batch we just processed
						acknowledgeBatch(appContext.db, claimed);
						handleMessageTracker.maybeCloseTurnIfIdle(appContext.db, thread_id, "ok");
						return { claimedIds };
					} catch (error) {
						appContext.logger.error(`[agent] Error: ${formatError(error)}`);
						try {
							acknowledgeBatch(appContext.db, claimed);
						} catch (ackError) {
							appContext.logger.error("Failed to acknowledge message batch", {
								error: ackError instanceof Error ? ackError.message : String(ackError),
								claimedIds,
							});
						}
						// Close the turn with error status — the cycle terminated
						// abnormally and is no longer in a state that should hold
						// the span open.
						handleMessageTracker.closeTurn(
							thread_id,
							"error",
							error instanceof Error ? error.message : String(error),
						);
						return {};
					}
				},
				// onComplete: generate thread title, notify platforms
				async () => {
					const hasLocalBackend = modelRouter.listBackends().length > 0;
					if (hasLocalBackend) {
						generateThreadTitle(
							appContext.db,
							thread_id,
							modelRouter.getDefault(),
							appContext.siteId,
						)
							.then((titleResult) => {
								if (titleResult.ok) {
									appContext.logger.info(`[agent] Thread title: ${titleResult.value}`);
								}
							})
							.catch((err) =>
								appContext.logger.warn("[agent] Title generation failed", {
									error: formatError(err),
								}),
							);
					}
				},
			);

			// Re-trigger if entries accumulated during the drain loop and weren't processed.
			// Without this, messages arriving while a loop is active become orphaned after
			// the executor releases the lock (no new message:created fires to re-dispatch).
			if (needsRetrigger) {
				appContext.logger.info(`[agent] Re-triggering dispatch for thread ${thread_id}`);
				// Deferred to a fresh macrotask so the executor lock is released first.
				setTimeout(
					() =>
						handleThread(thread_id).catch((err) =>
							appContext.logger.warn("Background re-trigger failed", {
								error: formatError(err),
							}),
						),
					0,
				);
			}
		};

		// message:created handler — enqueue and dispatch
		appContext.eventBus.on("message:created", ({ message, thread_id, trace_context }) => {
			// Only enqueue user messages (tool_result dispatch entries are
			// created by handleToolResult in the WS handler via enqueueToolResult)
			if (message.role === "user") {
				enqueueMessage(appContext.db, message.id, thread_id);
			}

			// Trigger handleThread for user messages AND tool_result messages.
			// tool_result entries wake the agent loop to resume after client tool execution.
			//
			// Barrier: when a tool_call turn dispatches multiple client tools in
			// parallel, their results arrive independently. Firing handleThread on
			// the first arrival would re-enter inference before the remaining
			// results land, letting the model emit a next turn whose tool_calls
			// get interleaved with straggler tool_results. That poisons context
			// assembly and triggers Bedrock tool_use_id_mismatch on the next send.
			// Only resume once every outstanding client tool call for the thread
			// has been acknowledged.
			if (message.role === "user" || message.role === "tool_result") {
				if (message.role === "tool_result" && hasPendingClientToolCalls(appContext.db, thread_id)) {
					// Another client tool result is still outstanding for this
					// turn; defer resume until the last one acks.
					return;
				}
				handleThread(thread_id, trace_context).catch((err) =>
					appContext.logger.error("[agent] Unhandled dispatch error", {
						error: formatError(err),
					}),
				);
			}
		});

		// Proactive notifications: trigger inference for task completions
		appContext.eventBus.on("task:completed", ({ task_id, result }) => {
			// `tasks` has no `name` column; label the task by its trigger spec, the
			// same convention memory-with-source uses for `task_name`.
			const task = appContext.db
				.query("SELECT id, trigger_spec, thread_id FROM tasks WHERE id = ? AND deleted = 0")
				.get(task_id) as { id: string; trigger_spec: string; thread_id: string | null } | null;

			if (!task?.thread_id) return; // No thread to notify

			const notificationPayload = {
				type: "task_complete",
				task_id: task.id,
				task_name: task.trigger_spec,
				result: result ?? "completed",
				notification_id: randomUUID(),
			};

			// Route through the session-host resolver (#91): if the task's thread
			// has a live boundless session on
			// another host, the wakeup ships there instead of waking a second,
			// detached loop here. Local delivery emits notify:enqueued, which the
			// listener below turns into handleThread — no direct call needed.
			routeNotificationWakeup(
				appContext.db,
				appContext.eventBus,
				appContext.siteId,
				task.thread_id,
				notificationPayload,
				resolveTopologyRole(appContext.optionalConfig),
			);
		});

		// Notify command: dispatch inference for proactive notifications
		appContext.eventBus.on("notify:enqueued", ({ thread_id }) => {
			handleThread(thread_id).catch((err) =>
				appContext.logger.error("[notify] Dispatch error", { error: formatError(err) }),
			);
		});

		// Recover: dispatch any threads that have pending entries (from crash recovery)
		const pendingThreads = appContext.db
			.prepare(
				`SELECT DISTINCT thread_id FROM dispatch_queue WHERE status = 'pending'
				UNION SELECT DISTINCT json_extract(payload, '$.thread_id') AS thread_id FROM durable_work
				WHERE target_site_id = ? AND kind = 'dispatch_message' AND claim_state = 'pending'`,
			)
			.all("local") as Array<{ thread_id: string }>;
		for (const { thread_id } of pendingThreads) {
			appContext.logger.info(`[recovery] Re-dispatching pending messages for thread ${thread_id}`);
			handleThread(thread_id).catch((err) =>
				appContext.logger.error("[recovery] Unhandled dispatch error", { error: formatError(err) }),
			);
		}

		// Periodic TTL-based expiry scan for stale client tool calls.
		const CLIENT_TOOL_CALL_TTL_MS = 5 * 60 * 1000; // 5 minutes default
		const EXPIRY_SCAN_INTERVAL_MS = scanIntervals?.expiryScanIntervalMs ?? 60 * 1000; // Scan every 60 seconds

		const expiryScanInterval = setInterval(() => {
			try {
				// A client tool call holding for a live session — a human at a
				// permission gate, a slow local exec — is not stuck; the TTL clock
				// starts at enqueue and never resets, so without this it would reap
				// healthy calls. Exclude threads whose client is still connected;
				// a dead connection has no live session and expires as before.
				// A running aux loop owns its own client-tool wait, sized from each
				// call's timeout (#278); its sessionless thread must not be reaped
				// at the 5-minute TTL out from under it.
				// An aux thread's call relayed here from another host (#295) waits
				// under its parent's live session, and the relay wait expires it at
				// the call's own timeout, so children of live session threads are
				// spared as well.
				const liveSessionThreadIds = getClientSessions(appContext.db)
					.filter((s) => s.live)
					.map((s) => s.threadId);
				const expired = expireClientToolCalls(
					appContext.db,
					CLIENT_TOOL_CALL_TTL_MS,
					undefined,
					[...liveSessionThreadIds, ...listRunningAuxLoopThreadIds()],
					liveSessionThreadIds,
				);
				if (expired.length > 0) {
					// Group by thread_id
					const threadIds = new Set(expired.map((e) => e.thread_id));
					const now = new Date().toISOString();

					for (const threadId of threadIds) {
						const threadExpired = expired.filter((e) => e.thread_id === threadId);

						// Emit tool:cancel for expired entries (AC3.2)
						if (webServer?.emitToolCancel) {
							webServer.emitToolCancel(threadExpired, threadId, "dispatch_expired");
						}

						// Inject interruption notice as a developer-role message so
						// Stage 2.5 of context assembly delivers it to the agent.
						// Invariant #19 forbids role='system' in the messages table.
						try {
							insertRow(
								appContext.db,
								"messages",
								{
									id: randomUUID(),
									thread_id: threadId,
									role: "developer",
									content: `[Client tool call expired] One or more client tool calls timed out after ${CLIENT_TOOL_CALL_TTL_MS / 1000}s without receiving results. The client may have disconnected permanently.`,
									model_id: null,
									tool_name: null,
									created_at: now,
									modified_at: now,
									host_origin: appContext.hostName,
									deleted: 0,
									exit_code: null,
									metadata: null,
								},
								appContext.siteId,
							);

							// Re-trigger handleThread to unblock the thread
							handleThread(threadId).catch((err) =>
								appContext.logger.warn("[expiry] Background re-trigger failed", {
									error: formatError(err),
								}),
							);
						} catch (error) {
							appContext.logger.warn(
								`[expiry] Failed to inject interruption notice for thread ${threadId}`,
								{ error: formatError(error) },
							);
						}
					}
					appContext.logger.info(
						`[expiry] Expired ${expired.length} stale client tool call(s) across ${threadIds.size} thread(s)`,
					);
				}
			} catch (error) {
				appContext.logger.error("[expiry] Scan failed", { error: formatError(error) });
			}
		}, EXPIRY_SCAN_INTERVAL_MS);

		// Cache-warming "warm poke" driver (issue #10). Opt-in via the
		// `cache_warming` block in model_backends.js. Periodically finds active
		// threads whose prompt cache is warm but near expiry and enqueues a
		// tool-less poke wakeup so the next real message lands on a cache-read
		// instead of a cache-write. The poke window is derived per-thread from
		// each thread's backend `cache_ttl`.
		// Pokes only fire from the leader-eligible web host that owns dispatch;
		// each poke is a `cache_warm_poke` notification handled locally with
		// noTools/maxOutputTokens clamping (see runFn above).
		let warmPokeInterval: ReturnType<typeof setInterval> | undefined;
		// Cache-warming is fully per-backend (issue #10): a backend opts in via
		// its own `cache_warming.enabled`. Start the single global driver only if
		// at least one backend opts in; per-thread `resolvePokePolicy` then gates
		// each thread on its own backend's config.
		const warmingEnabled = appContext.config.modelBackends.backends.some(
			(b) => b.cache_warming?.enabled,
		);
		if (warmingEnabled) {
			appContext.logger.info(
				`[warm-poke] Cache-warming driver enabled (scan ${Math.round((scanIntervals?.warmPokeScanIntervalMs ?? WARM_POKE_SCAN_INTERVAL_MS) / 60_000)}m, window ${Math.round(DEFAULT_WARM_POKE_ACTIVE_WINDOW_MS / 3_600_000)}h; per-thread TTL + poke cap derived from each thread's backend)`,
			);
			// Resolve a thread's warm-poke policy from its backend (issue #10):
			// whether the backend opts into warming at all (`cache_warming.enabled`),
			// the cache TTL in ms (from `cache_ttl`), and the per-active-period poke
			// cap (from `cache_warming.max_pokes`). Returns null
			// when the backend doesn't opt in or doesn't cache — nothing to keep
			// warm. Deriving all three per-thread from one model resolution is what
			// lets a single driver serve a mixed cluster correctly: enabled gates
			// per-backend opt-in, TTL handles 5m-vs-1h backends, and the cap handles
			// the dramatically different break-even economics between providers
			// (cap 0 = never warm threads on that backend).
			const resolvePokePolicy = (threadId: string): { ttlMs: number; maxPokes: number } | null => {
				// Warm the model the thread's next turn would run on: a hintless
				// thread follows the cluster default role, and the host's
				// bootstrap backend applies only when that role is unset.
				const hint = resolveThreadModel(appContext.db, threadId, DEFAULT_MODEL_HINT);
				const modelId =
					hint === DEFAULT_MODEL_HINT ? resolveDefaultModelId(appContext.db, modelRouter) : hint;
				const warmCfg = modelRouter.getCacheWarmConfig(modelId);
				if (!warmCfg?.enabled) return null;
				const ttl = modelRouter.getCacheTtl(modelId);
				if (!ttl) return null;
				return { ttlMs: parseDurationMs(ttl), maxPokes: warmCfg.maxPokes };
			};
			const warmPokeScanIntervalMs =
				scanIntervals?.warmPokeScanIntervalMs ?? WARM_POKE_SCAN_INTERVAL_MS;
			warmPokeInterval = setInterval(() => {
				try {
					const targets = selectWarmPokeTargets(appContext.db, {
						resolvePokePolicy,
						scanIntervalMs: warmPokeScanIntervalMs,
						activeWindowMs: DEFAULT_WARM_POKE_ACTIVE_WINDOW_MS,
					});
					for (const threadId of targets) {
						enqueueNotification(appContext.db, threadId, { type: "cache_warm_poke" });
						handleThread(threadId).catch((err) =>
							appContext.logger.warn("[warm-poke] Background poke trigger failed", {
								threadId,
								error: formatError(err),
							}),
						);
					}
					if (targets.length > 0) {
						appContext.logger.info(`[warm-poke] Poked ${targets.length} active thread(s)`);
					}
				} catch (error) {
					appContext.logger.error("[warm-poke] Driver scan failed", {
						error: formatError(error),
					});
				}
			}, warmPokeScanIntervalMs);
		}

		// Clean up on server stop — clear both scan intervals and detach the
		// process-exit listeners that back them. Exposed on ServerResult as
		// `stopScanIntervals` so a caller booting many servers in one process
		// (the test suite) can reclaim the event loop; also fired on real exit.
		const cleanup = () => {
			clearInterval(expiryScanInterval);
			if (warmPokeInterval) clearInterval(warmPokeInterval);
			process.off("exit", cleanup);
			process.off("SIGINT", cleanup);
			process.off("SIGTERM", cleanup);
		};
		scanIntervalStops.push(cleanup);
		process.on("exit", cleanup);
		process.on("SIGINT", cleanup);
		process.on("SIGTERM", cleanup);
	} catch (error) {
		appContext.logger.warn("Web server failed to start", { error: formatError(error) });
		appContext.logger.warn("Continuing without web UI. API will not be available.");
	}

	const platformsResult = appContext.optionalConfig.platforms;
	if (platformsResult?.ok) {
		const platformsConfig = platformsResult.value as import("@bound/shared").PlatformsConfig;

		platformMcpRegistry = new PlatformMcpRegistryClass({
			db: appContext.db,
			siteId: appContext.siteId,
			eventBus: appContext.eventBus,
			logger: appContext.logger,
			hubSiteId,
			routeRelayRequest: (params) =>
				routeRelayRequest(appContext.db, {
					...params,
					topologyRole: resolveTopologyRole(appContext.optionalConfig),
				}),
		});
		appContext.logger.info("[platforms-mcp] MCP registry initialized");

		// Subscriptions run only on the leader (AC6.1, AC6.2).
		const mcpLeaderAdapter = {
			platform: "mcp-platforms",
			delivery: "broadcast" as const,
			async connect() {
				appContext.logger.info(
					"[platforms-mcp] Leader election: connect() — creating Discord servers",
				);

				// Create Discord.js clients and register MCP servers for each connector
				if (platformMcpRegistry) {
					const { setupDiscordServers } = await import("@bound/platforms");
					const { createModelCommandSpec } = await import("@bound/agent");
					// Platform-native commands, handled deterministically on the
					// leader (no inference): /model must work precisely when the
					// current model cannot complete an agent turn.
					const platformCommands = [
						createModelCommandSpec({
							db: appContext.db,
							siteId: appContext.siteId,
							modelRouter,
							logger: appContext.logger,
						}),
					];
					for (const connectorConfig of platformsConfig.connectors) {
						try {
							await setupDiscordServers(
								connectorConfig,
								platformMcpRegistry,
								appContext.logger,
								platformCommands,
							);
						} catch (err) {
							appContext.logger.warn(
								`[platforms-mcp] Could not setup server for '${connectorConfig.platform}': ${err}`,
							);
							// Continue with next connector on error
						}
					}
				}

				// On leadership gain: reconnect all subscriptions from DB (AC6.3 — failover recovery)
				await platformMcpRegistry?.reconnectAll();
				appContext.logger.info("[platforms-mcp] All subscriptions reconnected");

				appContext.eventBus.on("connector:handle_synced", activateSyncedHandle);
			},
			async disconnect() {
				appContext.logger.info(
					"[platforms-mcp] Leader election: disconnect() — stopping subscriptions",
				);
				appContext.eventBus.off("connector:handle_synced", activateSyncedHandle);
				// A non-leader keeps the registry but holds no subscriptions.
				await platformMcpRegistry?.shutdown();
				appContext.logger.info("[platforms-mcp] All subscriptions stopped");
			},
		};

		// Leader-only: activate connector handles that arrive via sync.
		async function activateSyncedHandle({ handle_id }: { handle_id: string }): Promise<void> {
			if (!platformMcpRegistry) return;
			const handle = getConnectorHandle(appContext.db, handle_id);
			if (handle?.task_id) {
				appContext.logger.info("[platforms-mcp] Activating synced handle", {
					handle_id,
					server_name: handle.server_name,
				});
				try {
					await platformMcpRegistry.activateSubscription(handle);
				} catch (err) {
					// The connector permanently rejected this subscription (e.g.
					// a spoke bound a Discord channel the bot can't view — the
					// spoke has no local client, so it couldn't validate at attach
					// time; the leader is the first host that can). Roll the
					// synced handle + task back so the deletion propagates to the
					// spoke rather than leaving a dead subscription that never
					// delivers. A non-rejection error (transient) is logged and
					// left for the next reconnect. Wrapping also prevents an
					// unhandled rejection in this event handler.
					if (isSubscriptionRejected(err)) {
						appContext.logger.warn(
							"[platforms-mcp] Rolling back synced handle: connector rejected subscription",
							{
								handle_id,
								server_name: handle.server_name,
								reason: err instanceof Error ? err.message : String(err),
							},
						);
						softDelete(appContext.db, "connector_handles", handle_id, appContext.siteId);
						softDelete(appContext.db, "tasks", handle.task_id, appContext.siteId);
					} else {
						appContext.logger.error("[platforms-mcp] Failed to activate synced handle", {
							handle_id,
							error: err instanceof Error ? err.message : String(err),
						});
					}
				}
			}
		}

		// Use PlatformLeaderElection to gate subscription management
		// Non-leader hosts have the registry but with no subscriptions (AC6.2)
		if (platformsConfig.connectors.length > 0) {
			const leaderElection = new PlatformLeaderElection(
				mcpLeaderAdapter,
				platformsConfig.connectors[0],
				appContext.db,
				appContext.siteId,
				undefined,
				appContext.logger,
			);
			await leaderElection.start();
			leaderElectionStops.push(() => leaderElection.stop());
			appContext.logger.info("[platforms-mcp] Leader election started");
		} else {
			appContext.logger.info("[platforms-mcp] No connectors configured, skipping leader election");
		}

		// Collect platform names from MCP registry (AC6.5)
		const platformNames = platformMcpRegistry.getServerNames();

		// AC7.3
		relayProcessor.setPlatformMcpRegistry(platformMcpRegistry);
		appContext.logger.info("[platforms-mcp] Relay processor wired");

		// Create connector tool for user-facing threads (message handler path)
		const connectorCtx: ConnectorToolContext = {
			registry: platformMcpRegistry,
			db: appContext.db,
			siteId: appContext.siteId,
			remotePlatformRequest: createRemotePlatformRequest(appContext),
			logger: appContext.logger,
		};
		connectorTool = createPlatformConnectorTool(connectorCtx);
		appContext.logger.info("[platforms-mcp] Connector tool created");

		// Surface remote platform connectors' read-only tools to local agents.
		// The relay proxy used by the registry IS the same one wired into the
		// connector tool above — single relay path for events/list, tools/list,
		// and tools/call. Without this, hosts with no local platforms get only
		// the bare `connector` tool and can't reach things like
		// discord_list_channels on the host that owns the Discord connector.
		if (connectorCtx.remotePlatformRequest) {
			platformMcpRegistry.setRemotePlatformRequest(connectorCtx.remotePlatformRequest);
			// Eager initial discovery — fire-and-forget so startup isn't blocked
			// on a remote relay round-trip (which has a 15s timeout per call).
			// Errors are logged inside discoverRemoteTools().
			platformMcpRegistry.discoverRemoteTools().catch((error) => {
				appContext.logger.warn("[platforms-mcp] Initial remote tool discovery failed", {
					error: formatError(error),
				});
			});
			// Periodic refresh: picks up new remote platforms that came online
			// after our daemon started, and drops tools whose host went away.
			// 60s is a tradeoff between pickup latency and relay traffic — a
			// remote daemon advertising a new tool will be visible within one
			// cycle.
			const remoteRefreshInterval = setInterval(() => {
				platformMcpRegistry?.discoverRemoteTools().catch((error) => {
					appContext.logger.warn("[platforms-mcp] Remote tool refresh failed", {
						error: formatError(error),
					});
				});
			}, 60_000);
			const clearRemoteRefresh = () => {
				clearInterval(remoteRefreshInterval);
				process.off("exit", clearRemoteRefresh);
				process.off("SIGINT", clearRemoteRefresh);
				process.off("SIGTERM", clearRemoteRefresh);
			};
			scanIntervalStops.push(clearRemoteRefresh);
			process.on("exit", clearRemoteRefresh);
			process.on("SIGINT", clearRemoteRefresh);
			process.on("SIGTERM", clearRemoteRefresh);

			// Eager discovery at the connector-sync boundary (§7): when a connector
			// handle syncs in, re-discover remote tools immediately rather than
			// waiting up to 60s for the next periodic refresh. This runs on EVERY
			// host (not just the platform leader) — any host may run a loop that
			// references a remote platform tool by name, and assembly must see that
			// tool's definition wherever the loop lands (R-UD1).
			appContext.eventBus.on("connector:handle_synced", () => {
				platformMcpRegistry?.discoverRemoteTools().catch((error) => {
					appContext.logger.warn("[platforms-mcp] handle_synced remote tool discovery failed", {
						error: formatError(error),
					});
				});
			});
		}

		// Advertise platform names in hosts.platforms for relay platform affinity routing.
		// Clear to null when empty so stale synced values don't persist.
		if (platformNames.length > 0) {
			updateRow(
				appContext.db,
				"hosts",
				appContext.siteId,
				{ platforms: JSON.stringify(platformNames) },
				appContext.siteId,
			);
			appContext.logger.info(`[platforms] Advertised platforms: ${platformNames.join(", ")}`);
		} else {
			updateRow(appContext.db, "hosts", appContext.siteId, { platforms: null }, appContext.siteId);
		}
	} else {
		appContext.logger.info("[platforms] Not configured (no platforms.json)");
	}

	// RSS feed poller — the pull-side counterpart of webhook ingestion.
	// Runs its own leader election (platform_leader:rss) independent of the
	// Discord connectors block above, so feeds poll even on clusters with no
	// platforms.json. Exactly one host walks the feeds; dedup state
	// (rss_feeds.seen_guids) is synced, so failover resumes without
	// re-delivering the backlog. Items land as passive `rss_intake` durable
	// work rows and ride the same connector:event → scheduler →
	// buildEventWakeupContent track as webhooks.
	{
		const rssPoller = new RssPoller({
			db: appContext.db,
			siteId: appContext.siteId,
			eventBus: appContext.eventBus,
			logger: appContext.logger,
		});
		const rssLeaderElection = new PlatformLeaderElection(
			{
				platform: "rss",
				connect: () => rssPoller.connect(),
				disconnect: () => rssPoller.disconnect(),
			},
			{
				platform: "rss",
				allowed_users: [],
				leadership: "auto",
				failover_threshold_ms: 30_000,
			},
			appContext.db,
			appContext.siteId,
			undefined,
			appContext.logger,
		);
		await rssLeaderElection.start();
		appContext.logger.info("[rss] Poller leader election started");
		const stopRss = () => rssLeaderElection.stop();
		leaderElectionStops.push(stopRss);
		process.on("exit", stopRss);
		process.on("SIGINT", stopRss);
		process.on("SIGTERM", stopRss);
	}

	return {
		webServer,
		syncServer,
		statusForwardCache,
		threadExecutor,
		platformMcpRegistry,
		handleMessageTracker,
		stopLeaderElections,
		stopScanIntervals,
		wsTransportHolder,
	};
}
