/**
 * Server subsystem: web server creation, message:created handler wiring,
 * delegation logic, and platform connector initialization.
 */

import type { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import {
	HandleMessageTracker,
	createRelayOutboxEntry,
	generateThreadTitle,
	getDelegationTarget,
	runIntrospectResponseStamp,
} from "@bound/agent";
import type { AgentLoop, AgentLoopConfig } from "@bound/agent";
import type { AppContext } from "@bound/core";
import {
	type DispatchEntry,
	ThreadExecutor,
	acknowledgeBatch,
	claimPending,
	enqueueMessage,
	enqueueNotification,
	expireClientToolCalls,
	findFreshPlatformHost,
	hasPendingClientToolCalls,
	insertRow,
	markProcessed,
	readInboxByRefId,
	updateRow,
	writeMessageMetadata,
	writeOutbox,
} from "@bound/core";
import type { ModelBackendsConfig, ModelRouter } from "@bound/llm";
import type { PlatformMcpRegistry, PlatformRegisteredTool } from "@bound/platforms";
import {
	type ConnectorToolContext,
	PlatformLeaderElection,
	PlatformMcpRegistry as PlatformMcpRegistryClass,
	createConnectorTool,
	getConnectorHandle,
} from "@bound/platforms";
import type { ClusterFsResult } from "@bound/sandbox";
import type { KeyringConfig, Logger, ProcessPayload, StatusForwardPayload } from "@bound/shared";
import {
	BOUND_NAMESPACE,
	deterministicUUID,
	extractTraceContext,
	formatError,
	injectTraceContext,
	isUserFacingInterface,
	parseJsonSafe,
	resultPayloadSchema,
} from "@bound/shared";
import type { KeyManager, RelayExecutor } from "@bound/sync";
import { createSyncServer, createWebServer } from "@bound/web";
import { SpanStatusCode, context, trace } from "@opentelemetry/api";
import { resolveThreadModel, runLocalAgentLoop } from "../../lib/message-handler";

export type AgentLoopFactory = (config: AgentLoopConfig) => AgentLoop;

const getTracer = () => trace.getTracer("bound.web");

/**
 * Format a notification payload as a human-readable message for the agent.
 *
 * `proactive` and `introspect` payloads carry agent-authored free-text
 * `content` from a sibling thread — the calling agent's narrative
 * description of state. The bridge wraps the resulting `developer`
 * message in `<system-context>...</system-context>`, so without an
 * explicit provenance signal the receiving agent reads its sibling's
 * narrative as authoritative system state and primes diagnoses on the
 * phrasing rather than on ground truth (live evidence: 2026-05-17
 * incident, where the agent built a full dedup fix from a notify
 * payload's "byte-different content + 1 notify fallback" phrase
 * before discovering the real bug was in the LLM bridge layer).
 *
 * For these two payload kinds, the prefix marks the content as
 * agent-authored and unverified so the receiving agent treats it as
 * a past assertion to verify against source thread tool_results /
 * messages, not as system fact. `task_complete` and `advisory_created`
 * are system-generated payloads (the runtime produces their fields
 * from real DB state) so they keep the simpler `[notification]` shape.
 */
export function formatNotification(payload: Record<string, unknown>): string {
	switch (payload.type) {
		case "task_complete":
			return `[notification] Task "${payload.task_name}" completed. Result: ${payload.result ?? "success"}`;
		case "advisory_created":
			return `[notification] New advisory: ${payload.title ?? "Untitled"}. ${payload.detail ?? ""}`.trim();
		case "proactive":
			return `[notification from background task — agent-authored summary, unverified; verify against source thread before relying] ${payload.content ?? ""}`.trim();
		case "introspect":
			return `[introspect request from thread ${payload.source_thread ?? "unknown"} — agent-authored framing, unverified; verify against source thread before relying] ${payload.content ?? ""}`.trim();
		default:
			return `[notification] ${JSON.stringify(payload)}`;
	}
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
	 * The message_id that must be placed in ProcessPayload when delegating
	 * the loop to a remote host. Always references a real row in `messages`.
	 *
	 * Preference order (highest wins):
	 * 1. A non-notification claim (user / tool_result — dispatch entry id
	 *    already equals the messages.id).
	 * 2. The id of the last notification this call injected into messages.
	 * 3. Empty string (no claims — caller should not delegate).
	 */
	delegationMessageId: string;
	/** IDs of newly inserted notification messages, in insertion order. */
	insertedMessageIds: string[];
}

/**
 * Inject any claimed notification entries into the messages table and return
 * the message_id that should flow through ProcessPayload when delegating.
 *
 * Historically handleThread passed `claimedIds[0]` — the dispatch_queue entry
 * id — into ProcessPayload.message_id. That is correct for user-message
 * entries (enqueueMessage stores the real messages.id as message_id) but
 * wrong for notifications, whose dispatch_queue entry id is a synthetic UUID
 * generated by enqueueNotification. The receiving host's executeProcess then
 * fails its `SELECT * FROM messages WHERE id = ?` guard and responds with
 * "Message not found", silently dropping the notification.
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
				const payload = JSON.parse(entry.event_payload) as Record<string, unknown>;
				const notifText = formatNotification(payload);
				const now = new Date().toISOString();
				// Use a fresh UUID — the dispatch entry message_id may already
				// exist in messages from a prior retry (yield → reclaim cycle),
				// causing a PK collision.
				const messageId = randomUUID();
				insertRow(
					db,
					"messages",
					{
						id: messageId,
						thread_id: threadId,
						// Invariant #19: role='system' is reserved for the LLM driver layer.
						// Injected system-generated context uses role='developer' so it
						// survives Stage 2.5 of context assembly and reaches the agent.
						role: "developer",
						content: notifText,
						model_id: null,
						tool_name: null,
						created_at: now,
						modified_at: now,
						host_origin: hostName,
						deleted: 0,
						exit_code: null,
						metadata: null,
					},
					siteId,
				);
				// For introspect notifications, write correlation ID to metadata
				if (payload.type === "introspect" && typeof payload.correlation_id === "string") {
					writeMessageMetadata(db, messageId, { introspect_id: payload.correlation_id }, siteId);
				}
				insertedMessageIds.push(messageId);
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

/**
 * Re-export `isUserFacingInterface` for backward compatibility with existing
 * imports (notably the unit test). The single source of truth lives in
 * `@bound/shared`.
 */
export { isUserFacingInterface };

export interface ServerResult {
	webServer: Awaited<ReturnType<typeof createWebServer>> | null;
	syncServer: Awaited<ReturnType<typeof createSyncServer>> | null;
	statusForwardCache: Map<string, StatusForwardPayload>;
	activeDelegations: Map<string, { targetSiteId: string; processOutboxId: string }>;
	threadExecutor: ThreadExecutor;
	platformMcpRegistry: PlatformMcpRegistry | null;
	handleMessageTracker: HandleMessageTracker;
	wsTransportHolder: {
		addPeer: (
			siteId: string,
			sendFrame: (frame: Uint8Array) => boolean,
			symmetricKey: Uint8Array,
		) => void;
		removePeer: (siteId: string) => void;
		handleChangelogPush: (siteId: string, payload: Record<string, unknown>) => void;
		handleChangelogAck: (siteId: string, payload: Record<string, unknown>) => void;
		drainChangelog: (siteId: string) => void;
		handleRelaySend: (sourceSiteId: string, payload: Record<string, unknown>) => void;
		handleRelayAck: (sourceSiteId: string, payload: Record<string, unknown>) => void;
		drainRelayInbox: (siteId: string) => void;
		seedNewPeer: (siteId: string) => void;
		handleSnapshotAck: (siteId: string, payload: unknown) => void;
		continueSnapshotSeed: (siteId: string) => void;
		applySnapshotChunk: (tableName: string, rows: Array<Record<string, unknown>>) => number;
		handleReseedRequest: (siteId: string, payload: unknown) => void;
		handleConsistencyRequest: (siteId: string, payload: unknown) => void;
		requestConsistency: (
			tables: string[],
		) => Promise<Map<string, { count: number; pks: string[] }>>;
		handleRowPullRequest: (siteId: string, payload: unknown) => void;
		handleRowPullAck: (siteId: string, payload: unknown) => void;
		continueRowPull: (siteId: string) => void;
		continueConsistencyStream: (siteId: string) => void;
	};
}

export interface ServerDeps {
	appContext: AppContext;
	modelRouter: ModelRouter;
	routerConfig: ModelBackendsConfig;
	agentLoopFactory: AgentLoopFactory;
	relayExecutor: RelayExecutor | undefined;
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
	};
}

export async function initServer(deps: ServerDeps): Promise<ServerResult> {
	const {
		appContext,
		modelRouter,
		routerConfig,
		agentLoopFactory,
		relayExecutor,
		keyManager,
		keyring,
		hubSiteId,
		clusterFsObj,
		relayProcessor,
	} = deps;

	// Wire the factory into the relay processor so process relays run with full sandbox + tools.
	relayProcessor.setAgentLoopFactory(agentLoopFactory);

	// 12. Web + sync servers
	appContext.logger.info("Starting servers...");
	let webServer: Awaited<ReturnType<typeof createWebServer>> | null = null;
	let syncServer: Awaited<ReturnType<typeof createSyncServer>> | null = null;
	const statusForwardCache = new Map<string, StatusForwardPayload>();
	const activeDelegations = new Map<string, { targetSiteId: string; processOutboxId: string }>();
	const threadExecutor = new ThreadExecutor(appContext.db, appContext.logger);
	const handleMessageTracker = new HandleMessageTracker();
	handleMessageTracker.startWatchdog();

	// `maybeCloseTurnIfIdle` lives on the tracker — it's the close-condition
	// counterpart to `openTurn`/`closeTurn` and shares the dispatch_queue
	// semantics, so co-locating keeps invariants discoverable. See
	// `packages/agent/src/handle-message-tracker.ts` and the integration test
	// `handle-message-tracker.integration.test.ts` for the lifecycle contract.

	// Mutable holder for wsTransport (populated in Phase 8 after sync init)
	const wsTransportHolder: ServerResult["wsTransportHolder"] = {
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
		handleConsistencyRequest: () => {},
		requestConsistency: async () => new Map(),
		handleRowPullRequest: () => {},
		handleRowPullAck: () => {},
		continueRowPull: () => {},
		continueConsistencyStream: () => {},
	};

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

		// Sync server: primary port, externally accessible for hub-spoke replication
		const syncPort = Number.parseInt(process.env.PORT || "3000", 10);
		const syncHost = process.env.BIND_HOST ?? "localhost";

		// Web server: internal management interface
		const webPort = Number.parseInt(process.env.WEB_PORT || "3001", 10);
		const webHost = process.env.WEB_BIND_HOST ?? "localhost";

		// Deduplicate models by ID — pooled backends (same ID, multiple providers)
		// should appear as a single entry. Use the first provider for display.
		const seenIds = new Set<string>();
		const uniqueModels: Array<{ id: string; provider: string }> = [];
		for (const b of modelBackends.backends) {
			if (!seenIds.has(b.id)) {
				seenIds.add(b.id);
				uniqueModels.push({ id: b.id, provider: b.provider });
			}
		}

		const operatorUserId = deterministicUUID(
			BOUND_NAMESPACE,
			appContext.config.allowlist.default_web_user,
		);

		webServer = await createWebServer(appContext.db, appContext.eventBus, {
			port: webPort,
			host: webHost,
			hostName: appContext.hostName,
			operatorUserId,
			models: {
				models: uniqueModels,
				default: modelBackends.default,
			},
			backendPricing: modelBackends.backends.map((b) => ({
				id: b.id,
				price_per_m_input: b.price_per_m_input,
				price_per_m_output: b.price_per_m_output,
				price_per_m_cache_read: b.price_per_m_cache_read,
				price_per_m_cache_write: b.price_per_m_cache_write,
			})),
			siteId: appContext.siteId,
			// Sync server config — forwarded to the webhooks route so it can
			// enumerate the local webhook delivery URL alongside any cluster
			// peers' URLs (#36). Webhook ingestion is on the sync port.
			syncBindHost: syncHost,
			syncPort,
			hubUrl: ((): string | undefined => {
				const cfg = appContext.optionalConfig.sync;
				if (!cfg?.ok) return undefined;
				const hub = (cfg.value as { hub?: unknown }).hub;
				return typeof hub === "string" && hub.length > 0 ? hub : undefined;
			})(),
			statusForwardCache,
			activeDelegations,
			activeLoops: threadExecutor.activeThreads as Set<string>,
			requestConsistency: (tables: string[]) => wsTransportHolder.requestConsistency(tables),
			handleMessageTracker,
			clusterFs: clusterFsObj?.fs ?? null,
		});
		await webServer.start();

		// Capture connection registry from web server for client tool lookup in handleThread
		const wsRegistry = webServer?.wsRegistry;

		// Start sync server if sync prerequisites are available
		if (appContext.siteId && keyring && appContext.logger) {
			// Read WS config if present
			const syncConfigResult = appContext.optionalConfig.sync;
			const wsConfig = (
				syncConfigResult?.ok ? (syncConfigResult.value as Record<string, unknown>).ws : undefined
			) as Record<string, unknown> | undefined;

			syncServer = await createSyncServer(appContext.db, appContext.eventBus, {
				port: syncPort,
				host: syncHost,
				siteId: appContext.siteId,
				keyring,
				logger: appContext.logger,
				relayExecutor,
				hubSiteId,
				keyManager,
				wsConfig: wsConfig
					? {
							idleTimeout: (wsConfig.idle_timeout as number) ?? 120,
							backpressureLimit: (wsConfig.backpressure_limit as number) ?? 2097152,
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

		// Helper: count messages in thread
		const getThreadMessageCount = (threadId: string): number => {
			const result = appContext.db
				.query("SELECT COUNT(*) as count FROM messages WHERE thread_id = ? AND deleted = 0")
				.get(threadId) as { count: number } | null;
			return result?.count ?? 0;
		};

		// Helper: dispatch delegation to remote host
		const dispatchDelegation = async (
			targetHost: ReturnType<typeof getDelegationTarget>,
			threadId: string,
			messageId: string,
			userId: string,
			traceContext?: string,
		): Promise<void> => {
			if (!targetHost) return;

			const processPayload: ProcessPayload = {
				thread_id: threadId,
				message_id: messageId,
				user_id: userId,
				platform: null, // null = web UI delegation
			};
			const outboxEntry = createRelayOutboxEntry(
				targetHost.site_id,
				appContext.siteId,
				"process",
				JSON.stringify(processPayload),
				5 * 60 * 1000, // 5 minute timeout for delegated loop
				undefined,
				undefined,
				undefined,
				traceContext,
			);
			writeOutbox(appContext.db, outboxEntry);
			activeDelegations.set(threadId, {
				targetSiteId: targetHost.site_id,
				processOutboxId: outboxEntry.id,
			});

			// Poll until new assistant message appears in thread (loop completed on remote)
			const POLL_INTERVAL_MS = 1000;
			const TIMEOUT_MS = 5 * 60 * 1000;
			const startTime = Date.now();
			const initialMessageCount = getThreadMessageCount(threadId);

			while (true) {
				if (Date.now() - startTime > TIMEOUT_MS) {
					appContext.logger.warn("Delegation timeout — no response received", {
						threadId,
					});
					break;
				}
				const currentCount = getThreadMessageCount(threadId);
				if (currentCount > initialMessageCount) break; // Response arrived via sync

				await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
			}

			activeDelegations.delete(threadId);
		};

		// handleThread delegates to the shared ThreadExecutor.
		// The executor owns the thread-exclusive lock and drain loop.
		const handleThread = async (thread_id: string, traceContext?: string) => {
			if (!modelRouter) {
				appContext.logger.warn("[agent] No model router configured, cannot process message");
				return;
			}

			const needsRetrigger = await threadExecutor.execute(
				thread_id,
				// runFn: claim → inject notification messages → resolve model → run inference
				async (shouldYield) => {
					const claimed = claimPending(appContext.db, thread_id, appContext.siteId);
					if (claimed.length === 0) return {};

					const claimedIds = claimed.map((e) => e.message_id);

					try {
						// Inject notification context as system messages so the agent
						// can see and respond to non-user events (task completions, etc.)
						// The helper also picks the ProcessPayload.message_id we forward
						// on delegation — it MUST reference a real `messages` row or the
						// remote host's executeProcess() bails with "Message not found".
						const { delegationMessageId } = resolveDelegationMessageId({
							db: appContext.db,
							siteId: appContext.siteId,
							hostName: appContext.hostName,
							threadId: thread_id,
							claimed,
							logger: appContext.logger,
						});

						// Resolve the model for this thread from the authoritative
						// threads.model_hint column (set by /model command or web UI).
						// Falls back to the node's default when model_hint is NULL.
						const activeModelId = resolveThreadModel(
							appContext.db,
							thread_id,
							routerConfig.default,
						);

						const delegationTarget = getDelegationTarget(
							appContext.db,
							thread_id,
							activeModelId,
							modelRouter,
							appContext.siteId,
						);

						const threadRow = appContext.db
							.query("SELECT user_id, interface FROM threads WHERE id = ?")
							.get(thread_id) as { user_id: string; interface: string } | null;
						const userId = threadRow?.user_id || operatorUserId;

						// `agent.handle-message` and `web.handle-message` wrap BOTH the
						// delegation path and the local-loop path so the whole logical
						// cycle lives on one trace regardless of where inference runs.
						// Computed outside the branches so the span is open before the
						// first decision the handler makes.
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

						if (delegationTarget) {
							appContext.logger.info(
								`[agent] Delegating to remote host ${delegationTarget.site_id}`,
							);
							const tracer = getTracer();
							const rootSpan = tracer.startSpan(
								"web.handle-message",
								{
									attributes: {
										"thread.id": thread_id,
										"user.id": userId,
										"message.id": claimedIds[0] ?? "",
										"agent.execution": "delegated",
										"agent.delegate.site_id": delegationTarget.site_id,
									},
								},
								turnCtx,
							);
							try {
								await context.with(trace.setSpan(turnCtx, rootSpan), async () => {
									// Inject the W3C trace context with web.handle-message
									// active so the relay outbox carries our traceparent
									// to the remote host. The remote `relay.execute-process`
									// span re-exports under us via reExportSpans.
									const carrier = injectTraceContext();
									const carrierStr = carrier ? JSON.stringify(carrier) : undefined;
									await dispatchDelegation(
										delegationTarget,
										thread_id,
										delegationMessageId,
										userId,
										carrierStr,
									);
								});
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
						} else {
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

							// Resolve platform tools using two-branch model:
							// - Event task threads: scoped to their bound server's full tool set
							// - All other threads: read-only platform tools + connector tool
							let platformTools: PlatformRegisteredTool[] | undefined;
							if (platformMcpRegistry) {
								const scopedTools = platformMcpRegistry.getToolsForThread(thread_id);
								if (scopedTools.size > 0) {
									platformTools = Array.from(scopedTools.values());
								} else {
									const readOnlyTools = Array.from(
										platformMcpRegistry.getReadOnlyPlatformTools().values(),
									);
									if (connectorTool) {
										platformTools = [...readOnlyTools, connectorTool];
									} else if (readOnlyTools.length > 0) {
										platformTools = readOnlyTools;
									}
								}
							}

							// Resolve client tools from WS connections subscribed to this thread
							const clientToolsFromRegistry = wsRegistry?.getClientToolsForThread(thread_id);
							const resolvedClientTools =
								clientToolsFromRegistry && clientToolsFromRegistry.size > 0
									? clientToolsFromRegistry
									: undefined;
							const firstToolName = resolvedClientTools
								? clientToolsFromRegistry?.keys().next().value
								: undefined;
							const resolvedConnectionId = firstToolName
								? wsRegistry?.getConnectionForTool(thread_id, firstToolName)
								: undefined;
							const systemPromptAddition = wsRegistry?.getSystemPromptAdditionForThread(thread_id);

							// Emit "thinking" status so WebSocket clients (TUI) show thinking indicator
							appContext.eventBus.emit("status:forward", {
								thread_id: thread_id,
								status: "thinking",
								tokens: 0,
								detail: null,
							});

							// Capture turn boundary for metrics recording and context tracking.
							const turnStartAt = new Date().toISOString();

							// `agent.handle-message` and the open/resume logic are
							// hoisted above the if/else so they cover both delegation
							// and local-loop branches. `turnCtx` is captured outside
							// and reused here.
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
										handleMessageTracker,
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
						acknowledgeBatch(appContext.db, claimedIds);
						handleMessageTracker.maybeCloseTurnIfIdle(appContext.db, thread_id, "ok");
						return { claimedIds };
					} catch (error) {
						appContext.logger.error(`[agent] Error: ${formatError(error)}`);
						try {
							acknowledgeBatch(appContext.db, claimedIds);
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
				// Use setImmediate to avoid holding the current call stack
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
			const task = appContext.db
				.query("SELECT id, name, thread_id FROM tasks WHERE id = ? AND deleted = 0")
				.get(task_id) as { id: string; name: string; thread_id: string | null } | null;

			if (!task?.thread_id) return; // No thread to notify

			const notificationPayload = {
				type: "task_complete",
				task_id: task.id,
				task_name: task.name,
				result: result ?? "completed",
			};

			enqueueNotification(appContext.db, task.thread_id, notificationPayload);
			handleThread(task.thread_id).catch((err) =>
				appContext.logger.error("[notification] Task completion dispatch error", {
					error: formatError(err),
				}),
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
			.prepare(`SELECT DISTINCT thread_id FROM dispatch_queue WHERE status = 'pending'`)
			.all() as Array<{ thread_id: string }>;
		for (const { thread_id } of pendingThreads) {
			appContext.logger.info(`[recovery] Re-dispatching pending messages for thread ${thread_id}`);
			handleThread(thread_id).catch((err) =>
				appContext.logger.error("[recovery] Unhandled dispatch error", { error: formatError(err) }),
			);
		}

		// Task 1: Periodic TTL-based expiry scan for stale client tool calls
		const CLIENT_TOOL_CALL_TTL_MS = 5 * 60 * 1000; // 5 minutes default
		const EXPIRY_SCAN_INTERVAL_MS = 60 * 1000; // Scan every 60 seconds

		const expiryScanInterval = setInterval(() => {
			try {
				const expired = expireClientToolCalls(appContext.db, CLIENT_TOOL_CALL_TTL_MS);
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

		// Clean up on server stop — store interval ID for cleanup
		const cleanup = () => {
			clearInterval(expiryScanInterval);
		};
		process.on("exit", cleanup);
		process.on("SIGINT", cleanup);
		process.on("SIGTERM", cleanup);
	} catch (error) {
		appContext.logger.warn("Web server failed to start", { error: formatError(error) });
		appContext.logger.warn("Continuing without web UI. API will not be available.");
	}

	// 13. Platform connectors (if configured)
	const platformsResult = appContext.optionalConfig.platforms;
	if (platformsResult?.ok) {
		const platformsConfig = platformsResult.value as import("@bound/shared").PlatformsConfig;

		// TASK 1: Bootstrap PlatformMcpRegistry
		platformMcpRegistry = new PlatformMcpRegistryClass({
			db: appContext.db,
			siteId: appContext.siteId,
			eventBus: appContext.eventBus,
			logger: appContext.logger,
			hubSiteId,
		});
		appContext.logger.info("[platforms-mcp] MCP registry initialized");

		// TASK 2: Integrate leader election with MCP server instantiation
		// Create adapter that wraps registry operations for the connector interface
		// The adapter gates subscription reconnection behind leader election (AC6.1, AC6.2)
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
					for (const connectorConfig of platformsConfig.connectors) {
						try {
							await setupDiscordServers(connectorConfig, platformMcpRegistry, appContext.logger);
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

				// Listen for new connector handles arriving via sync — activate immediately
				appContext.eventBus.on("connector:handle_synced", async ({ handle_id }) => {
					if (!platformMcpRegistry) return;
					const handle = getConnectorHandle(appContext.db, handle_id);
					if (handle?.task_id) {
						appContext.logger.info("[platforms-mcp] Activating synced handle", {
							handle_id,
							server_name: handle.server_name,
						});
						await platformMcpRegistry.activateSubscription(handle);
					}
				});
			},
			async disconnect() {
				appContext.logger.info(
					"[platforms-mcp] Leader election: disconnect() — stopping subscriptions",
				);
				// On leadership loss: tear down all subscriptions (non-leader has empty registry)
				await platformMcpRegistry?.shutdown();
				appContext.logger.info("[platforms-mcp] All subscriptions stopped");
			},
		};

		// Use PlatformLeaderElection to gate subscription management
		// Non-leader hosts have the registry but with no subscriptions (AC6.2)
		if (platformsConfig.connectors.length > 0) {
			const leaderElection = new PlatformLeaderElection(
				mcpLeaderAdapter,
				platformsConfig.connectors[0],
				appContext.db,
				appContext.siteId,
			);
			await leaderElection.start();
			appContext.logger.info("[platforms-mcp] Leader election started");
		} else {
			appContext.logger.info("[platforms-mcp] No connectors configured, skipping leader election");
		}

		// Collect platform names from MCP registry (AC6.5)
		const platformNames = platformMcpRegistry.getServerNames();

		// TASK 3: Wire relay processor to use new registry (AC7.3)
		relayProcessor.setPlatformMcpRegistry(platformMcpRegistry);
		appContext.logger.info("[platforms-mcp] Relay processor wired");

		// Create connector tool for user-facing threads (message handler path)
		const connectorCtx: ConnectorToolContext = {
			registry: platformMcpRegistry,
			db: appContext.db,
			siteId: appContext.siteId,
			remotePlatformRequest: async (
				serverName: string,
				method: string,
				params: Record<string, unknown>,
			): Promise<unknown> => {
				// Pick a *fresh* remote host (heartbeat within stale threshold) that
				// advertises this platform. Filtering on freshness here is what
				// turns the failure mode of "remote daemon crashed silently" from
				// a 15s relay timeout into an immediate descriptive error.
				const targetSiteId = findFreshPlatformHost(appContext.db, serverName, appContext.siteId);
				if (!targetSiteId) {
					throw new Error(
						`No fresh remote host found for platform server '${serverName}' (no advertising peer has heart-beated within the stale threshold)`,
					);
				}

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
		connectorTool = {
			kind: "platform" as const,
			toolDefinition: rawConnectorTool.toolDefinition,
			execute: rawConnectorTool.execute,
			idempotent: rawConnectorTool.idempotent,
			readOnly: rawConnectorTool.readOnly,
			resolveAnnotations: rawConnectorTool.resolveAnnotations,
		};
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
			// cycle. Cleared on shutdown via the existing process listeners.
			const remoteRefreshInterval = setInterval(() => {
				platformMcpRegistry?.discoverRemoteTools().catch((error) => {
					appContext.logger.warn("[platforms-mcp] Remote tool refresh failed", {
						error: formatError(error),
					});
				});
			}, 60_000);
			const clearRemoteRefresh = () => clearInterval(remoteRefreshInterval);
			process.on("exit", clearRemoteRefresh);
			process.on("SIGINT", clearRemoteRefresh);
			process.on("SIGTERM", clearRemoteRefresh);
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

	return {
		webServer,
		syncServer,
		statusForwardCache,
		activeDelegations,
		threadExecutor,
		platformMcpRegistry,
		handleMessageTracker,
		wsTransportHolder,
	};
}
