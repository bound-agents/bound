/**
 * Sync subsystem: SyncClient, SyncTransport, sync loop, pruning loop,
 * and overlay scanner.
 */

import type { Database } from "bun:sqlite";
import type { AppContext } from "@bound/core";
import type { KeyringConfig } from "@bound/shared";
import { formatError } from "@bound/shared";
import type { KeyManager, SyncTransport } from "@bound/sync";

export interface SyncResult {
	syncLoopHandle: { stop: () => void } | null;
	pruningHandle: { stop: () => void } | null;
	overlayHandle: { stop: () => void } | null;
	transport: SyncTransport | undefined;
}

export async function initSync(
	appContext: AppContext,
	keypair: { privateKey: CryptoKey; siteId: string },
	keyManager: KeyManager | undefined,
): Promise<SyncResult> {
	let transport: SyncTransport | undefined;

	// 14. Sync (if configured)
	appContext.logger.info("Initializing sync loop...");
	let syncLoopHandle: { stop: () => void } | null = null;
	const syncResult = appContext.optionalConfig.sync;
	if (syncResult?.ok) {
		const syncConfig = syncResult.value as { hub: string; sync_interval_seconds: number };
		try {
			const { SyncClient, startSyncLoop, SyncTransport: ST } = await import("@bound/sync");
			const keyringResult = appContext.optionalConfig.keyring;
			const keyring = keyringResult?.ok ? (keyringResult.value as KeyringConfig) : { hosts: {} };

			// Initialize SyncTransport if keyring has peers (keyManager already initialized)
			const hasKeyringPeers = Object.keys(keyring.hosts).length > 0;
			if (hasKeyringPeers && keyManager) {
				transport = new ST(keyManager, keypair.privateKey, appContext.siteId, appContext.logger);
			}

			const syncClient = new SyncClient(
				appContext.db,
				appContext.siteId,
				keypair.privateKey,
				syncConfig.hub,
				appContext.logger,
				appContext.eventBus,
				keyring,
				transport,
			);
			syncLoopHandle = startSyncLoop(
				syncClient,
				syncConfig.sync_interval_seconds || 30,
				appContext.eventBus,
				appContext.logger,
			);
			appContext.logger.info(
				`[sync] Sync loop started (${syncConfig.sync_interval_seconds}s interval)`,
			);
		} catch (error) {
			appContext.logger.warn(`[sync] Failed to start: ${formatError(error)}`);
		}
	} else {
		appContext.logger.info("[sync] Not configured");
	}

	// 14b. Change-log pruning (runs in both single-host and multi-host modes)
	let pruningHandle: { stop: () => void } | null = null;
	try {
		const { startPruningLoop } = await import("@bound/sync");
		pruningHandle = startPruningLoop(appContext.db, 300_000, appContext.logger);
		appContext.logger.info("[sync] Change-log pruning started (5m interval)");
	} catch (error) {
		appContext.logger.warn(`[sync] Failed to start pruning: ${formatError(error)}`);
	}

	// 15. Overlay scanning (if configured)
	appContext.logger.info("Initializing overlay scanner...");
	let overlayHandle: { stop: () => void } | null = null;
	const overlayResult = appContext.optionalConfig.overlay;
	if (overlayResult?.ok) {
		const overlayConfig = overlayResult.value as { mounts: Record<string, string> };
		try {
			const { startOverlayScanLoop } = await import("@bound/sandbox");
			const { insertRow, updateRow, softDelete } = await import("@bound/core");
			// Adapter: OverlayOutbox expects string table names, core outbox expects SyncedTableName.
			// overlay_index is a synced table, so this cast is safe.
			const outboxAdapter = {
				insertRow: (
					db: Database,
					table: string,
					row: Record<string, unknown>,
					siteId: string,
				): void => insertRow(db, table as "overlay_index", row, siteId),
				updateRow: (
					db: Database,
					table: string,
					id: string,
					changes: Record<string, unknown>,
					siteId: string,
				): void => updateRow(db, table as "overlay_index", id, changes, siteId),
				softDelete: (db: Database, table: string, id: string, siteId: string): void =>
					softDelete(db, table as "overlay_index", id, siteId),
			};
			overlayHandle = startOverlayScanLoop(
				appContext.db,
				appContext.siteId,
				overlayConfig.mounts,
				undefined,
				outboxAdapter,
			);
			appContext.logger.info(
				`[overlay] Scanner started (${Object.keys(overlayConfig.mounts).length} mount(s))`,
			);
		} catch (error) {
			appContext.logger.warn(`[overlay] Failed to start: ${formatError(error)}`);
		}
	} else {
		appContext.logger.info("[overlay] Not configured");
	}

	return { syncLoopHandle, pruningHandle, overlayHandle, transport };
}
