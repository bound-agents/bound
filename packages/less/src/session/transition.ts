/**
 * Thread transitions with lock management and rollback.
 * Implements AC7.3 (/attach), AC7.4 (/clear), AC7.5 (rollback), AC7.6 (degraded mode).
 */

import type { BoundClient } from "@bound/client";
import type { McpServerConfig } from "../config";
import { acquireLock, releaseLock } from "../lockfile";
import type { AppLogger } from "../logging";
import type { McpServerManager } from "../mcp/manager";
import { type AttachResult, performAttach } from "./attach";

export interface TransitionParams {
	client: BoundClient;
	oldThreadId: string;
	newThreadId: string | null; // null for /clear (creates new thread)
	configDir: string;
	cwd: string;
	hostname: string;
	mcpManager: McpServerManager;
	mcpConfigs: McpServerConfig[];
	logger: AppLogger;
	inFlightTools: Map<string, AbortController>;
	confirmFn?: (toolName: string) => Promise<boolean>;
	model?: string | null;
}

export type TransitionResult =
	| { ok: true; attachResult: AttachResult; threadId: string }
	| { ok: false; error: string; degraded: boolean };

/**
 * Transition to a new thread with ordered sequence and rollback.
 *
 * Sequence (AC7.3):
 * 1. Drain in-flight tools
 * 2. Unsubscribe old thread
 * 3. Release old lock
 * 4. Create thread if /clear (AC7.4)
 * 5. Acquire new lock (rollback on failure, AC7.5)
 * 6. Verify thread exists (rollback on failure)
 * 7. Perform attach (rollback on failure)
 *
 * Rollback (AC7.5): Re-subscribe to old, re-acquire old lock.
 * Rollback failure (AC7.6): Return degraded=true if old lock is gone.
 */
export async function transitionThread(params: TransitionParams): Promise<TransitionResult> {
	const {
		client,
		oldThreadId,
		newThreadId: _newThreadId,
		configDir,
		cwd,
		hostname,
		mcpManager,
		mcpConfigs,
		logger,
		inFlightTools,
		confirmFn,
		model,
	} = params;

	let newThreadId = _newThreadId;

	logger.info("transition_start", {
		oldThreadId,
		newThreadId: newThreadId || "new",
		actionType: newThreadId ? "attach" : "clear",
	});

	// Step 1: Drain in-flight tools (abort all, wait up to 500ms)
	logger.info("transition_drain_tools", {
		toolCount: inFlightTools.size,
	});

	const toolAborts = Array.from(inFlightTools.values()).map((controller) => {
		controller.abort();
		return controller;
	});

	if (toolAborts.length > 0) {
		// Wait up to 500ms for handlers to complete.
		// This is an intentional design trade-off per AC7.3: we wait a fixed duration
		// rather than attempting to detect completion (which is unreliable with async handlers).
		// The 500ms window balances responsiveness with handler cleanup.
		await new Promise((resolve) => setTimeout(resolve, 500));
	}

	// Step 2: Unsubscribe old thread
	logger.info("transition_unsubscribe_old", { oldThreadId });
	client.unsubscribe(oldThreadId);

	// Step 3: Release old lock
	logger.info("transition_release_old_lock", { oldThreadId });
	releaseLock(configDir, oldThreadId);

	// Step 4: Create thread if /clear (AC7.4)
	if (!newThreadId) {
		logger.info("transition_create_thread", {});
		try {
			const thread = await client.createThread();
			newThreadId = thread.id;
			logger.info("transition_thread_created", { newThreadId });
		} catch (error) {
			const errorMsg = error instanceof Error ? error.message : String(error);
			logger.error("transition_create_thread_failed", { error: errorMsg });
			// Rollback: re-subscribe and re-acquire old lock
			return await rollback(client, oldThreadId, configDir, cwd, logger, errorMsg);
		}
	}

	// Step 5: Acquire new lock (rollback on failure, AC7.5)
	logger.info("transition_acquire_new_lock", { newThreadId });
	try {
		acquireLock(configDir, newThreadId, cwd);
	} catch (error) {
		const errorMsg = error instanceof Error ? error.message : String(error);
		logger.error("transition_acquire_new_lock_failed", { error: errorMsg });
		// Rollback: re-subscribe and re-acquire old lock
		return await rollback(client, oldThreadId, configDir, cwd, logger, errorMsg);
	}

	// Step 6: Verify thread exists
	logger.info("transition_verify_thread", { newThreadId });
	try {
		await client.getThread(newThreadId);
	} catch (error) {
		const errorMsg = error instanceof Error ? error.message : String(error);
		logger.error("transition_verify_thread_failed", { error: errorMsg });
		releaseLock(configDir, newThreadId);
		// Rollback: re-subscribe and re-acquire old lock
		return await rollback(client, oldThreadId, configDir, cwd, logger, errorMsg);
	}

	// Step 7: Perform attach
	logger.info("transition_attach", { newThreadId });
	try {
		const attachResult = await performAttach({
			client,
			threadId: newThreadId,
			mcpManager,
			mcpConfigs,
			cwd,
			hostname,
			logger,
			confirmFn,
		});

		logger.info("transition_complete", {
			newThreadId,
			model: model || null,
		});

		return {
			ok: true,
			attachResult,
			threadId: newThreadId,
		};
	} catch (error) {
		const errorMsg = error instanceof Error ? error.message : String(error);
		logger.error("transition_attach_failed", { error: errorMsg });
		releaseLock(configDir, newThreadId);
		// Rollback: re-subscribe and re-acquire old lock
		return await rollback(client, oldThreadId, configDir, cwd, logger, errorMsg);
	}
}

/**
 * Rollback helper: re-subscribe to old thread, re-acquire old lock.
 * If rollback fails (AC7.6), return degraded=true.
 */
async function rollback(
	client: BoundClient,
	oldThreadId: string,
	configDir: string,
	cwd: string,
	logger: AppLogger,
	originalError: string,
): Promise<TransitionResult> {
	logger.info("transition_rollback_start", { oldThreadId });

	// Re-subscribe to old thread
	try {
		client.subscribe(oldThreadId);
	} catch (error) {
		const msg = error instanceof Error ? error.message : String(error);
		logger.error("transition_rollback_resubscribe_failed", { error: msg });
	}

	// Re-acquire old lock (AC7.6: if this fails, enter degraded mode)
	try {
		acquireLock(configDir, oldThreadId, cwd);
		logger.info("transition_rollback_complete", {
			error: originalError,
			degraded: false,
		});
		return {
			ok: false,
			error: `Transition failed: ${originalError}`,
			degraded: false,
		};
	} catch (error) {
		// Another process grabbed the old lock
		const msg = error instanceof Error ? error.message : String(error);
		logger.error("transition_rollback_failed", {
			error: msg,
			originalError,
		});
		return {
			ok: false,
			error: `Transition failed: ${originalError}. Rollback also failed: ${msg}. Entering degraded mode.`,
			degraded: true,
		};
	}
}
