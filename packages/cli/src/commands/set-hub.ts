import {
	countPendingPeerTargetedDurableWork,
	listSyncState,
	loadConfigWithPrecedence,
	resolveRelayConfig,
} from "@bound/core";
import { syncSchema } from "@bound/shared";
import {
	CLUSTER_HUB_KEY,
	openBoundDBWithSite,
	resolveDataDir,
	upsertClusterConfig,
} from "../lib/db";
export interface SetHubArgs {
	hostName: string;
	wait?: boolean;
	timeout?: number;
	configDir?: string;
}
async function loadDrainTimeoutSeconds(configDir: string): Promise<number> {
	const result = await loadConfigWithPrecedence(configDir, "sync", syncSchema);
	return resolveRelayConfig(result.ok ? result.value : undefined).drain_timeout_seconds;
}
export async function runSetHub(args: SetHubArgs): Promise<void> {
	const configDir = args.configDir || "config";
	const dataDir = resolveDataDir(configDir);
	console.log(`Setting cluster hub to: ${args.hostName}`);
	const { db, siteId } = openBoundDBWithSite(dataDir);
	try {
		// Step 1: Set drain flag
		// TODO: For multi-hub clusters, this should be in cluster_config (synced) so all
		// hubs see the drain signal. Currently in host_meta (local-only), which works for
		// single-hub deployments where the draining hub is the one running this command.
		// Raw read justification: this call writes local-only host metadata; it is not a read.
		db.query("INSERT OR REPLACE INTO host_meta (key, value) VALUES (?, ?)").run(
			"relay_draining",
			"true",
		);
		console.log("Relay drain mode enabled.");

		// Step 2: Wait for the peer-targeted durable spool to drain
		const drainTimeoutSeconds = await loadDrainTimeoutSeconds(configDir);
		const drainTimeoutMs = drainTimeoutSeconds * 1000;
		const drainStart = Date.now();
		let drained = false;

		console.log(`Waiting for durable peer spool to drain (timeout: ${drainTimeoutSeconds}s)...`);

		while (Date.now() - drainStart < drainTimeoutMs) {
			const pendingCount = countPendingPeerTargetedDurableWork(db, siteId);

			if (pendingCount === 0) {
				drained = true;
				console.log("Durable peer spool drained successfully.");
				break;
			}

			console.log(`Draining durable peer spool: ${pendingCount} entries remaining...`);
			await Bun.sleep(1000);
		}

		if (!drained) {
			const remainingCount = countPendingPeerTargetedDurableWork(db, siteId);
			console.warn(
				`Drain timeout reached with ${remainingCount} durable peer spool entries remaining. Proceeding with hub switch.`,
			);
		}

		// Record the timestamp when hub is set (used for polling)
		const hubChangeTimestamp = new Date().toISOString();
		upsertClusterConfig(db, CLUSTER_HUB_KEY, args.hostName, siteId);
		console.log("Cluster hub set successfully.");

		// Step 4: Clear drain flag
		// Raw read justification: this call deletes local-only host metadata; it is not a read.
		db.query("DELETE FROM host_meta WHERE key = 'relay_draining'").run();
		console.log("Relay drain mode disabled.");
		if (args.wait) {
			const timeoutMs = (args.timeout ?? 60) * 1000;
			const pollIntervalMs = 2000;
			const deadline = Date.now() + timeoutMs;
			console.log("Waiting for all peers to confirm...");
			let confirmed = false;
			while (Date.now() < deadline) {
				const peers = listSyncState(db);
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
				await Bun.sleep(pollIntervalMs);
			}
			if (confirmed) {
				console.log("All peers confirmed the hub change.");
			} else {
				console.warn(
					"Timeout: not all peers confirmed. The hub IS set, but some peers have not synced yet.",
				);
			}
		}
	} finally {
		db.close();
	}
}
