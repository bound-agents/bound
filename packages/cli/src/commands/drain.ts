import { findClusterConfigKeyByKeyIncludingDeleted, softDelete } from "@bound/core";
import {
	CLUSTER_HUB_KEY,
	EMERGENCY_STOP_KEY,
	openBoundDBWithSite,
	resolveDataDir,
	upsertClusterConfig,
} from "../lib/db";
export interface DrainArgs {
	newHub: string;
	timeout?: number;
	configDir?: string;
}
interface TaskRow {
	id: string;
	status: string;
}
export async function runDrain(args: DrainArgs): Promise<void> {
	const dataDir = resolveDataDir(args.configDir);
	const timeoutSeconds = args.timeout ?? 120;
	const timeoutMs = timeoutSeconds * 1000;
	console.log(`Draining current hub and switching to: ${args.newHub}`);
	console.log(`Timeout: ${timeoutSeconds}s\n`);
	const { db, siteId } = openBoundDBWithSite(dataDir);
	try {
		// Step 1: Set emergency_stop = "drain" to prevent new task scheduling
		console.log("Step 1: Setting emergency_stop to 'drain' to prevent new tasks...");
		upsertClusterConfig(db, EMERGENCY_STOP_KEY, "drain", siteId);
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
			await Bun.sleep(pollIntervalMs);
		}
		if (!tasksComplete) {
			console.warn("Timeout: some tasks are still running. Proceeding anyway...\n");
		}
		// Step 3: Set cluster_hub to new hub
		console.log(`Step 3: Setting cluster_hub to ${args.newHub}...`);
		upsertClusterConfig(db, CLUSTER_HUB_KEY, args.newHub, siteId);
		console.log("Hub updated.\n");
		// Step 4: Clear emergency_stop (soft-delete — invariant #2)
		console.log("Step 4: Clearing emergency_stop...");
		if (findClusterConfigKeyByKeyIncludingDeleted(db, EMERGENCY_STOP_KEY) !== null) {
			softDelete(db, "cluster_config", EMERGENCY_STOP_KEY, siteId);
		}
		console.log("Emergency stop cleared.\n");
		console.log(`Drain complete. Cluster hub is now: ${args.newHub}`);
	} finally {
		db.close();
	}
}
