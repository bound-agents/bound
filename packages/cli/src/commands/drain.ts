import { openBoundDB } from "../lib/db";

import { resolve } from "node:path";
import { getSiteId } from "@bound/core";
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
export async function runDrain(args: DrainArgs): Promise<void> {
	const dataDir = args.configDir || "data";
	const _dbPath = resolve(dataDir, "bound.db");
	const timeoutSeconds = args.timeout ?? 120;
	const timeoutMs = timeoutSeconds * 1000;
	console.log(`Draining current hub and switching to: ${args.newHub}`);
	console.log(`Timeout: ${timeoutSeconds}s\n`);
	try {
		const db = openBoundDB(args.configDir);
		// Get site_id from host_meta for change-log
		const siteId = getSiteId(db);
		if (siteId === "unknown") {
			console.error("Failed to read site_id from database. Database may not be initialized.");
			db.close();
			process.exit(1);
		}
		const now = new Date().toISOString();
		// Step 1: Set emergency_stop = "drain" to prevent new task scheduling
		console.log("Step 1: Setting emergency_stop to 'drain' to prevent new tasks...");
		const emergencyStopKey = "emergency_stop";
		const existingStop = db
			.query("SELECT key FROM cluster_config WHERE key = ?")
			.get(emergencyStopKey);
		const setDrainTx = db.transaction(() => {
			if (existingStop) {
				db.query("UPDATE cluster_config SET value = ?, modified_at = ? WHERE key = ?").run(
					"drain",
					now,
					emergencyStopKey,
				);
			} else {
				db.query("INSERT INTO cluster_config (key, value, modified_at) VALUES (?, ?, ?)").run(
					emergencyStopKey,
					"drain",
					now,
				);
			}
			// Write change_log entry
			const rowData = { key: emergencyStopKey, value: "drain", modified_at: now };
			db.query(
				`INSERT INTO change_log (table_name, row_id, site_id, timestamp, row_data)
				 VALUES (?, ?, ?, ?, ?)`,
			).run("cluster_config", emergencyStopKey, siteId, now, JSON.stringify(rowData));
		});
		setDrainTx();
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
		const hubTimestamp = new Date().toISOString();
		const hubKey = "cluster_hub";
		const existingHub = db.query("SELECT key FROM cluster_config WHERE key = ?").get(hubKey);
		const setHubTx = db.transaction(() => {
			if (existingHub) {
				db.query("UPDATE cluster_config SET value = ?, modified_at = ? WHERE key = ?").run(
					args.newHub,
					hubTimestamp,
					hubKey,
				);
			} else {
				db.query("INSERT INTO cluster_config (key, value, modified_at) VALUES (?, ?, ?)").run(
					hubKey,
					args.newHub,
					hubTimestamp,
				);
			}
			// Write change_log entry
			const rowData = { key: hubKey, value: args.newHub, modified_at: hubTimestamp };
			db.query(
				`INSERT INTO change_log (table_name, row_id, site_id, timestamp, row_data)
				 VALUES (?, ?, ?, ?, ?)`,
			).run("cluster_config", hubKey, siteId, hubTimestamp, JSON.stringify(rowData));
		});
		setHubTx();
		console.log("Hub updated.\n");
		// Step 4: Clear emergency_stop
		console.log("Step 4: Clearing emergency_stop...");
		const clearTimestamp = new Date().toISOString();
		const clearTx = db.transaction(() => {
			db.query("DELETE FROM cluster_config WHERE key = ?").run(emergencyStopKey);
			// Write change_log entry with empty value to signal deletion
			const rowData = { key: emergencyStopKey, value: "", modified_at: clearTimestamp };
			db.query(
				`INSERT INTO change_log (table_name, row_id, site_id, timestamp, row_data)
				 VALUES (?, ?, ?, ?, ?)`,
			).run("cluster_config", emergencyStopKey, siteId, clearTimestamp, JSON.stringify(rowData));
		});
		clearTx();
		console.log("Emergency stop cleared.\n");
		console.log(`Drain complete. Cluster hub is now: ${args.newHub}`);
		db.close();
	} catch (error) {
		console.error("Failed to drain:", error);
		process.exit(1);
	}
}
