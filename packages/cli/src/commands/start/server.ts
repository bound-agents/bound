/**
 * Server subsystem: web server creation, message:created handler wiring,
 * delegation logic, and platform connector initialization.
 */

import { randomUUID } from "node:crypto";
import { createRelayOutboxEntry, generateThreadTitle, getDelegationTarget } from "@bound/agent";
import type { AgentLoop, AgentLoopConfig } from "@bound/agent";
import type { AppContext } from "@bound/core";
import {
	ThreadExecutor,
	acknowledgeBatch,
	claimPending,
	enqueueMessage,
	enqueueNotification,
	insertRow,
	updateRow,
	writeOutbox,
} from "@bound/core";
import type { ModelBackendsConfig, ModelRouter } from "@bound/llm";
import type { KeyringConfig, ProcessPayload, StatusForwardPayload } from "@bound/shared";
import { BOUND_NAMESPACE, deterministicUUID, formatError } from "@bound/shared";
import type { KeyManager, RelayExecutor, SyncTransport } from "@bound/sync";
import type { ReachabilityTracker } from "@bound/sync";
import { createSyncServer, createWebServer } from "@bound/web";
import { runLocalAgentLoop } from "../../lib/message-handler";

export type AgentLoopFactory = (config: AgentLoopConfig) => AgentLoop;

/** Format a notification payload as a human-readable message for the agent. */
export function formatNotification(payload: Record<string, unknown>): string {
	switch (payload.type) {
		case "task_complete":
			return `[notification] Task "${payload.task_name}" completed. Result: ${payload.result ?? "success"}`;
		case "advisory_created":
			return `[notification] New advisory: ${payload.title ?? "Untitled"}. ${payload.detail ?? ""}`.trim();
		case "proactive":
			return `[notification from background task] ${payload.content ?? ""}`.trim();
		default:
			return `[notification] ${JSON.stringify(payload)}`;
	}
}

export interface ServerResult {
	webServer: Awaited<ReturnType<typeof createWebServer>> | null;
	syncServer: Awaited<ReturnType<typeof createSyncServer>> | null;
	statusForwardCache: Map<string, StatusForwardPayload>;
	activeDelegations: Map<string, { targetSiteId: string; processOutboxId: string }>;
	threadExecutor: ThreadExecutor;
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
		setThreadExecutor(executor: ThreadExecutor): void;
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

	// 12. Web + sync servers
	appContext.logger.info("Starting servers...");
	let webServer: Awaited<ReturnType<typeof createWebServer>> | null = null;
	let syncServer: Awaited<ReturnType<typeof createSyncServer>> | null = null;
	const statusForwardCache = new Map<string, StatusForwardPayload>();
	const activeDelegations = new Map<string, { targetSiteId: string; processOutboxId: string }>();
	const threadExecutor = new ThreadExecutor(appContext.db, appContext.logger);

	// Wire the executor into the relay processor for Discord/platform process relays.
	relayProcessor.setThreadExecutor(threadExecutor);

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
			siteId: appContext.siteId,
			statusForwardCache,
			activeDelegations,
			activeLoops: threadExecutor.activeThreads as Set<string>,
		});
		await webServer.start();

		// Start sync server if sync prerequisites are available
		if (appContext.siteId && keyring && appContext.logger) {
			syncServer = await createSyncServer(appContext.db, appContext.eventBus, {
				port: syncPort,
				host: syncHost,
				siteId: appContext.siteId,
				keyring,
				logger: appContext.logger,
				relayExecutor,
				hubSiteId,
				eagerPushConfig,
				keyManager,
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

		// handleThread delegates to the shared ThreadExecutor.
		// The executor owns the thread-exclusive lock and drain loop.
		const handleThread = async (thread_id: string) => {
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
						for (const entry of claimed) {
							if (entry.event_type === "notification" && entry.event_payload) {
								try {
									const payload = JSON.parse(entry.event_payload);
									const notifText = formatNotification(payload);
									const now = new Date().toISOString();
									// Use a fresh UUID — the dispatch entry message_id may
									// already exist in messages from a prior retry (yield →
									// reclaim cycle), causing a PK collision.
									insertRow(
										appContext.db,
										"messages",
										{
											id: randomUUID(),
											thread_id,
											role: "user",
											content: notifText,
											model_id: null,
											tool_name: null,
											created_at: now,
											modified_at: now,
											host_origin: appContext.hostName,
											deleted: 0,
										},
										appContext.siteId,
									);
								} catch (err) {
									appContext.logger.error("[notify] Failed to inject notification message", {
										messageId: entry.message_id,
										threadId: thread_id,
										error: formatError(err),
									});
								}
							}
						}

						const lastClaimedMsg = appContext.db
							.prepare("SELECT model_id FROM messages WHERE id = ?")
							.get(claimed[claimed.length - 1].message_id) as {
							model_id: string | null;
						} | null;
						const activeModelId = lastClaimedMsg?.model_id || routerConfig.default;

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

						if (delegationTarget) {
							appContext.logger.info(
								`[agent] Delegating to remote host ${delegationTarget.site_id}`,
							);
							await dispatchDelegation(delegationTarget, thread_id, claimedIds[0] ?? "", userId);
						} else {
							// Inject platform tools for non-web threads so the agent can
							// send messages via discord_send_message, etc.
							const threadInterface = threadRow?.interface;
							let platformConfig:
								| { platform: string; platformTools: AgentLoopConfig["platformTools"] }
								| undefined;
							if (
								threadInterface &&
								threadInterface !== "web" &&
								threadInterface !== "scheduler" &&
								threadInterface !== "mcp" &&
								platformRegistry
							) {
								const connector = (
									platformRegistry as {
										getConnector?(p: string): {
											getPlatformTools?(
												threadId: string,
												readFileFn?: (path: string) => Promise<Uint8Array>,
											): AgentLoopConfig["platformTools"];
										} | null;
									}
								).getConnector?.(threadInterface);
								if (connector?.getPlatformTools) {
									platformConfig = {
										platform: threadInterface,
										platformTools: connector.getPlatformTools(thread_id),
									};
								}
							}

							const { agentResult: result } = await runLocalAgentLoop({
								eventBus: appContext.eventBus,
								threadId: thread_id,
								userId,
								modelId: activeModelId,
								activeLoopAbortControllers,
								agentLoopFactory,
								shouldYield,
								platform: platformConfig?.platform,
								platformTools: platformConfig?.platformTools,
							});

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
						return { claimedIds };
					} catch (error) {
						appContext.logger.error(`[agent] Error: ${formatError(error)}`);
						try {
							acknowledgeBatch(appContext.db, claimedIds);
						} catch {
							// Non-fatal
						}
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

					// Notify platform connectors that the loop iteration is done
					if (platformRegistry?.notifyLoopComplete) {
						platformRegistry.notifyLoopComplete(thread_id);
					}
				},
			);

			// Re-trigger if entries accumulated during the drain loop and weren't processed.
			// Without this, messages arriving while a loop is active become orphaned after
			// the executor releases the lock (no new message:created fires to re-dispatch).
			if (needsRetrigger) {
				appContext.logger.info(`[agent] Re-triggering dispatch for thread ${thread_id}`);
				// Use setImmediate to avoid holding the current call stack
				setTimeout(() => handleThread(thread_id).catch(() => {}), 0);
			}
		};

		// message:created handler — enqueue and dispatch
		appContext.eventBus.on("message:created", ({ message, thread_id }) => {
			if (message.role !== "user") return;

			// Enqueue for dispatch tracking (idempotent — safe for re-emits)
			enqueueMessage(appContext.db, message.id, thread_id);

			// handleThread acquires the lock — if already held, returns immediately.
			// The active drain loop will pick up the new message on its next iteration.
			handleThread(thread_id).catch((err) =>
				appContext.logger.error("[agent] Unhandled dispatch error", { error: formatError(err) }),
			);
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
		syncServer,
		statusForwardCache,
		activeDelegations,
		threadExecutor,
		platformRegistry,
	};
}
