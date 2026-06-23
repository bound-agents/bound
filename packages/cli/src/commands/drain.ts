import { dirname, join, resolve } from "node:path";
import { getSiteId, insertRow, softDelete, updateRow } from "@bound/core";
import { openBoundDB } from "../lib/db";
export interface DrainArgs {
	newHub: string;
	timeout?: number;
	configDir?: string;
}
interface TaskRow {
	id: string;
	status: string;
}
function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Upsert a cluster_config key through the outbox helpers. The existence probe
 * intentionally IGNORES `deleted`: a soft-deleted row still occupies the `key`
 * PK, so re-setting it must UPDATE (and un-tombstone via deleted=0), never INSERT
 * a colliding row.
 */
function upsertClusterConfig(
	db: ReturnType<typeof openBoundDB>,
	key: string,
	value: string,
	siteId: string,
): void {
	const exists = db.query("SELECT key FROM cluster_config WHERE key = ?").get(key) !== null;
	if (exists) {
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
export async function runDrain(args: DrainArgs): Promise<void> {
	const configDir = args.configDir || "config";
	// Data directory is assumed to be a sibling of the config directory, matching the
	// layout produced by `bound init` and the convention used by runConfigReload.
	const dataDir = join(dirname(resolve(configDir)), "data");
	const timeoutSeconds = args.timeout ?? 120;
	const timeoutMs = timeoutSeconds * 1000;
	console.log(`Draining current hub and switching to: ${args.newHub}`);
	console.log(`Timeout: ${timeoutSeconds}s\n`);
	const db = openBoundDB(dataDir);
	try {
		// Get site_id from host_meta for change-log
		const siteId = getSiteId(db);
		if (siteId === "unknown") {
			throw new Error("Failed to read site_id from database. Database may not be initialized.");
		}
		// Step 1: Set emergency_stop = "drain" to prevent new task scheduling
		console.log("Step 1: Setting emergency_stop to 'drain' to prevent new tasks...");
		const emergencyStopKey = "emergency_stop";
		upsertClusterConfig(db, emergencyStopKey, "drain", siteId);
		console.log("Drain mode enabled.\n");
		// Step 2: Wait for all running tasks to complete
		console.log("Step 2: Waiting for running tasks to complete...");
		const pollIntervalMs = 2000;
		const deadline = Date.now() + timeoutMs;
		let tasksComplete = false;
		while (Date.now() < deadline) {
			const runningTasks = db
				.query("SELECT id, status FROM tasks WHERE status = 'running'")
				.all() as TaskRow[];
			if (runningTasks.length === 0) {
				console.log("All tasks complete.\n");
				tasksComplete = true;
				break;
			}
			console.log(`Waiting for ${runningTasks.length} task(s) to complete...`);
			await sleep(pollIntervalMs);
		}
		if (!tasksComplete) {
			console.warn("Timeout: some tasks are still running. Proceeding anyway...\n");
		}
		// Step 3: Set cluster_hub to new hub
		console.log(`Step 3: Setting cluster_hub to ${args.newHub}...`);
		const hubKey = "cluster_hub";
		upsertClusterConfig(db, hubKey, args.newHub, siteId);
		console.log("Hub updated.\n");
		// Step 4: Clear emergency_stop (soft-delete — invariant #2)
		console.log("Step 4: Clearing emergency_stop...");
		if (db.query("SELECT key FROM cluster_config WHERE key = ?").get(emergencyStopKey) !== null) {
			softDelete(db, "cluster_config", emergencyStopKey, siteId);
		}
		console.log("Emergency stop cleared.\n");
		console.log(`Drain complete. Cluster hub is now: ${args.newHub}`);
	} finally {
		db.close();
	}
}
