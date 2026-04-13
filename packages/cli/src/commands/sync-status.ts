import { getSiteId } from "@bound/core";
import { openBoundDB } from "../lib/db";

export interface SyncStatusArgs {
	configDir?: string;
}

function formatAge(ms: number): string {
	const seconds = Math.floor(ms / 1000);
	const minutes = Math.floor(seconds / 60);
	const hours = Math.floor(minutes / 60);
	const days = Math.floor(hours / 24);

	if (days > 0) {
		return `${days}d ago`;
	}
	if (hours > 0) {
		return `${hours}h ago`;
	}
	if (minutes > 0) {
		return `${minutes}m ago`;
	}
	return `${seconds}s ago`;
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
	modified_at: string | null;
}

interface RelayOutboxRow {
	kind: string;
	target_site_id: string;
	created_at: string;
}

interface RelayCountRow {
	count: number;
}

export async function runSyncStatus(_args: SyncStatusArgs): Promise<void> {
	console.log("Checking sync status...\n");

	try {
		const db = openBoundDB();

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
			.query("SELECT site_id, host_name, online_at, modified_at FROM hosts WHERE deleted = 0")
			.all() as HostRow[];

		if (hosts.length > 0) {
			console.log("Registered hosts:");
			for (const host of hosts) {
				const siteIdShort = host.site_id.substring(0, 8);
				const startedAt = host.online_at ? new Date(host.online_at).toLocaleString() : "never";
				const lastSeen = host.modified_at ? new Date(host.modified_at).toLocaleString() : "never";
				console.log(
					`  ${host.host_name} (${siteIdShort}...) - last seen: ${lastSeen}, started: ${startedAt}`,
				);
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
			console.log();
		}

		// Query relay status
		const outboxPending = db
			.query("SELECT COUNT(*) as count FROM relay_outbox WHERE delivered = 0")
			.get() as RelayCountRow;
		const outboxDelivered = db
			.query("SELECT COUNT(*) as count FROM relay_outbox WHERE delivered = 1")
			.get() as RelayCountRow;
		const inboxUnprocessed = db
			.query("SELECT COUNT(*) as count FROM relay_inbox WHERE processed = 0")
			.get() as RelayCountRow;
		const inboxProcessed = db
			.query("SELECT COUNT(*) as count FROM relay_inbox WHERE processed = 1")
			.get() as RelayCountRow;

		// Count stale entries (older than 1 hour)
		const oneHourAgo = new Date(Date.now() - 3600_000).toISOString();
		const stalePending = db
			.query("SELECT COUNT(*) as count FROM relay_outbox WHERE delivered = 0 AND created_at < ?")
			.get(oneHourAgo) as RelayCountRow;

		console.log("Relay:");
		const staleNote = stalePending.count > 0 ? ` (${stalePending.count} stale ⚠️)` : "";
		console.log(
			`  outbox: ${outboxPending.count} pending${staleNote}, ${outboxDelivered.count} delivered`,
		);
		console.log(
			`  inbox:  ${inboxUnprocessed.count} unprocessed, ${inboxProcessed.count} processed`,
		);

		// Show detail for pending outbox entries
		if (outboxPending.count > 0) {
			console.log();
			console.log("  Pending outbox:");
			const pendingEntries = db
				.query(
					"SELECT kind, target_site_id, created_at FROM relay_outbox WHERE delivered = 0 ORDER BY created_at ASC",
				)
				.all() as RelayOutboxRow[];

			for (const entry of pendingEntries) {
				const targetShort = entry.target_site_id.substring(0, 8);
				const age = Date.now() - new Date(entry.created_at).getTime();
				const ageStr = formatAge(age);

				const isStale = entry.created_at < oneHourAgo;
				const isInvalidTarget = !/^[0-9a-f]+$/.test(entry.target_site_id);

				const flags = [];
				if (isStale) {
					flags.push("⚠️ STALE");
				}
				if (isInvalidTarget) {
					flags.push("⚠️ INVALID TARGET");
				}
				const flagStr = flags.length > 0 ? ` ${flags.join(" ")}` : "";

				console.log(`    ${entry.kind} → ${targetShort}.. (${ageStr})${flagStr}`);
			}
		}

		db.close();
	} catch (error) {
		console.error("Failed to get sync status:", error);
		process.exit(1);
	}
}
