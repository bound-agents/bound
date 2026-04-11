import type { Database } from "bun:sqlite";
import type { ChangeLogEntry, RelayInboxEntry, RelayOutboxEntry, Result } from "@bound/shared";
import { HLC_ZERO, err, ok } from "@bound/shared";

export interface Changeset {
	events: ChangeLogEntry[];
	source_site_id: string;
	source_hlc_start: string;
	source_hlc_end: string;
}

export interface RelayRequest {
	relay_outbox: RelayOutboxEntry[];
}

export interface RelayResponse {
	relay_inbox: RelayInboxEntry[];
	relay_delivered: string[];
	relay_draining: boolean;
}

export function fetchOutboundChangeset(
	db: Database,
	peerSiteId: string,
	siteId: string,
): Changeset {
	// Get last_sent for this peer (defaults to HLC_ZERO if no record exists)
	const cursor = db
		.query("SELECT last_sent FROM sync_state WHERE peer_site_id = ?")
		.get(peerSiteId) as { last_sent: string } | undefined;

	const lastSent = cursor?.last_sent ?? HLC_ZERO;

	// Fetch all events where hlc > lastSent (from ALL sites, not just local)
	const events = db
		.query(
			`SELECT hlc, table_name, row_id, site_id, timestamp, row_data
			FROM change_log
			WHERE hlc > ?
			ORDER BY hlc ASC`,
		)
		.all(lastSent) as ChangeLogEntry[];

	const sourceHlcStart = events.length > 0 ? events[0].hlc : lastSent;
	const sourceHlcEnd = events.length > 0 ? events[events.length - 1].hlc : lastSent;

	return {
		events,
		source_site_id: siteId,
		source_hlc_start: sourceHlcStart,
		source_hlc_end: sourceHlcEnd,
	};
}

export function fetchInboundChangeset(
	db: Database,
	requesterSiteId: string,
	sinceHlc: string,
): Changeset {
	// Fetch events with echo suppression: exclude requester's own site_id
	const events = db
		.query(
			`SELECT hlc, table_name, row_id, site_id, timestamp, row_data
			FROM change_log
			WHERE hlc > ? AND site_id != ?
			ORDER BY hlc ASC`,
		)
		.all(sinceHlc, requesterSiteId) as ChangeLogEntry[];

	const sourceHlcStart = events.length > 0 ? events[0].hlc : sinceHlc;
	const sourceHlcEnd = events.length > 0 ? events[events.length - 1].hlc : sinceHlc;

	return {
		events,
		source_site_id: "",
		source_hlc_start: sourceHlcStart,
		source_hlc_end: sourceHlcEnd,
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
