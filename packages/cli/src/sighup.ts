import type { AppContext } from "@bound/core";
import { loadOptionalConfigs } from "@bound/core";
import type { KeyringConfig, Logger, McpConfig } from "@bound/shared";
import type { KeyManager } from "@bound/sync";

interface SighupHandlerConfig {
	appContext: AppContext;
	configDir: string;
	keyManager?: KeyManager;
	logger: Logger;
	/**
	 * Callback invoked when the MCP config changes during a reload.
	 * Receives the old and new configs so the caller can run reloadMcpServers().
	 */
	onMcpConfigChanged?: (oldConfig: McpConfig, newConfig: McpConfig) => Promise<void>;
	/**
	 * Callback invoked when the WS config changes during a reload.
	 * Allows the caller to update WsSyncClient and WS server config.
	 * idle_timeout changes take effect on next connection only.
	 */
	onWsConfigChanged?: (newWsConfig: Record<string, unknown> | undefined) => Promise<void>;
	// For testing: inject a delay into the reload work to allow true concurrency testing
	delayMs?: number;
}

let reloadInProgress = false;

/**
 * Reload all optional configs and update appContext in place.
 * Bad config files are non-fatal — errors are logged and previous values kept.
 * KeyManager is reloaded only when keyring config actually changed.
 * Concurrent reloads are prevented by reloadInProgress flag (AC12.6).
 */
export async function reloadConfigs(config: SighupHandlerConfig): Promise<void> {
	const {
		appContext,
		configDir,
		keyManager,
		onMcpConfigChanged,
		onWsConfigChanged,
		logger,
		delayMs,
	} = config;

	// Yield control to allow concurrent calls to be scheduled.
	// Use setTimeout to ensure the check happens in the next event loop tick.
	await new Promise((resolve) => setTimeout(resolve, 0));

	if (reloadInProgress) {
		logger.warn("Config reload already in progress, skipping");
		return;
	}

	reloadInProgress = true;
	logger.info("Reloading optional configs...");

	try {
		// Yield to allow concurrent calls a chance to check reloadInProgress before we finish
		await Promise.resolve();

		// For testing: inject optional delay to force true concurrency
		if (delayMs) {
			await new Promise((resolve) => setTimeout(resolve, delayMs));
		}

		const newOptionalConfigs = loadOptionalConfigs(configDir);

		// Capture old MCP and sync configs before they get overwritten
		const oldMcpResult = appContext.optionalConfig.mcp;
		const oldMcpConfig: McpConfig | null = oldMcpResult?.ok
			? (oldMcpResult.value as McpConfig)
			: null;
		const oldSyncResult = appContext.optionalConfig.sync;
		const oldSyncConfig = oldSyncResult?.ok
			? (oldSyncResult.value as Record<string, unknown>)
			: null;

		// Track what changed for logging
		const changes: string[] = [];
		const errors: string[] = [];

		// Update each optional config in appContext
		for (const [key, newResult] of Object.entries(newOptionalConfigs)) {
			if (!newResult) continue;

			if (!newResult.ok) {
				// Bad config: non-fatal, keep previous value (AC12.5)
				errors.push(key);
				logger.error(`Failed to reload ${key} config`, {
					error: newResult.error,
				});
				continue;
			}

			// Check if config actually changed
			const oldResult = appContext.optionalConfig[key];
			const oldValue = oldResult?.ok ? JSON.stringify(oldResult.value) : null;
			const newValue = JSON.stringify(newResult.value);

			if (oldValue !== newValue) {
				changes.push(key);
				(appContext.optionalConfig as Record<string, typeof newResult>)[key] = newResult;
			}
		}

		// Handle keyring changes specifically
		if (keyManager && changes.includes("keyring")) {
			const keyringResult = appContext.optionalConfig.keyring;
			if (keyringResult?.ok) {
				const newKeyring = keyringResult.value as KeyringConfig;
				keyManager.reloadKeyring(newKeyring);
				logger.info("KeyManager reloaded with updated keyring", {
					peerCount: Object.keys(newKeyring.hosts).length,
				});
			}
		}

		// Handle MCP config changes — reconnect servers
		if (onMcpConfigChanged && changes.includes("mcp")) {
			const mcpResult = appContext.optionalConfig.mcp;
			if (mcpResult?.ok) {
				const newConfig = mcpResult.value as McpConfig;
				try {
					await onMcpConfigChanged(oldMcpConfig ?? { servers: [] }, newConfig);
				} catch (err) {
					logger.error("MCP reload failed", {
						error: err instanceof Error ? err.message : String(err),
					});
				}
			}
		}

		// Handle WS config changes — update client and server config
		if (onWsConfigChanged && changes.includes("sync")) {
			const syncResult = appContext.optionalConfig.sync;
			if (syncResult?.ok) {
				const newSyncConfig = syncResult.value as Record<string, unknown>;
				const newWsConfig = newSyncConfig.ws as Record<string, unknown> | undefined;
				const oldWsConfig = oldSyncConfig?.ws as Record<string, unknown> | undefined;
				// Only invoke callback if ws config actually changed
				if (JSON.stringify(oldWsConfig) !== JSON.stringify(newWsConfig)) {
					try {
						await onWsConfigChanged(newWsConfig);
					} catch (err) {
						logger.error("WS config reload failed", {
							error: err instanceof Error ? err.message : String(err),
						});
					}
				}
			}
		}

		logger.info("Config reload complete", {
			changed: changes,
			errors: errors,
			unchanged: Object.keys(newOptionalConfigs).filter(
				(k) => !changes.includes(k) && !errors.includes(k),
			),
		});
	} catch (err) {
		logger.error("Unexpected error during config reload", {
			error: err instanceof Error ? err.message : String(err),
		});
	} finally {
		reloadInProgress = false;
	}
}

/**
 * Register SIGHUP signal handler for config hot-reload.
 * The handler calls reloadConfigs() to reload all optional configs and update KeyManager.
 */
export function registerSighupHandler(config: SighupHandlerConfig): void {
	const { logger } = config;

	process.on("SIGHUP", async () => {
		await reloadConfigs(config);
	});

	logger.info("SIGHUP handler registered for config reload");
}
