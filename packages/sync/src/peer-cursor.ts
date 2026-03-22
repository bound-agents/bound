import type { Database } from "bun:sqlite";
import type { SyncState } from "@bound/shared";

export function getPeerCursor(db: Database, peerSiteId: string): SyncState | null {
	const result = db
		.query(
			`SELECT peer_site_id, last_received, last_sent, last_sync_at, sync_errors
			FROM sync_state
			WHERE peer_site_id = ?`,
		)
		.get(peerSiteId) as SyncState | undefined;

	return result ?? null;
}

export function updatePeerCursor(
	db: Database,
	peerSiteId: string,
	updates: Partial<Pick<SyncState, "last_received" | "last_sent" | "sync_errors">>,
): void {
	const now = new Date().toISOString();

	// Build UPDATE clause for conflicts
	const updateKeys = Object.keys(updates);
	const setClauses = [...updateKeys.map((key) => `${key} = ?`), "last_sync_at = ?"];
	const setValues: (number | string)[] = [
		...updateKeys.map((key) => (updates[key as keyof typeof updates] ?? 0) as number | string),
		now,
	];

	db.run(
		`INSERT INTO sync_state (peer_site_id, last_received, last_sent, sync_errors, last_sync_at)
		VALUES (?, COALESCE(?, 0), COALESCE(?, 0), COALESCE(?, 0), ?)
		ON CONFLICT(peer_site_id) DO UPDATE SET
		${setClauses.join(", ")}`,
		[
			peerSiteId,
			updates.last_received ?? 0,
			updates.last_sent ?? 0,
			updates.sync_errors ?? 0,
			now,
			...setValues,
		] as const,
	);
}

export function resetSyncErrors(db: Database, peerSiteId: string): void {
	db.run("UPDATE sync_state SET sync_errors = 0 WHERE peer_site_id = ?", [peerSiteId]);
}

export function incrementSyncErrors(db: Database, peerSiteId: string): void {
	// First try to insert if doesn't exist
	db.run(
		`INSERT INTO sync_state (peer_site_id, sync_errors, last_received, last_sent)
		VALUES (?, 1, 0, 0)
		ON CONFLICT(peer_site_id) DO UPDATE SET
		sync_errors = sync_errors + 1`,
		[peerSiteId],
	);
}

export function getMinConfirmedSeq(db: Database): number {
	const result = db.query("SELECT MIN(last_received) as min_seq FROM sync_state").get() as
		| { min_seq: number | null }
		| undefined;

	return result?.min_seq ?? 0;
}
