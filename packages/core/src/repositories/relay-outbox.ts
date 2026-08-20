import type { Database } from "bun:sqlite";

/** Local non-synchronized relay-outbox reads are centralized with that table. */
export function countUndeliveredRelayOutbox(db: Database): number {
	const row = db.query("SELECT COUNT(*) AS count FROM relay_outbox WHERE delivered = 0").get() as {
		count: number;
	} | null;
	return row?.count ?? 0;
}

export function findUndeliveredRelayOutboxById<T>(db: Database, id: string): T | null {
	return db.query("SELECT * FROM relay_outbox WHERE id = ? AND delivered = 0").get(id) as T | null;
}
