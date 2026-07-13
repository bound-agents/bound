/**
 * WebSocket sync subsystem: WsTransport (push-on-write changelog replication),
 * WsSyncClient (spoke to hub connection), and pruning loop.
 */

import type { AppContext } from "@bound/core";
import { setChangelogEventBus, setRelayOutboxEventBus } from "@bound/core";
import type { KeyringConfig, SyncConfig } from "@bound/shared";
import { formatError, wsSchema } from "@bound/shared";
import type { KeyManager } from "@bound/sync";
import type { WsTransport as WsTransportType } from "@bound/sync";

export interface SyncResult {
	pruningHandle: { stop: () => void } | null;
	wsTransport: WsTransportType | undefined;
	wsClient: {
		close: () => void;
		updateReconnectConfig: (max?: number) => void;
		updateBackpressureLimit: (limit?: number) => void;
		updateBackfillInterval: (seconds?: number) => void;
	} | null;
}

export async function initSync(
	appContext: AppContext,
	keypair: { privateKey: CryptoKey; siteId: string },
	keyManager: KeyManager | undefined,
	reseed?: boolean,
): Promise<SyncResult> {
	let wsTransport: WsTransportType | undefined;
	let wsClient: { close: () => void } | null = null;

	// 14. Sync (if configured — WS only, HTTP polling removed)
	appContext.logger.info("Initializing sync...");
	const syncResult = appContext.optionalConfig.sync;
	if (syncResult?.ok) {
		const syncConfig = syncResult.value as SyncConfig;
		try {
			const { WsSyncClient, WsTransport: WT } = await import("@bound/sync");
			const keyringResult = appContext.optionalConfig.keyring;
			const keyring = keyringResult?.ok ? (keyringResult.value as KeyringConfig) : { hosts: {} };

			// Initialize WsTransport if keyring has peers
			const hasKeyringPeers = Object.keys(keyring.hosts).length > 0;
			if (hasKeyringPeers && keyManager) {
				wsTransport = new WT({
					db: appContext.db,
					siteId: appContext.siteId,
					eventBus: appContext.eventBus,
					logger: appContext.logger,
					isHub: !syncConfig.hub, // Hub if no hub URL configured, spoke if hub URL configured
				});
				// Enable push-on-write for changelog and relay entries
				setChangelogEventBus(appContext.eventBus);
				setRelayOutboxEventBus(appContext.eventBus);
				wsTransport.start();
				appContext.logger.info("[sync] WsTransport started");
			}

			// AC2.7: Create WsSyncClient for spoke mode (hub_url configured)
			if (syncConfig.hub && keyManager) {
				try {
					const hubUrl = new URL(syncConfig.hub).toString();
					// Derive hub site ID from the keyring — find the keyring entry matching hubUrl
					let hubSiteId: string | undefined;
					for (const [siteId, entry] of Object.entries(keyring.hosts ?? {})) {
						const normalizedEntryUrl = new URL(entry.url).toString();
						if (normalizedEntryUrl === hubUrl) {
							hubSiteId = siteId;
							break;
						}
					}

					if (!hubSiteId) {
						appContext.logger.warn(
							"[sync] Hub URL in sync config not found in keyring, cannot create WS client",
						);
					} else {
						// Parse WS config with defaults applied by schema
						const wsConfigRaw = syncConfig.ws;
						const wsConfig = wsConfigRaw ? wsSchema.parse(wsConfigRaw) : wsSchema.parse({});
						const reconnectMaxInterval = wsConfig.reconnect_max_interval;
						const backpressureLimit = wsConfig.backpressure_limit;
						const backfillIntervalSeconds = wsConfig.backfill_interval;
						const receiveTimeoutMs = wsConfig.receive_timeout_ms;

						const wsClientInstance = new WsSyncClient({
							hubUrl,
							privateKey: keypair.privateKey,
							siteId: appContext.siteId,
							keyManager,
							hubSiteId,
							wsTransport,
							logger: appContext.logger,
							reconnectMaxInterval,
							backpressureLimit,
							backfillIntervalSeconds,
							receiveTimeoutMs,
							reseed,
						});

						await wsClientInstance.connect();
						// biome-ignore lint/suspicious/noExplicitAny: WsSyncClient instance has the required methods
						wsClient = wsClientInstance as any;
						appContext.logger.info("[sync] WebSocket client connected to hub");
					}
				} catch (error) {
					appContext.logger.warn(`[sync] Failed to create WS client: ${formatError(error)}`);
				}
			}
		} catch (error) {
			appContext.logger.warn(`[sync] Failed to start: ${formatError(error)}`);
		}
	} else {
		appContext.logger.info("[sync] Not configured");
	}

	// 14b. Change-log pruning (runs in both single-host and multi-host modes)
	let pruningHandle: { stop: () => void } | null = null;
	try {
		const { startPruningLoop, drainFreelistOnStartup } = await import("@bound/sync");
		drainFreelistOnStartup(appContext.db, appContext.logger);
		pruningHandle = startPruningLoop(appContext.db, 300_000, appContext.logger);
		appContext.logger.info("[sync] Change-log pruning started (5m interval)");
	} catch (error) {
		appContext.logger.warn(`[sync] Failed to start pruning: ${formatError(error)}`);
	}

	return { pruningHandle, wsTransport, wsClient } as SyncResult;
}
