import { getSiteId } from "@bound/core";
import { openBoundDB } from "../lib/db";

export interface SyncStatusArgs {
	configDir?: string;
}

interface SyncStateRow {
	peer_site_id: string;
	last_sync_at: string | null;
	last_sent: string | null;
	last_received: string | null;
	sync_errors: number;
}

interface ChangeLogRow {
	total: number;
	latest: string | null;
}

interface HostRow {
	site_id: string;
	host_name: string;
	online_at: string | null;
}

export async function runSyncStatus(args: SyncStatusArgs): Promise<void> {
	console.log("Checking sync status...\n");

	try {
		const db = openBoundDB(args.configDir);

		// Get local site_id
		const localSiteId = getSiteId(db);
		if (localSiteId === "unknown") {
			console.error("Failed to read site_id from database. Database may not be initialized.");
			db.close();
			process.exit(1);
		}
		console.log(`Local site_id: ${localSiteId}\n`);

		// Query change_log for total entries
		const changeLogRow = db
			.query("SELECT COUNT(*) as total, MAX(hlc) as latest FROM change_log")
			.get() as ChangeLogRow;

		console.log(
			`Change log: ${changeLogRow.total} entries, latest hlc: ${changeLogRow.latest ?? "none"}\n`,
		);

		// Query hosts
		const hosts = db
			.query("SELECT site_id, host_name, online_at FROM hosts WHERE deleted = 0")
			.all() as HostRow[];

		if (hosts.length > 0) {
			console.log("Registered hosts:");
			for (const host of hosts) {
				const siteIdShort = host.site_id.substring(0, 8);
				const onlineStatus = host.online_at ? new Date(host.online_at).toLocaleString() : "never";
				console.log(`  ${host.host_name} (${siteIdShort}...) - last online: ${onlineStatus}`);
			}
			console.log();
		} else {
			console.log("No hosts registered.\n");
		}

		// Query sync_state
		const syncStates = db
			.query(
				"SELECT peer_site_id, last_sync_at, last_sent, last_received, sync_errors FROM sync_state",
			)
			.all() as SyncStateRow[];

		if (syncStates.length === 0) {
			console.log("No peer sync state found.");
		} else {
			console.log("Peer sync status:");
			console.log("┌────────────┬──────────────────────┬────────────┬─────────────────┐");
			console.log("│ Site ID    │ Last Sync            │ Pending    │ Errors          │");
			console.log("├────────────┼──────────────────────┼────────────┼─────────────────┤");

			for (const state of syncStates) {
				const siteIdShort = `${state.peer_site_id.substring(0, 8)}..`;
				const lastSync = state.last_sync_at
					? new Date(state.last_sync_at).toLocaleString()
					: "never";
				// With HLC cursors, count pending events by querying change_log
				let pending: string | number = "?";
				if (state.last_sent !== null) {
					const pendingRow = db
						.query("SELECT COUNT(*) as count FROM change_log WHERE hlc > ?")
						.get(state.last_sent) as { count: number } | undefined;
					pending = pendingRow?.count ?? 0;
				}
				const errors = state.sync_errors || 0;

				console.log(
					`│ ${siteIdShort.padEnd(10)} │ ${lastSync.padEnd(20)} │ ${String(pending).padEnd(10)} │ ${String(errors).padEnd(15)} │`,
				);
			}

			console.log("└────────────┴──────────────────────┴────────────┴─────────────────┘");
		}

		db.close();
	} catch (error) {
		console.error("Failed to get sync status:", error);
		process.exit(1);
	}
}
