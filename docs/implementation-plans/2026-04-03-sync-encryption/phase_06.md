# Sync Encryption Implementation Plan — Phase 6: SIGHUP Config Reload

**Goal:** Process reloads all optional configs on SIGHUP signal, including keyring with shared secret recomputation, without process restart.

**Architecture:** New `packages/cli/src/sighup.ts` module with `registerSighupHandler()` that reloads all optional configs via the existing `loadOptionalConfigs()`, diffs the keyring, and calls `KeyManager.reloadKeyring()`. The handler uses a reload-in-progress flag to prevent concurrent reloads. AppContext's `optionalConfig` is updated in place. A reference to KeyManager is stored at module level in start.ts for the handler to access.

**Tech Stack:** Node process signals, loadOptionalConfigs from @bound/core, KeyManager.reloadKeyring from Phase 1, bun:test

**Scope:** Phase 6 of 8 from original design

**Codebase verified:** 2026-04-03

---

## Acceptance Criteria Coverage

This phase implements and tests:

### sync-encryption.AC12: SIGHUP Config Reload
- **sync-encryption.AC12.1 Success:** SIGHUP reloads all optional configs (keyring, network, platforms, sync, mcp, overlay, cron_schedules)
- **sync-encryption.AC12.2 Success:** KeyManager recomputes shared secrets for added/changed keyring peers
- **sync-encryption.AC12.3 Success:** Unchanged peers keep cached secrets (no unnecessary recomputation)
- **sync-encryption.AC12.4 Success:** Removed peers have secrets evicted
- **sync-encryption.AC12.5 Failure:** Bad config file is non-fatal: logs error, keeps previous config value
- **sync-encryption.AC12.6 Edge:** Concurrent SIGHUP signals do not cause race conditions (reload-in-progress flag)

---

<!-- START_SUBCOMPONENT_A (tasks 1-2) -->
<!-- START_TASK_1 -->
### Task 1: Create sighup.ts handler module

**Verifies:** sync-encryption.AC12.1, sync-encryption.AC12.2, sync-encryption.AC12.3, sync-encryption.AC12.4, sync-encryption.AC12.5, sync-encryption.AC12.6

**Files:**
- Create: `packages/cli/src/sighup.ts`

**Implementation:**

Create `packages/cli/src/sighup.ts` with the `registerSighupHandler()` function:

```typescript
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

export function registerSighupHandler(config: SighupHandlerConfig): void {
	const { appContext, configDir, keyManager, logger } = config;

	process.on("SIGHUP", async () => {
		if (reloadInProgress) {
			logger.warn("SIGHUP received but reload already in progress, skipping");
			return;
		}

		reloadInProgress = true;
		logger.info("SIGHUP received, reloading optional configs...");

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
			logger.error("Unexpected error during SIGHUP config reload", {
				error: err instanceof Error ? err.message : String(err),
			});
		} finally {
			reloadInProgress = false;
		}
	});

	logger.info("SIGHUP handler registered for config reload");
}
```

**Key design decisions:**
- `reloadInProgress` flag prevents concurrent reloads (sync-encryption.AC12.6). Simple boolean is sufficient since Node.js is single-threaded — the `async` handler won't be preempted mid-execution, but the flag prevents a second SIGHUP from starting a new reload while awaiting the first.
- Bad config files are non-fatal (sync-encryption.AC12.5) — errors are logged and the previous value is kept. Only successfully validated configs are applied.
- Config change detection uses JSON.stringify comparison — a known simplification. JSON.stringify does not guarantee property ordering, so a config file reformatted with different property order may trigger an unnecessary reload. This is harmless (recomputes same values) and acceptable for the small config objects in this system.
- `loadOptionalConfigs()` is called fresh each time (it reads from disk), so it always reflects the current file state.
- KeyManager reload is called only when the keyring config actually changed.
- AppContext.optionalConfig is mutated in place (it's an object reference shared across the process).

**Verification:**

Run: `tsc -p packages/cli --noEmit`
Expected: No type errors.

**Commit:** `feat(cli): add SIGHUP handler for config hot-reload`
<!-- END_TASK_1 -->

<!-- START_TASK_2 -->
### Task 2: Tests for SIGHUP handler

**Verifies:** sync-encryption.AC12.1, sync-encryption.AC12.2, sync-encryption.AC12.3, sync-encryption.AC12.4, sync-encryption.AC12.5, sync-encryption.AC12.6

**Files:**
- Create: `packages/cli/src/__tests__/sighup.test.ts`

**Testing:**

Since SIGHUP is a Unix signal, tests can't easily send real signals in bun:test. Instead, extract the reload logic into a testable function and test that directly.

Refactor: Extract the reload logic from the signal handler into a separate `async function reloadConfigs(config: SighupHandlerConfig)` that the SIGHUP handler calls. Tests invoke `reloadConfigs()` directly.

Tests must verify each AC:

- **sync-encryption.AC12.1 (all configs reloaded):** Create a temp config directory with all 7 optional config files. Call `reloadConfigs()`. Verify `appContext.optionalConfig` is updated for each config.
- **sync-encryption.AC12.2 (new peer secrets):** Create a KeyManager with keyring containing peer A. Update keyring.json to add peer B. Call `reloadConfigs()`. Verify `keyManager.getSymmetricKey(peerB_siteId)` returns non-null.
- **sync-encryption.AC12.3 (unchanged peers preserved):** Create KeyManager with peers A and B. Capture reference to A's symmetric key. Reload with same keyring. Verify A's symmetric key is the same object reference (not recomputed).
- **sync-encryption.AC12.4 (removed peers evicted):** Create KeyManager with peers A and B. Reload with only peer A. Verify `keyManager.getSymmetricKey(peerB_siteId)` returns null.
- **sync-encryption.AC12.5 (bad config non-fatal):** Write invalid JSON to one config file. Call `reloadConfigs()`. Verify the invalid config keeps its previous value, other configs are updated, and an error is logged.
- **sync-encryption.AC12.6 (concurrent reload):** Call `reloadConfigs()` twice concurrently (Promise.all). Verify only one reload executes (check log output for "reload already in progress" message).

**Verification:**

Run: `bun test packages/cli/src/__tests__/sighup.test.ts`
Expected: All tests pass.

**Commit:** `test(cli): add SIGHUP handler unit tests`
<!-- END_TASK_2 -->
<!-- END_SUBCOMPONENT_A -->

<!-- START_TASK_3 -->
### Task 3: Wire SIGHUP handler into start.ts

**Verifies:** sync-encryption.AC12.1

**Files:**
- Modify: `packages/cli/src/commands/start.ts` (after KeyManager creation, before sync loop start)

**Implementation:**

After KeyManager initialization (Phase 2 Task 6) and before sync loop start, register the SIGHUP handler:

```typescript
// After KeyManager init and before sync loop:
import { registerSighupHandler } from "../sighup.js";

// Store configDir for reload access (it's a parameter of runStart)
registerSighupHandler({
	appContext,
	configDir: args.configDir,  // from CLI args
	keyManager: hasKeyringPeers ? keyManager : undefined,
	logger: appContext.logger,
});
```

The `configDir` is available as a parameter to the `runStart()` function. The `keyManager` is the instance created in Phase 2 Task 6 (or undefined if no keyring peers).

**Key design decisions:**
- Registration happens after KeyManager is fully initialized but before sync loop starts, so the handler is ready when the first SIGHUP arrives.
- `keyManager` is passed as optional — single-node deployments without keyring can still reload other configs via SIGHUP.

**Verification:**

Run: `tsc -p packages/cli --noEmit`
Expected: No type errors.

Manual verification: Start the process, modify keyring.json, send `kill -HUP <pid>`. Check logs for "Config reload complete" with keyring in the changed list.

**Commit:** `feat(cli): wire SIGHUP handler into startup sequence`
<!-- END_TASK_3 -->
