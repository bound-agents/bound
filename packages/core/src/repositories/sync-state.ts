import type { Database } from "bun:sqlite";
import { HLC_ZERO, type SyncState } from "@bound/shared";

/** Single-table reads for the local, unsynced `sync_state` table. */
export function getSyncStateByPeer(db: Database, peerSiteId: string): SyncState | null {
	const row = db
		.query(
			`SELECT peer_site_id, last_received, last_sent, last_confirmed, last_sync_at, sync_errors
			 FROM sync_state WHERE peer_site_id = ?`,
		)
		.get(peerSiteId) as SyncState | null;
	return row ?? null;
}

export function getPeerSiteId(db: Database): string | undefined {
	try {
		const row = db.query("SELECT peer_site_id FROM sync_state LIMIT 1").get() as {
			peer_site_id: string;
		} | null;
		return row?.peer_site_id;
	} catch {
		return undefined;
	}
}

export function listSyncState(db: Database): SyncState[] {
	return db
		.query(
			`SELECT peer_site_id, last_received, last_sent, last_confirmed, last_sync_at, sync_errors
			 FROM sync_state`,
		)
		.all() as SyncState[];
}

export function countSyncStatePeers(db: Database): number {
	const row = db.query("SELECT COUNT(*) AS count FROM sync_state").get() as {
		count: number;
	} | null;
	return row?.count ?? 0;
}

export function getMinSyncReceivedHlc(db: Database): string {
	const row = db.query("SELECT MIN(last_received) AS min_hlc FROM sync_state").get() as {
		min_hlc: string | null;
	} | null;
	return row?.min_hlc ?? HLC_ZERO;
}
