import { dirname, join, resolve } from "node:path";
import {
	findClusterConfigKeyByKeyIncludingDeleted,
	getSiteId,
	insertRow,
	softDelete,
	updateRow,
} from "@bound/core";
import { openBoundDB } from "../lib/db";
export interface StopResumeArgs {
	configDir?: string;
}

const EMERGENCY_STOP_KEY = "emergency_stop";

/**
 * Resolve the data directory from a config directory argument, matching the
 * layout produced by `bound init` (sibling `config/` and `data/` directories).
 */
function resolveDataDir(configDir: string | undefined): string {
	return join(dirname(resolve(configDir || "config")), "data");
}

/**
 * Existence probe that intentionally IGNORES the `deleted` flag. cluster_config
 * is keyed by `key`; a soft-deleted row still physically occupies that PK, so a
 * re-set must UPDATE (and un-tombstone) rather than INSERT — otherwise the INSERT
 * collides with the tombstone's PK. Live reads filter deleted = 0 elsewhere.
 */
function clusterConfigRowExists(db: ReturnType<typeof openBoundDB>, key: string): boolean {
	return findClusterConfigKeyByKeyIncludingDeleted(db, key) !== null;
}

export async function runStop(args: StopResumeArgs): Promise<void> {
	const dataDir = resolveDataDir(args.configDir);
	console.log("Setting emergency stop flag...");
	const db = openBoundDB(dataDir);
	try {
		// Get site_id from host_meta for change-log
		const siteId = getSiteId(db);
		if (siteId === "unknown") {
			throw new Error("Failed to read site_id from database. Database may not be initialized.");
		}
		const now = new Date().toISOString();
		// Probe ignoring `deleted`: re-setting a previously-cleared (soft-deleted)
		// stop must un-tombstone the existing row, not INSERT a colliding one.
		if (clusterConfigRowExists(db, EMERGENCY_STOP_KEY)) {
			updateRow(db, "cluster_config", EMERGENCY_STOP_KEY, { value: now, deleted: 0 }, siteId);
		} else {
			insertRow(
				db,
				"cluster_config",
				{ key: EMERGENCY_STOP_KEY, value: now, modified_at: now, deleted: 0 },
				siteId,
			);
		}
		console.log("Emergency stop set. All hosts will halt autonomous operations on next sync.");
	} finally {
		db.close();
	}
}
export async function runResume(args: StopResumeArgs): Promise<void> {
	const dataDir = resolveDataDir(args.configDir);
	console.log("Clearing emergency stop flag...");
	const db = openBoundDB(dataDir);
	try {
		const siteId = getSiteId(db);
		if (siteId === "unknown") {
			throw new Error("Failed to read site_id from database. Database may not be initialized.");
		}
		// Soft-delete the flag (invariant #2): tombstone the row so the cleared
		// state replicates. No-op when the flag was never set.
		if (clusterConfigRowExists(db, EMERGENCY_STOP_KEY)) {
			softDelete(db, "cluster_config", EMERGENCY_STOP_KEY, siteId);
		}
		console.log("Emergency stop cleared. Normal operations resume.");
	} finally {
		db.close();
	}
}
