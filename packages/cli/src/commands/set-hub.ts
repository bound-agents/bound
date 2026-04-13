import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createChangeLogEntry, getSiteId } from "@bound/core";
import { openBoundDB } from "../lib/db";
export interface SetHubArgs {
	hostName: string;
	wait?: boolean;
	timeout?: number;
	configDir?: string;
}
interface SyncStateRow {
	peer_site_id: string;
	last_sync_at: string | null;
}
function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}
function loadRelayConfig(configDir: string): { drain_timeout_seconds: number } {
	try {
		const syncConfigPath = resolve(configDir, "sync.json");
		if (!existsSync(syncConfigPath)) {
			return { drain_timeout_seconds: 120 };
		}
		const content = readFileSync(syncConfigPath, "utf-8");
		const parsed = JSON.parse(content);
		return {
			drain_timeout_seconds: parsed.relay?.drain_timeout_seconds ?? 120,
		};
	} catch {
		// Default if config can't be loaded
		return { drain_timeout_seconds: 120 };
	}
}
export async function runSetHub(args: SetHubArgs): Promise<void> {
	const configDir = args.configDir || "data";
	console.log(`Setting cluster hub to: ${args.hostName}`);
	try {
		const db = openBoundDB();
		// Get site_id for change_log
		const siteId = getSiteId(db);
		if (siteId === "unknown") {
			console.error("Failed to read site_id from database. Database may not be initialized.");
			db.close();
			process.exit(1);
		}

		// Ensure tables exist — boundctl may run before the main process
		db.exec(`
			CREATE TABLE IF NOT EXISTS cluster_config (
				key TEXT PRIMARY KEY,
				value TEXT NOT NULL,
				modified_at TEXT NOT NULL
			)
		`);
		// Ensure relay_outbox table exists
		db.exec(`
			CREATE TABLE IF NOT EXISTS relay_outbox (
				id TEXT PRIMARY KEY,
				source_site_id TEXT,
				target_site_id TEXT NOT NULL,
				kind TEXT NOT NULL,
				ref_id TEXT,
				idempotency_key TEXT,
				payload TEXT NOT NULL,
				created_at TEXT NOT NULL,
				expires_at TEXT NOT NULL,
				delivered INTEGER DEFAULT 0
			)
		`);

		// Step 1: Set drain flag
		// TODO: For multi-hub clusters, this should be in cluster_config (synced) so all
		// hubs see the drain signal. Currently in host_meta (local-only), which works for
		// single-hub deployments where the draining hub is the one running this command.
		db.query("INSERT OR REPLACE INTO host_meta (key, value) VALUES (?, ?)").run(
			"relay_draining",
			"true",
		);
		console.log("Relay drain mode enabled.");

		// Step 2: Wait for relay outbox to drain
		const relayConfig = loadRelayConfig(configDir);
		const drainTimeoutMs = relayConfig.drain_timeout_seconds * 1000;
		const drainStart = Date.now();
		let drained = false;

		console.log(
			`Waiting for relay outbox to drain (timeout: ${relayConfig.drain_timeout_seconds}s)...`,
		);

		while (Date.now() - drainStart < drainTimeoutMs) {
			const pending = db
				.query("SELECT COUNT(*) as count FROM relay_outbox WHERE delivered = 0")
				.get() as { count: number };

			if (pending.count === 0) {
				drained = true;
				console.log("Relay outbox drained successfully.");
				break;
			}

			console.log(`Draining relay outbox: ${pending.count} entries remaining...`);
			await sleep(1000);
		}

		if (!drained) {
			const remaining = db
				.query("SELECT COUNT(*) as count FROM relay_outbox WHERE delivered = 0")
				.get() as { count: number };
			console.warn(
				`Drain timeout reached with ${remaining.count} entries remaining. Proceeding with hub switch.`,
			);
		}

		// Record the timestamp when hub is set (used for polling)
		const hubChangeTimestamp = new Date().toISOString();
		// Step 3: Set hub
		const hubKey = "cluster_hub";
		const existingHub = db.query("SELECT key FROM cluster_config WHERE key = ?").get(hubKey);
		const setHubTx = db.transaction(() => {
			if (existingHub) {
				db.query("UPDATE cluster_config SET value = ?, modified_at = ? WHERE key = ?").run(
					args.hostName,
					hubChangeTimestamp,
					hubKey,
				);
			} else {
				db.query("INSERT INTO cluster_config (key, value, modified_at) VALUES (?, ?, ?)").run(
					hubKey,
					args.hostName,
					hubChangeTimestamp,
				);
			}
			// Write change_log entry
			const rowData = { key: hubKey, value: args.hostName, modified_at: hubChangeTimestamp };
			createChangeLogEntry(db, "cluster_config", hubKey, siteId, rowData);
		});
		setHubTx();
		console.log("Cluster hub set successfully.");

		// Step 4: Clear drain flag
		db.query("DELETE FROM host_meta WHERE key = 'relay_draining'").run();
		console.log("Relay drain mode disabled.");
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
				);
				if (confirmedPeers.length === peers.length) {
					confirmed = true;
					break;
				}
				await sleep(pollIntervalMs);
			}
			if (confirmed) {
				console.log("All peers confirmed the hub change.");
			} else {
				console.warn(
					"Timeout: not all peers confirmed. The hub IS set, but some peers have not synced yet.",
				);
			}
		}
		db.close();
	} catch (error) {
		console.error("Failed to set hub:", error);
		process.exit(1);
	}
}
