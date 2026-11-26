import type { Database } from "bun:sqlite";

/** Single-table access for the local, unsynced `host_meta` key/value table. */
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

/** Returns the persisted `site_id`, minting and storing one on first boot. */
export function ensureHostMetaSiteId(
	db: Database,
	mint: () => string,
): {
	siteId: string;
	created: boolean;
} {
	const existing = getHostMetaValue(db, "site_id");
	if (existing) return { siteId: existing, created: false };
	const siteId = mint();
	db.run("INSERT INTO host_meta (key, value) VALUES (?, ?)", ["site_id", siteId]);
	return { siteId, created: true };
}
