// Release N+1: the legacy relay_outbox / relay_inbox tables and all their CRUD
// (writeOutbox, insertInbox, read*/markDelivered/markProcessed, pruneRelayTables)
// plus the slice-4E drain-and-drop machinery (hasDroppedLegacyRelayTables,
// dropLegacyRelayTables, …) and the vestigial `relay:outbox-written` push hook
// (setRelayOutboxEventBus) are demolished. The durable_work spool is the sole
// store, pushed on write via `durable_work:written`; a populated legacy table now
// refuses startup in schema.ts. See
// docs/design/specs/2026-08-31-durable-work-consolidation.md and #253.

/** Thrown when a relay payload exceeds the transport's byte ceiling. */
export class PayloadTooLargeError extends Error {
	constructor(size: number, limit: number) {
		super(`Relay payload size ${size} exceeds limit ${limit}`);
		this.name = "PayloadTooLargeError";
	}
}
