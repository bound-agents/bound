import type { Database } from "bun:sqlite";
import { recordRelayOutboxOperation } from "../telemetry";

/** Local non-synchronized relay-outbox reads are centralized with that table. */
export function countUndeliveredRelayOutbox(db: Database): number {
	const row = db.query("SELECT COUNT(*) AS count FROM relay_outbox WHERE delivered = 0").get() as {
		count: number;
	} | null;
	const count = row?.count ?? 0;
	recordRelayOutboxOperation("read", count > 0 ? "hit" : "miss");
	return count;
}

export function findUndeliveredRelayOutboxById<T>(db: Database, id: string): T | null {
	const row = db
		.query("SELECT * FROM relay_outbox WHERE id = ? AND delivered = 0")
		.get(id) as T | null;
	recordRelayOutboxOperation("read", row ? "hit" : "miss");
	return row;
}
