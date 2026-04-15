/**
 * Relay subsystem: relay processor, KeyManager, SIGHUP handler,
 * and hub site ID resolution.
 */

import { RelayProcessor } from "@bound/agent";
import type { MCPClient } from "@bound/agent";
import type { AppContext } from "@bound/core";
import { resolveRelayConfig } from "@bound/core";
import type { ModelRouter } from "@bound/llm";
import type { ClusterFsResult } from "@bound/sandbox";
import type { KeyringConfig, SyncConfig } from "@bound/shared";
import type { KeyManager, RelayExecutor } from "@bound/sync";

/** Keypair shape returned by ensureKeypair from @bound/sync. */
export interface Keypair {
	publicKey: CryptoKey;
	privateKey: CryptoKey;
	siteId: string;
}

export interface RelayResult {
	relayProcessor: RelayProcessor;
	relayProcessorHandle: { stop: () => void };
	relayExecutor: RelayExecutor;
	keyManager: KeyManager | undefined;
	hubSiteId: string | undefined;
	keyring: KeyringConfig | undefined;
}

export async function initRelay(
	appContext: AppContext,
	keypair: Keypair,
	mcpClientsMap: Map<string, MCPClient>,
	modelRouter: ModelRouter | null,
	clusterFsObj: ClusterFsResult | null,
): Promise<RelayResult> {
	// 8b. Relay processor setup
	appContext.logger.info("Initializing relay processor...");

	const keyringResult = appContext.optionalConfig.keyring;
	const keyring = keyringResult?.ok ? (keyringResult.value as KeyringConfig) : undefined;

	if (!keyring) {
		appContext.logger.info("[relay] No keyring configured, relay processor disabled");
	}

	const syncConfigResult = appContext.optionalConfig.sync;
	const relayConfig = resolveRelayConfig(
		syncConfigResult?.ok ? (syncConfigResult.value as SyncConfig) : undefined,
	);
	// In single-host mode (no keyring), trust only self; in multi-host, trust all keyring peers.
	const keyringSiteIds = keyring
		? new Set(Object.keys(keyring.hosts))
		: new Set([appContext.siteId]);
	const relayProcessor = new RelayProcessor(
		appContext.db,
		appContext.siteId,
		mcpClientsMap,
		modelRouter ?? null,
		keyringSiteIds,
		appContext.logger,
		appContext.eventBus,
		appContext,
		relayConfig,
	);

	// Wire the virtual filesystem reader so discord_send_message can read files
	// created by bash commands in the sandbox.
	if (clusterFsObj) {
		const mountableFs = "fs" in clusterFsObj ? clusterFsObj.fs : clusterFsObj;
		relayProcessor.setFileReader(async (path: string): Promise<Uint8Array> => {
			const content = await mountableFs.readFile(path);
			return new TextEncoder().encode(content);
		});
	}

	const relayProcessorHandle = relayProcessor.start();
	appContext.logger.info("[relay] Relay processor started");

	// Create the RelayExecutor callback for hub-local execution
	const relayExecutor: RelayExecutor = async (request, hubSiteId) => {
		return relayProcessor.executeImmediate(request, hubSiteId);
	};

	// Determine hub siteId from keyring (for spoke-side validation)
	let hubSiteId: string | undefined;
	if (keyringResult?.ok && syncConfigResult?.ok) {
		const kr = keyringResult.value as KeyringConfig;
		const syncConfig = syncConfigResult.value as SyncConfig;
		const hubEntry = Object.entries(kr.hosts).find(([_, v]) => v.url === syncConfig.hub);
		if (hubEntry) {
			hubSiteId = hubEntry[0];
		}
	}

	// 11d. Initialize KeyManager for encrypted middleware
	let keyManager: KeyManager | undefined;
	if (keyringResult?.ok) {
		const kr = keyringResult.value as KeyringConfig;
		const hasKeyringPeers = Object.keys(kr.hosts).length > 0;
		if (hasKeyringPeers) {
			try {
				const { KeyManager: KM } = await import("@bound/sync");
				keyManager = new KM(keypair, appContext.siteId);
				await keyManager.init(kr);
				appContext.logger.info(
					`Encryption initialized: ${Object.keys(kr.hosts).length} peers, local fingerprint ${keyManager.getLocalFingerprint()}`,
				);
			} catch (err) {
				// R-SE19: Key derivation failure is FATAL
				appContext.logger.error(
					"FATAL: Failed to initialize encryption key manager. Sync encryption requires valid Ed25519 keys.",
					{
						error: err instanceof Error ? err.message : String(err),
					},
				);
				process.exit(1);
			}
		}
	}

	// SIGHUP handler registration moved to index.ts where all subsystems
	// (sandbox, MCP clients, etc.) are available for hot-reload callbacks.

	// Check for plaintext logging debug mode
	if (process.env.BOUND_LOG_SYNC_PLAINTEXT === "1") {
		appContext.logger.warn(
			"BOUND_LOG_SYNC_PLAINTEXT=1 is set. Decrypted sync request bodies will be logged. " +
				"This should only be used for debugging and NEVER in production.",
		);
	}

	return {
		relayProcessor,
		relayProcessorHandle,
		relayExecutor,
		keyManager,
		hubSiteId,
		keyring,
	};
}
