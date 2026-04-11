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

/** Default max chunk size in bytes (50 MB plaintext, well under Bun's 128 MB default). */
export const DEFAULT_MAX_CHUNK_BYTES = 50 * 1024 * 1024;

/**
 * Split a changeset into smaller chunks that each serialize under maxBytes.
 * Events are HLC-ordered; each chunk gets its own hlc range.
 * Returns a single-element array if the changeset already fits.
 */
export function chunkChangeset(
	changeset: Changeset,
	maxBytes = DEFAULT_MAX_CHUNK_BYTES,
): Changeset[] {
	if (changeset.events.length === 0) return [changeset];

	// Fast path: check if the whole thing fits
	const full = serializeChangeset(changeset);
	if (new TextEncoder().encode(full).byteLength <= maxBytes) {
		return [changeset];
	}

	// Envelope overhead: {"events":[],"source_site_id":"...","source_hlc_start":"...","source_hlc_end":"..."}
	// Estimate ~200 bytes for the wrapper + commas between events.
	const envelopeOverhead = 256;
	const budget = maxBytes - envelopeOverhead;

	const chunks: Changeset[] = [];
	let currentEvents: ChangeLogEntry[] = [];
	let currentSize = 0;

	for (const event of changeset.events) {
		const eventSize = new TextEncoder().encode(JSON.stringify(event)).byteLength + 1; // +1 for comma
		if (currentEvents.length > 0 && currentSize + eventSize > budget) {
			// Flush current chunk
			chunks.push({
				events: currentEvents,
				source_site_id: changeset.source_site_id,
				source_hlc_start: currentEvents[0].hlc,
				source_hlc_end: currentEvents[currentEvents.length - 1].hlc,
			});
			currentEvents = [];
			currentSize = 0;
		}
		currentEvents.push(event);
		currentSize += eventSize;
	}

	// Flush final chunk
	if (currentEvents.length > 0) {
		chunks.push({
			events: currentEvents,
			source_site_id: changeset.source_site_id,
			source_hlc_start: currentEvents[0].hlc,
			source_hlc_end: currentEvents[currentEvents.length - 1].hlc,
		});
	}

	return chunks;
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
