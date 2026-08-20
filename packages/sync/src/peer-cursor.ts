import type { Database } from "bun:sqlite";
import { getMinSyncReceivedHlc } from "@bound/core";
import { HLC_ZERO, type SyncState } from "@bound/shared";

export function getPeerCursor(db: Database, peerSiteId: string): SyncState | null {
	const result = db
		.query(
			`SELECT peer_site_id, last_received, last_sent, last_confirmed, last_sync_at, sync_errors
			FROM sync_state
			WHERE peer_site_id = ?`,
		)
		.get(peerSiteId) as SyncState | undefined;

	return result ?? null;
}

export function updatePeerCursor(
	db: Database,
	peerSiteId: string,
	updates: Partial<
		Pick<SyncState, "last_received" | "last_sent" | "last_confirmed" | "sync_errors">
	>,
): void {
	const now = new Date().toISOString();

	// Build UPDATE clause for conflicts
	const updateKeys = Object.keys(updates);
	const setClauses = [...updateKeys.map((key) => `${key} = ?`), "last_sync_at = ?"];
	const setValues: (number | string)[] = [
		...updateKeys.map(
			(key) =>
				(updates[key as keyof typeof updates] ?? (key === "sync_errors" ? 0 : HLC_ZERO)) as
					| number
					| string,
		),
		now,
	];

	db.run(
		`INSERT INTO sync_state (peer_site_id, last_received, last_sent, last_confirmed, sync_errors, last_sync_at)
		VALUES (?, COALESCE(?, '${HLC_ZERO}'), COALESCE(?, '${HLC_ZERO}'), COALESCE(?, '${HLC_ZERO}'), COALESCE(?, 0), ?)
		ON CONFLICT(peer_site_id) DO UPDATE SET
		${setClauses.join(", ")}`,
		[
			peerSiteId,
			updates.last_received ?? HLC_ZERO,
			updates.last_sent ?? HLC_ZERO,
			updates.last_confirmed ?? HLC_ZERO,
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
		VALUES (?, 1, '${HLC_ZERO}', '${HLC_ZERO}')
		ON CONFLICT(peer_site_id) DO UPDATE SET
		sync_errors = sync_errors + 1`,
		[peerSiteId],
	);
}

/**
 * The confirmed-sync watermark for a peer: the highest HLC this peer has
 * acknowledged receiving from us (`last_confirmed`). This is the ONLY input
 * allowed to decide a delegation range anchor (R-UD11). A range segment may
 * cover a row only if that row's latest change_log HLC <= this watermark, so
 * the consumer is guaranteed to already hold every row the range points at.
 *
 * Defaults to HLC_ZERO when the peer has never acked (cold start) — which
 * forces all segments inline, the safe degenerate case (R-UD6).
 */
export function getConfirmedSyncWatermark(db: Database, peerSiteId: string): string {
	const cursor = getPeerCursor(db, peerSiteId);
	return cursor?.last_confirmed ?? HLC_ZERO;
}

export function getMinConfirmedHlc(db: Database): string {
	return getMinSyncReceivedHlc(db);
}
