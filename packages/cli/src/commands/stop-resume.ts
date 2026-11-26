import { findClusterConfigKeyByKeyIncludingDeleted, softDelete } from "@bound/core";
import {
	EMERGENCY_STOP_KEY,
	openBoundDBWithSite,
	resolveDataDir,
	upsertClusterConfig,
} from "../lib/db";
export interface StopResumeArgs {
	configDir?: string;
}

export async function runStop(args: StopResumeArgs): Promise<void> {
	const dataDir = resolveDataDir(args.configDir);
	console.log("Setting emergency stop flag...");
	const { db, siteId } = openBoundDBWithSite(dataDir);
	try {
		upsertClusterConfig(db, EMERGENCY_STOP_KEY, new Date().toISOString(), siteId);
		console.log("Emergency stop set. All hosts will halt autonomous operations on next sync.");
	} finally {
		db.close();
	}
}
export async function runResume(args: StopResumeArgs): Promise<void> {
	const dataDir = resolveDataDir(args.configDir);
	console.log("Clearing emergency stop flag...");
	const { db, siteId } = openBoundDBWithSite(dataDir);
	try {
		// Soft-delete the flag (invariant #2): tombstone the row so the cleared
		// state replicates. No-op when the flag was never set.
		if (findClusterConfigKeyByKeyIncludingDeleted(db, EMERGENCY_STOP_KEY) !== null) {
			softDelete(db, "cluster_config", EMERGENCY_STOP_KEY, siteId);
		}
		console.log("Emergency stop cleared. Normal operations resume.");
	} finally {
		db.close();
	}
}
