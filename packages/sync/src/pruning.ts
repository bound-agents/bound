import type { Database } from "bun:sqlite";
import { pruneAcknowledged, pruneRelayCycles } from "@bound/core";
import { HLC_ZERO } from "@bound/shared";
import type { Logger } from "@bound/shared";
import { getMinConfirmedHlc } from "./peer-cursor.js";

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
			.query("SELECT hlc FROM change_log ORDER BY hlc DESC LIMIT 1 OFFSET ?")
			.get(MAX_SINGLE_HOST_ENTRIES) as { hlc: string } | null;
		if (!cutoffRow) return { deleted: 0 };

		db.query("DELETE FROM change_log WHERE hlc <= ?").run(cutoffRow.hlc);
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
	const minHlc = getMinConfirmedHlc(db);

	if (minHlc === HLC_ZERO) {
		return { deleted: 0 };
	}

	// Delete all events up to and including minHlc
	db.query("DELETE FROM change_log WHERE hlc <= ?").run(minHlc);

	const countResult = db.query("SELECT changes() as count").get() as { count: number } | undefined;
	const deleted = countResult?.count ?? 0;

	if (deleted > 0) {
		logger?.info(`Pruned ${deleted} change_log entries through hlc ${minHlc} in multi-host mode`);
	}

	return { deleted };
}

/** Reclaim freed pages incrementally (default 8192 pages = 32MB per cycle at 4KB page size). */
export function runIncrementalVacuum(db: Database, pages = 8192): void {
	db.run(`PRAGMA incremental_vacuum(${pages})`);
}

/** Drain the entire freelist on startup so accumulated bloat is reclaimed immediately. */
export function drainFreelistOnStartup(db: Database, logger?: Logger): void {
	const row = db.query("PRAGMA freelist_count").get() as { freelist_count: number } | null;
	const freePages = row?.freelist_count ?? 0;
	if (freePages < 1000) return;

	const reclaimMb = ((freePages * 4096) / 1_048_576).toFixed(1);
	logger?.info(`[vacuum] Draining ${freePages} free pages (${reclaimMb} MB) on startup`);
	db.run(`PRAGMA incremental_vacuum(${freePages})`);
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

			// Reclaim freed pages incrementally
			runIncrementalVacuum(db);
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
