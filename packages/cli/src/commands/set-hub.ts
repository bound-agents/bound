import { openBoundDB } from "../lib/db";

import { Database } from "bun:sqlite";
import { resolve } from "node:path";
export interface SetHubArgs {
	hostName: string;
	wait?: boolean;
	timeout?: number;
	configDir?: string;
}
interface SyncStateRow {
	peer_site_id: string;
	last_sync_at: string | null;
function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
export async function runSetHub(args: SetHubArgs): Promise<void> {
	const configDir = args.configDir || "data";
	const dbPath = resolve(configDir, "bound.db");
	console.log(`Setting cluster hub to: ${args.hostName}`);
	try {
		const db = openBoundDB(args.configDir);
		// Ensure cluster_config table exists
		db.exec(`
			CREATE TABLE IF NOT EXISTS cluster_config (
				key TEXT PRIMARY KEY,
				value TEXT NOT NULL,
				modified_at TEXT NOT NULL
			)
		`);
		// Record the timestamp when hub is set (used for polling)
		const hubChangeTimestamp = new Date().toISOString();
		// Set hub
		db.query(
			"INSERT OR REPLACE INTO cluster_config (key, value, modified_at) VALUES (?, ?, ?)",
		).run("cluster_hub", args.hostName, hubChangeTimestamp);
		console.log("Cluster hub set successfully.");
		if (args.wait) {
			const timeoutMs = (args.timeout ?? 60) * 1000;
			const pollIntervalMs = 2000;
			const deadline = Date.now() + timeoutMs;
			console.log("Waiting for all peers to confirm...");
			let confirmed = false;
			while (Date.now() < deadline) {
				const peers = db
					.query("SELECT peer_site_id, last_sync_at FROM sync_state")
					.all() as SyncStateRow[];
				if (peers.length === 0) {
					console.log("No peers found in sync_state. Nothing to wait for.");
					confirmed = true;
					break;
				}
				const confirmedPeers = peers.filter(
					(p) => p.last_sync_at !== null && p.last_sync_at > hubChangeTimestamp,
				);
				console.log(
					`Waiting for ${peers.length} peers... (${confirmedPeers.length}/${peers.length} confirmed)`,
				if (confirmedPeers.length === peers.length) {
				await sleep(pollIntervalMs);
			}
			if (confirmed) {
				console.log("All peers confirmed the hub change.");
			} else {
				console.warn(
					"Timeout: not all peers confirmed. The hub IS set, but some peers have not synced yet.",
		}
		db.close();
	} catch (error) {
		console.error("Failed to set hub:", error);
		process.exit(1);
	}
