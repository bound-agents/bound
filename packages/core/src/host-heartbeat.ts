import type { Database } from "bun:sqlite";
import { createChangeLogEntry } from "./change-log";

export interface HeartbeatOptions {
	/** Heartbeat interval in milliseconds. Defaults to 120_000 (2 minutes). */
	intervalMs?: number;
}

/**
 * Starts a periodic heartbeat that bumps hosts.modified_at for the local host.
 *
 * This keeps the host visible to relay routing on peers, which filters out
 * hosts whose modified_at is older than 5 minutes (STALE_THRESHOLD_MS).
 *
 * Returns a handle with stop() to clear the timer during graceful shutdown.
 */
export function startHostHeartbeat(
	db: Database,
	siteId: string,
	options?: HeartbeatOptions,
): { stop: () => void } {
	const intervalMs = options?.intervalMs ?? 120_000;
	let stopped = false;

	const tick = () => {
		if (stopped) return;
		try {
			const ts = new Date().toISOString();
			db.transaction(() => {
				// Only update if the host row exists
				const existing = db.query("SELECT site_id FROM hosts WHERE site_id = ?").get(siteId) as {
					site_id: string;
				} | null;
				if (!existing) return;

				db.run("UPDATE hosts SET modified_at = ? WHERE site_id = ?", [ts, siteId]);
				// Read full row for changelog — partial row_data breaks LWW INSERT on peers
				const fullRow = db.query("SELECT * FROM hosts WHERE site_id = ?").get(siteId) as Record<
					string,
					unknown
				>;
				createChangeLogEntry(db, "hosts", siteId, siteId, fullRow);
			})();
		} catch {
			// DB write failure is non-fatal — next heartbeat will retry
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
