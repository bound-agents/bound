import type { Database } from "bun:sqlite";
import { pruneAcknowledged, pruneRelayCycles } from "@bound/core";
import type { Logger } from "@bound/shared";
import { getMinConfirmedSeq } from "./peer-cursor.js";

export function determinePruningMode(db: Database): "multi-host" | "single-host" {
	const row = db.query("SELECT COUNT(*) as count FROM sync_state").get() as
		| { count: number }
		| undefined;

	if (!row || row.count === 0) {
		return "single-host";
	}

	return "multi-host";
}

export function pruneChangeLog(
	db: Database,
	mode: "multi-host" | "single-host",
	logger?: Logger,
): { deleted: number } {
	if (mode === "single-host") {
		// Retain recent changelog entries in single-host mode so they are available
		// when multi-host sync is enabled later. Cap at 100k entries to bound growth.
		const MAX_SINGLE_HOST_ENTRIES = 100_000;
		const countRow = db.query("SELECT COUNT(*) as count FROM change_log").get() as
			| { count: number }
			| undefined;
		const count = countRow?.count ?? 0;

		if (count <= MAX_SINGLE_HOST_ENTRIES) {
			return { deleted: 0 };
		}

		// Keep the most recent MAX_SINGLE_HOST_ENTRIES, delete the rest
		const cutoffRow = db
			.query("SELECT seq FROM change_log ORDER BY seq DESC LIMIT 1 OFFSET ?")
			.get(MAX_SINGLE_HOST_ENTRIES) as { seq: number } | null;
		if (!cutoffRow) return { deleted: 0 };

		db.query("DELETE FROM change_log WHERE seq <= ?").run(cutoffRow.seq);
		const deletedRow = db.query("SELECT changes() as count").get() as { count: number } | undefined;
		const deleted = deletedRow?.count ?? 0;

		if (deleted > 0) {
			logger?.info(
				`Pruned ${deleted} old change_log entries in single-host mode (cap: ${MAX_SINGLE_HOST_ENTRIES})`,
			);
		}
		return { deleted };
	}

	// Multi-host mode: only delete confirmed events
	const minSeq = getMinConfirmedSeq(db);

	if (minSeq <= 0) {
		return { deleted: 0 };
	}

	// Delete all events up to and including minSeq
	db.query("DELETE FROM change_log WHERE seq <= ?").run(minSeq);

	const countResult = db.query("SELECT changes() as count").get() as { count: number } | undefined;
	const deleted = countResult?.count ?? 0;

	if (deleted > 0) {
		logger?.info(`Pruned ${deleted} change_log entries through seq ${minSeq} in multi-host mode`);
	}

	return { deleted };
}

export function startPruningLoop(
	db: Database,
	intervalMs: number,
	logger?: Logger,
): { stop: () => void } {
	let timerId: Timer | null = null;
	let stopped = false;

	const startLoop = () => {
		if (stopped) return;

		timerId = setInterval(() => {
			if (stopped) return;

			const mode = determinePruningMode(db);
			pruneChangeLog(db, mode, logger);

			// Prune relay cycles (30-day retention)
			const relayCyclesPruned = pruneRelayCycles(db, 30);
			if (relayCyclesPruned > 0) {
				logger?.debug("Pruned relay cycles", { count: relayCyclesPruned });
			}

			// Prune acknowledged dispatch entries (1-hour retention)
			const dispatchCutoff = new Date(Date.now() - 3_600_000).toISOString();
			const dispatchPruned = pruneAcknowledged(db, dispatchCutoff);
			if (dispatchPruned > 0) {
				logger?.debug("Pruned dispatch_queue", { count: dispatchPruned });
			}
		}, intervalMs);
	};

	startLoop();

	return {
		stop: () => {
			stopped = true;
			if (timerId) clearInterval(timerId);
		},
	};
}
