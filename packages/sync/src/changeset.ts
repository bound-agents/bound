import type { Database } from "bun:sqlite";
import type { ChangeLogEntry, Result } from "@bound/shared";
import { err, ok } from "@bound/shared";

export interface Changeset {
	events: ChangeLogEntry[];
	source_site_id: string;
	source_seq_start: number;
	source_seq_end: number;
}

export function fetchOutboundChangeset(
	db: Database,
	peerSiteId: string,
	siteId: string,
): Changeset {
	// Get last_sent for this peer (defaults to 0 if no record exists)
	const cursor = db
		.query("SELECT last_sent FROM sync_state WHERE peer_site_id = ?")
		.get(peerSiteId) as { last_sent: number } | undefined;

	const lastSent = cursor?.last_sent ?? 0;

	// Fetch all events where seq > lastSent (from ALL sites, not just local)
	const events = db
		.query(
			`SELECT seq, table_name, row_id, site_id, timestamp, row_data
			FROM change_log
			WHERE seq > ?
			ORDER BY seq ASC`,
		)
		.all(lastSent) as ChangeLogEntry[];

	const sourceSeqStart = events.length > 0 ? events[0].seq : lastSent + 1;
	const sourceSeqEnd = events.length > 0 ? events[events.length - 1].seq : lastSent;

	return {
		events,
		source_site_id: siteId,
		source_seq_start: sourceSeqStart,
		source_seq_end: sourceSeqEnd,
	};
}

export function fetchInboundChangeset(
	db: Database,
	requesterSiteId: string,
	sinceSeq: number,
): Changeset {
	// Fetch events with echo suppression: exclude requester's own site_id
	const events = db
		.query(
			`SELECT seq, table_name, row_id, site_id, timestamp, row_data
			FROM change_log
			WHERE seq > ? AND site_id != ?
			ORDER BY seq ASC`,
		)
		.all(sinceSeq, requesterSiteId) as ChangeLogEntry[];

	const sourceSeqStart = events.length > 0 ? events[0].seq : sinceSeq + 1;
	const sourceSeqEnd = events.length > 0 ? events[events.length - 1].seq : sinceSeq;

	return {
		events,
		source_site_id: "",
		source_seq_start: sourceSeqStart,
		source_seq_end: sourceSeqEnd,
	};
}

export function serializeChangeset(changeset: Changeset): string {
	return JSON.stringify(changeset);
}

export function deserializeChangeset(json: string): Result<Changeset, Error> {
	try {
		const changeset = JSON.parse(json) as Changeset;
		return ok(changeset);
	} catch (error) {
		return err(error instanceof Error ? error : new Error("Failed to deserialize changeset"));
	}
}
