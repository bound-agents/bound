import type { Database } from "bun:sqlite";

/** Single-table reads for the local, unsynced `host_meta` key/value table. */
export function getHostMetaValue(db: Database, key: string): string | null {
	const row = db.query("SELECT value FROM host_meta WHERE key = ?").get(key) as {
		value: string;
	} | null;
	return row?.value ?? null;
}

export function getHostMetaSiteId(db: Database): string {
	return getHostMetaValue(db, "site_id") ?? "unknown";
}

export function getHostMetaHostName(db: Database): string | null {
	return getHostMetaValue(db, "host_name");
}
