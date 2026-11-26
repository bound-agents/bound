import { Database } from "bun:sqlite";
import { dirname, join, resolve } from "node:path";
import {
	findClusterConfigKeyByKeyIncludingDeleted,
	getSiteId,
	insertRow,
	updateRow,
} from "@bound/core";

export const EMERGENCY_STOP_KEY = "emergency_stop";
export const CLUSTER_HUB_KEY = "cluster_hub";

/** The `data/` directory that `bound init` lays out as a sibling of `config/`. */
export function resolveDataDir(configDir?: string): string {
	return join(dirname(resolve(configDir || "config")), "data");
}

export function openBoundDB(configDir?: string): Database {
	const dir = configDir || "data";
	const db = new Database(resolve(dir, "bound.db"));
	// boundctl opens the DB without applySchema, so host_meta may be missing
	// if the main process has never run.
	db.exec(`
		CREATE TABLE IF NOT EXISTS host_meta (
			key TEXT PRIMARY KEY,
			value TEXT NOT NULL
		)
	`);
	return db;
}

/**
 * Open the data dir's DB and read its site id. Throws (closing the handle)
 * when the node has never started, since every boundctl write needs a site id
 * for the change log.
 */
export function openBoundDBWithSite(dataDir: string): { db: Database; siteId: string } {
	const db = openBoundDB(dataDir);
	const siteId = getSiteId(db);
	if (siteId === "unknown") {
		db.close();
		throw new Error("Failed to read site_id from database. Database may not be initialized.");
	}
	return { db, siteId };
}

/**
 * Upsert a cluster_config key through the outbox helpers. The existence probe
 * includes tombstoned rows: a soft-deleted row still occupies the `key` PK, so
 * a re-set must UPDATE (un-tombstoning via deleted=0), never INSERT.
 */
export function upsertClusterConfig(
	db: Database,
	key: string,
	value: string,
	siteId: string,
): void {
	if (findClusterConfigKeyByKeyIncludingDeleted(db, key) !== null) {
		updateRow(db, "cluster_config", key, { value, deleted: 0 }, siteId);
	} else {
		insertRow(
			db,
			"cluster_config",
			{ key, value, modified_at: new Date().toISOString(), deleted: 0 },
			siteId,
		);
	}
}
