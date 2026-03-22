import type { Database } from "bun:sqlite";
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
): { deleted: number } {
	if (mode === "single-host") {
		// In single-host mode, no peers consume the change_log, so we can safely delete everything
		const result = db.query("DELETE FROM change_log");
		result.run();

		// Get the count of deleted rows from the changes count
		const countBefore = db.query("SELECT changes() as count").get() as
			| { count: number }
			| undefined;

		return { deleted: countBefore?.count ?? 0 };
	}

	// Multi-host mode: only delete confirmed events
	const minSeq = getMinConfirmedSeq(db);

	if (minSeq <= 0) {
		return { deleted: 0 };
	}

	// Delete all events up to and including minSeq
	db.query("DELETE FROM change_log WHERE seq <= ?").run(minSeq);

	const countBefore = db.query("SELECT changes() as count").get() as { count: number } | undefined;

	return { deleted: countBefore?.count ?? 0 };
}

export function startPruningLoop(db: Database, intervalMs: number): { stop: () => void } {
	let timerId: Timer | null = null;
	let stopped = false;

	const startLoop = () => {
		if (stopped) return;

		timerId = setInterval(() => {
			if (stopped) return;

			const mode = determinePruningMode(db);
			const result = pruneChangeLog(db, mode);

			if (result.deleted > 0) {
				// Pruning occurred, could log this or emit event
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
