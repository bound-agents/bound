// The durable_work spool is the sole relay store; a populated legacy relay table
// refuses startup in schema.ts (docs/design/specs/2026-08-31-durable-work-consolidation.md).

/** Thrown when a relay payload exceeds the transport's byte ceiling. */
export class PayloadTooLargeError extends Error {
	constructor(size: number, limit: number) {
		super(`Relay payload size ${size} exceeds limit ${limit}`);
		this.name = "PayloadTooLargeError";
	}
}
