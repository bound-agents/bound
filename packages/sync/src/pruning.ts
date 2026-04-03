import type { Database } from "bun:sqlite";
import { pruneRelayCycles } from "@bound/core";
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
		// Retain changelog entries in single-host mode so they are available
		// when multi-host sync is enabled later. Without these entries, the
		// first sync after enabling multi-host would miss all prior changes.
		return { deleted: 0 };
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
