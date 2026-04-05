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

		appContext.eventBus.on("message:created", async ({ message, thread_id }) => {
			if (message.role !== "user") return;

			// Enqueue for dispatch tracking (idempotent — safe for re-emits)
			enqueueMessage(appContext.db, message.id, thread_id);

			if (!modelRouter) {
				appContext.logger.warn("[agent] No model router configured, cannot process message");
				return;
			}
			if (activeLoops.has(thread_id)) {
				appContext.logger.info(`[agent] Loop already active for thread ${thread_id}, skipping`);
				return;
			}

			appContext.logger.info(`[agent] Processing message in thread ${thread_id}`);
			activeLoops.add(thread_id);

			// Claim all pending messages for this thread — marks them as 'processing'
			const claimed = claimPending(appContext.db, thread_id, appContext.siteId);
			const claimedIds = claimed.map((e) => e.message_id);

			try {
				const selectedModelId = message.model_id || undefined;
				const activeModelId = selectedModelId || routerConfig.default;

				// AC6.1: Check delegation conditions
				const delegationTarget = getDelegationTarget(
					appContext.db,
					thread_id,
					activeModelId,
					modelRouter,
					appContext.siteId,
				);

				// Get thread user_id
				const threadRow = appContext.db
					.query("SELECT user_id FROM threads WHERE id = ?")
					.get(thread_id) as { user_id: string } | null;
				const userId = threadRow?.user_id || operatorUserId;

				let shouldReEmitMessage = false;

				if (delegationTarget) {
					// Delegate entire loop to remote host
					appContext.logger.info(`[agent] Delegating to remote host ${delegationTarget.site_id}`);
					await dispatchDelegation(delegationTarget, thread_id, message.id, userId);
				} else {
					// AC6.5: Run locally via extracted helper
					const { agentResult: result } = await runLocalAgentLoop({
						eventBus: appContext.eventBus,
						threadId: thread_id,
						userId,
						modelId: activeModelId,
						activeLoopAbortControllers,
						agentLoopFactory,
					});

					if (result.error) {
						appContext.logger.error(`[agent] Error: ${result.error}`);
					} else {
						appContext.logger.info(
							`[agent] Done: ${result.messagesCreated} messages, ${result.toolCallsMade} tool calls`,
						);
					}

					shouldReEmitMessage = !result.error && result.messagesCreated > 0;
				}

				// Push the last assistant message to WebSocket clients
				if (shouldReEmitMessage) {
					const lastMsg = appContext.db
						.query("SELECT * FROM messages WHERE thread_id = ? ORDER BY created_at DESC LIMIT 1")
						.get(thread_id);
					if (lastMsg) {
						appContext.eventBus.emit("message:broadcast", {
							// biome-ignore lint/suspicious/noExplicitAny: db.query result is untyped at this callsite
							message: lastMsg as any,
							thread_id,
						});
					}
				}

				// Fire-and-forget: generate thread title
				const hasLocalBackend = modelRouter.listBackends().length > 0;
				if (hasLocalBackend) {
					generateThreadTitle(appContext.db, thread_id, modelRouter.getDefault(), appContext.siteId)
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
			} finally {
				activeLoops.delete(thread_id);

				// Acknowledge the batch we just processed
				if (claimedIds.length > 0) {
					try {
						acknowledgeBatch(appContext.db, claimedIds);
					} catch {
						// Non-fatal
					}
				}

				// Notify platform connectors that the loop is done
				if (platformRegistry?.notifyLoopComplete) {
					platformRegistry.notifyLoopComplete(thread_id);
				}

				// Re-queue: check dispatch_queue for messages that arrived during the loop
				try {
					const pendingRow = appContext.db
						.prepare(
							"SELECT dq.message_id FROM dispatch_queue dq WHERE dq.thread_id = ? AND dq.status = 'pending' ORDER BY dq.created_at ASC LIMIT 1",
						)
						.get(thread_id) as { message_id: string } | null;
					if (pendingRow) {
						appContext.logger.info(`[agent] Re-queuing pending message in thread ${thread_id}`);
						const fullPendingMsg = appContext.db
							.prepare("SELECT * FROM messages WHERE id = ? LIMIT 1")
							.get(pendingRow.message_id) as import("@bound/shared").Message | null;
						if (fullPendingMsg) {
							appContext.eventBus.emit("message:created", {
								message: fullPendingMsg,
								thread_id,
							});
						}
					}
				} catch {
					// Non-fatal — don't break cleanup on re-queue failure
				}
			}
		});
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
