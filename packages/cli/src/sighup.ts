import type { Logger } from "@bound/shared";
import type { KeyManager } from "@bound/sync";
import type { AppContext } from "@bound/core";
import { loadOptionalConfigs } from "@bound/core";

interface SighupHandlerConfig {
	appContext: AppContext;
	configDir: string;
	keyManager?: KeyManager;
	logger: Logger;
}

let reloadInProgress = false;

/**
 * Reload all optional configs and update appContext in place.
 * Bad config files are non-fatal — errors are logged and previous values kept.
 * KeyManager is reloaded only when keyring config actually changed.
 * Concurrent reloads are prevented by reloadInProgress flag (AC12.6).
 */
export async function reloadConfigs(config: SighupHandlerConfig): Promise<void> {
	const { appContext, configDir, keyManager, logger } = config;

	// Yield control to allow concurrent calls to be scheduled
	await Promise.resolve();

	if (reloadInProgress) {
		logger.warn("Config reload already in progress, skipping");
		return;
	}

	reloadInProgress = true;
	logger.info("Reloading optional configs...");

	try {
		const newOptionalConfigs = loadOptionalConfigs(configDir);

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
				const newKeyring = keyringResult.value as import("@bound/shared").KeyringConfig;
				keyManager.reloadKeyring(newKeyring);
				logger.info("KeyManager reloaded with updated keyring", {
					peerCount: Object.keys(newKeyring.hosts).length,
				});
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
