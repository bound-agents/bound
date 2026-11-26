import type { Database } from "bun:sqlite";
import type { Logger } from "@bound/shared";
import { updateRow } from "./change-log.js";
import { findHostSiteIdById } from "./repositories/index.js";

/**
 * Host-heartbeat refresh cadence. Bumps `hosts.modified_at` via outbox-routed `updateRow`
 * every HOST_HEARTBEAT_INTERVAL ms. Used by R-LR2's host-liveness gate as the freshness
 * signal that peers consult to decide whether the lease-holder is alive.
 */
export const HOST_HEARTBEAT_INTERVAL = 120_000;

interface HeartbeatTimer {
	setInterval(callback: () => void, intervalMs: number): unknown;
	clearInterval(timer: unknown): void;
}

const systemTimer: HeartbeatTimer = {
	setInterval,
	clearInterval,
};

export interface HeartbeatOptions {
	intervalMs?: number;
	logger?: Logger;
	/** Timer seam for deterministic tests. */
	timer?: HeartbeatTimer;
}

/**
 * Bumps the local `hosts.modified_at` through the change-log outbox so the
 * freshness signal syncs to peers, keeping this host inside their
 * `PLATFORM_HOST_STALE_THRESHOLD_MS` routing window.
 */
export function startHostHeartbeat(
	db: Database,
	siteId: string,
	options?: HeartbeatOptions,
): { stop: () => void } {
	const intervalMs = options?.intervalMs ?? HOST_HEARTBEAT_INTERVAL;
	const timer = options?.timer ?? systemTimer;
	let stopped = false;

	const tick = () => {
		if (stopped) return;
		try {
			const ts = new Date().toISOString();
			const existing = findHostSiteIdById(db, siteId);
			if (!existing) return;

			updateRow(db, "hosts", siteId, { modified_at: ts }, siteId);
		} catch (error) {
			options?.logger?.warn("Host heartbeat DB write failed", {
				error: error instanceof Error ? error.message : String(error),
			});
		}
	};

	const timerId = timer.setInterval(tick, intervalMs);

	return {
		stop: () => {
			stopped = true;
			timer.clearInterval(timerId);
		},
	};
}
