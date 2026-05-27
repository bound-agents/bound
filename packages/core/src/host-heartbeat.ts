import type { Database } from "bun:sqlite";
import type { Logger } from "@bound/shared";
import { updateRow } from "./change-log.js";

/**
 * Host-heartbeat refresh cadence. Bumps `hosts.modified_at` via outbox-routed `updateRow`
 * every HOST_HEARTBEAT_INTERVAL ms. Used by R-LR2's host-liveness gate as the freshness
 * signal that peers consult to decide whether the lease-holder is alive.
 */
export const HOST_HEARTBEAT_INTERVAL = 120_000;

export interface HeartbeatOptions {
	/** Heartbeat interval in milliseconds. Defaults to 120_000 (2 minutes). */
	intervalMs?: number;
	/** Logger for warning messages when heartbeat fails. */
	logger?: Logger;
}

/**
 * Starts a periodic heartbeat that bumps hosts.modified_at for the local host.
 *
 * This keeps the host visible to relay routing on peers, which filters out
 * hosts whose modified_at is older than 5 minutes (STALE_THRESHOLD_MS).
 *
 * Uses the change-log outbox so freshness syncs to peers via WS transport.
 *
 * Returns a handle with stop() to clear the timer during graceful shutdown.
 */
export function startHostHeartbeat(
	db: Database,
	siteId: string,
	options?: HeartbeatOptions,
): { stop: () => void } {
	const intervalMs = options?.intervalMs ?? HOST_HEARTBEAT_INTERVAL;
	let stopped = false;

	const tick = () => {
		if (stopped) return;
		try {
			const ts = new Date().toISOString();
			// Only update if the host row exists
			const existing = db.query("SELECT site_id FROM hosts WHERE site_id = ?").get(siteId) as {
				site_id: string;
			} | null;
			if (!existing) return;

			updateRow(db, "hosts", siteId, { modified_at: ts }, siteId);
		} catch (error) {
			options?.logger?.warn("Host heartbeat DB write failed", {
				error: error instanceof Error ? error.message : String(error),
			});
		}
	};

	const timerId = setInterval(tick, intervalMs);

	return {
		stop: () => {
			stopped = true;
			clearInterval(timerId);
		},
	};
}
