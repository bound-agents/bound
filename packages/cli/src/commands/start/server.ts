/**
 * Server subsystem: web server creation, message:created handler wiring,
 * delegation logic, and platform connector initialization.
 */

import {
	createRelayOutboxEntry,
	generateThreadTitle,
	getDelegationTarget,
} from "@bound/agent";
import type { AgentLoop, AgentLoopConfig } from "@bound/agent";
import type { AppContext } from "@bound/core";
import {
	acknowledgeBatch,
	claimPending,
	enqueueMessage,
	hasPending,
	pruneAcknowledged,
	updateRow,
	writeOutbox,
} from "@bound/core";
import type { ModelBackendsConfig, ModelRouter } from "@bound/llm";
import type { KeyringConfig, ProcessPayload, StatusForwardPayload } from "@bound/shared";
import { BOUND_NAMESPACE, deterministicUUID, formatError } from "@bound/shared";
import type { KeyManager, RelayExecutor, SyncTransport } from "@bound/sync";
import type { ReachabilityTracker } from "@bound/sync";
import { createWebServer } from "@bound/web";
import { runLocalAgentLoop } from "../../lib/message-handler";

export type AgentLoopFactory = (config: AgentLoopConfig) => AgentLoop;

export interface ServerResult {
	webServer: Awaited<ReturnType<typeof createWebServer>> | null;
	statusForwardCache: Map<string, StatusForwardPayload>;
	activeDelegations: Map<string, { targetSiteId: string; processOutboxId: string }>;
	activeLoops: Set<string>;
	platformRegistry: {
		start(): void;
		stop(): void;
		notifyLoopComplete?(threadId: string): void;
	} | null;
}

export interface ServerDeps {
	appContext: AppContext;
	keypair: { privateKey: CryptoKey };
	modelRouter: ModelRouter;
	routerConfig: ModelBackendsConfig;
	agentLoopFactory: AgentLoopFactory;
	relayExecutor: RelayExecutor | undefined;
	reachabilityTracker: ReachabilityTracker;
	keyManager: KeyManager | undefined;
	keyring: KeyringConfig | undefined;
	hubSiteId: string | undefined;
	/** Lazy reference to SyncTransport (initialized later in sync phase). */
	getTransport: () => SyncTransport | undefined;
	/** RelayProcessor to wire platform connector registry into. */
	relayProcessor: {
		setPlatformConnectorRegistry(registry: unknown): void;
		setAgentLoopFactory(factory: AgentLoopFactory): void;
	};
}

export async function initServer(deps: ServerDeps): Promise<ServerResult> {
	const {
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
		getTransport,
		relayProcessor,
	} = deps;

	// Wire the factory into the relay processor so process relays run with full sandbox + tools.
	relayProcessor.setAgentLoopFactory(agentLoopFactory);

	// 12. Web server
	appContext.logger.info("Starting web server...");
	let webServer: Awaited<ReturnType<typeof createWebServer>> | null = null;
	const statusForwardCache = new Map<string, StatusForwardPayload>();
	const activeDelegations = new Map<string, { targetSiteId: string; processOutboxId: string }>();
	const activeLoops = new Set<string>();

	// Platform registry — declared here so message:created handler can reference it,
	// populated in the platform connectors section below.
	let platformRegistry: ServerResult["platformRegistry"] = null;

	try {
		const modelBackends = appContext.config.modelBackends;

		const eagerPushConfig =
			keyring && appContext.siteId
				? {
						privateKey: keypair.privateKey,
						siteId: appContext.siteId,
						db: appContext.db,
						keyring,
						reachabilityTracker,
						logger: appContext.logger,
						get transport() {
							return getTransport();
						},
					}
				: undefined;

		const webPort = Number.parseInt(process.env.PORT || "3000", 10);
		const webHost = process.env.BIND_HOST ?? "localhost";
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
			keyring,
			siteId: appContext.siteId,
			logger: appContext.logger,
			relayExecutor,
			hubSiteId,
			eagerPushConfig,
			statusForwardCache,
			activeDelegations,
			activeLoops,
			keyManager,
		});
		await webServer.start();

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
				"process",
				JSON.stringify(processPayload),
				5 * 60 * 1000, // 5 minute timeout for delegated loop
			);
			writeOutbox(appContext.db, outboxEntry);
			activeDelegations.set(threadId, {
				targetSiteId: targetHost.site_id,
				processOutboxId: outboxEntry.id,
			});
			appContext.eventBus.emit("sync:trigger", { reason: "delegation" });

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

		// Single-owner drain loop: one inference owner per thread.
		// Loops claimPending → run inference → acknowledge → repeat until queue empty.
		// Messages arriving during inference are picked up on the next iteration.
		const handleThread = async (thread_id: string) => {
			if (!modelRouter) {
				appContext.logger.warn("[agent] No model router configured, cannot process message");
				return;
			}
			// Thread-exclusive lock — if already held, return.
			// The active loop will pick up new messages on its next iteration.
			if (activeLoops.has(thread_id)) return;
			activeLoops.add(thread_id);

			try {
				// Drain loop: keep processing until no pending messages remain
				while (true) {
					const claimed = claimPending(appContext.db, thread_id, appContext.siteId);
					if (claimed.length === 0) break; // queue drained, done

					const claimedIds = claimed.map((e) => e.message_id);

					try {
						// Resolve model from the most recent claimed message, or use default
						const lastClaimedMsg = appContext.db
							.prepare("SELECT model_id FROM messages WHERE id = ?")
							.get(claimed[claimed.length - 1].message_id) as {
							model_id: string | null;
						} | null;
						const activeModelId = lastClaimedMsg?.model_id || routerConfig.default;

						// Check delegation conditions
						const delegationTarget = getDelegationTarget(
							appContext.db,
							thread_id,
							activeModelId,
							modelRouter,
							appContext.siteId,
						);

						const threadRow = appContext.db
							.query("SELECT user_id FROM threads WHERE id = ?")
							.get(thread_id) as { user_id: string } | null;
						const userId = threadRow?.user_id || operatorUserId;

						if (delegationTarget) {
							appContext.logger.info(
								`[agent] Delegating to remote host ${delegationTarget.site_id}`,
							);
							await dispatchDelegation(
								delegationTarget,
								thread_id,
								claimedIds[0] ?? "",
								userId,
							);
						} else {
							const { agentResult: result } = await runLocalAgentLoop({
								eventBus: appContext.eventBus,
								threadId: thread_id,
								userId,
								modelId: activeModelId,
								activeLoopAbortControllers,
								agentLoopFactory,
								// Early exit: yield if new messages arrived during inference
								shouldYield: () => hasPending(appContext.db, thread_id),
							});

							if (result.error) {
								appContext.logger.error(`[agent] Error: ${result.error}`);
							} else {
								appContext.logger.info(
									`[agent] Done: ${result.messagesCreated} messages, ${result.toolCallsMade} tool calls`,
								);
							}

							// Push last assistant message to WebSocket clients
							if (!result.error && result.messagesCreated > 0) {
								const lastMsg = appContext.db
									.query(
										"SELECT * FROM messages WHERE thread_id = ? ORDER BY created_at DESC LIMIT 1",
									)
									.get(thread_id);
								if (lastMsg) {
									appContext.eventBus.emit("message:broadcast", {
										// biome-ignore lint/suspicious/noExplicitAny: db.query result is untyped
										message: lastMsg as any,
										thread_id,
									});
								}
							}
						}

						// Acknowledge the batch we just processed
						acknowledgeBatch(appContext.db, claimedIds);

						// Fire-and-forget: generate thread title
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
					} catch (error) {
						appContext.logger.error(`[agent] Error: ${formatError(error)}`);
						// On error, acknowledge the failed batch so we don't infinite-loop.
						// The error is logged; the user can retry by sending another message.
						try {
							acknowledgeBatch(appContext.db, claimedIds);
						} catch {
							// Non-fatal
						}
					}
				} // end drain loop
			} finally {
				activeLoops.delete(thread_id);

				// Notify platform connectors that the loop is done
				if (platformRegistry?.notifyLoopComplete) {
					platformRegistry.notifyLoopComplete(thread_id);
				}
			}
		};

		// message:created handler — enqueue and dispatch
		appContext.eventBus.on("message:created", ({ message, thread_id }) => {
			if (message.role !== "user") return;

			// Enqueue for dispatch tracking (idempotent — safe for re-emits)
			enqueueMessage(appContext.db, message.id, thread_id);

			// handleThread acquires the lock — if already held, returns immediately.
			// The active drain loop will pick up the new message on its next iteration.
			handleThread(thread_id);
		});

		// Recover: dispatch any threads that have pending entries (from crash recovery)
		const pendingThreads = appContext.db
			.prepare(
				`SELECT DISTINCT thread_id FROM dispatch_queue WHERE status = 'pending'`,
			)
			.all() as Array<{ thread_id: string }>;
		for (const { thread_id } of pendingThreads) {
			appContext.logger.info(`[recovery] Re-dispatching pending messages for thread ${thread_id}`);
			handleThread(thread_id);
		}
	} catch (error) {
		appContext.logger.warn("Web server failed to start", { error: formatError(error) });
		appContext.logger.warn("Continuing without web UI. API will not be available.");
	}

	// 13. Platform connectors (if configured)
	const platformsResult = appContext.optionalConfig.platforms;
	if (platformsResult?.ok) {
		const { PlatformConnectorRegistry } = await import("@bound/platforms");
		const platformsConfig = platformsResult.value as import("@bound/shared").PlatformsConfig;
		platformRegistry = new PlatformConnectorRegistry(appContext, platformsConfig);
		platformRegistry.start();
		// Wire into relay processor for platform-context process relays
		// biome-ignore lint/suspicious/noExplicitAny: PlatformConnectorRegistry satisfies ConnectorRegistry structurally
		relayProcessor.setPlatformConnectorRegistry(platformRegistry as any);
		appContext.logger.info("[platforms] Platform connector registry started");

		// Advertise configured platform names in hosts.platforms
		const platformNames = platformsConfig.connectors.map((c) => c.platform);
		if (platformNames.length > 0) {
			updateRow(
				appContext.db,
				"hosts",
				appContext.siteId,
				{ platforms: JSON.stringify(platformNames) },
				appContext.siteId,
			);
			appContext.logger.info(`[platforms] Advertised platforms: ${platformNames.join(", ")}`);
		}
	} else {
		appContext.logger.info("[platforms] Not configured (no platforms.json)");
	}

	return {
		webServer,
		statusForwardCache,
		activeDelegations,
		activeLoops,
		platformRegistry,
	};
}
