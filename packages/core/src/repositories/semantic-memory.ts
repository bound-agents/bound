import type { Database } from "bun:sqlite";

/** All active entry values (used for token-frequency analysis). */
export function listMemoryValues(db: Database): Array<{ value: string }> {
	return db.query("SELECT value FROM semantic_memory WHERE deleted = 0").all() as Array<{
		value: string;
	}>;
}

export function findMemoryValueByKey(db: Database, key: string): { value: string } | null {
	return db.query("SELECT value FROM semantic_memory WHERE key = ? AND deleted = 0").get(key) as {
		value: string;
	} | null;
}

export function countMemoryByKeyPrefix(db: Database, keyPattern: string): number {
	return (
		db
			.query("SELECT COUNT(*) as count FROM semantic_memory WHERE key LIKE ? AND deleted = 0")
			.get(keyPattern) as { count: number }
	).count;
}

/**
 * Entry id for a key, including soft-deleted rows (used to avoid UNIQUE
 * violations before re-inserting). Intentionally omits the `deleted = 0` filter.
 */
export function findMemoryIdByKeyIncludingDeleted(
	db: Database,
	key: string,
): { id: string } | null {
	return db.query("SELECT id FROM semantic_memory WHERE key = ?").get(key) as { id: string } | null;
}

/** Active detail-tier entries ordered by most recently accessed. */
export function listDetailMemoryAccessOrder(
	db: Database,
): Array<{ id: string; key: string; last_accessed_at: string | null }> {
	return db
		.query(
			"SELECT id, key, last_accessed_at FROM semantic_memory WHERE tier = 'detail' AND deleted = 0 ORDER BY last_accessed_at DESC",
		)
		.all() as Array<{ id: string; key: string; last_accessed_at: string | null }>;
}

/** Distinct keys of active, non-internal entries modified after the baseline. */
export function listMemoryDeltaKeysSince(db: Database, baseline: string): Array<{ key: string }> {
	return db
		.query(
			`SELECT DISTINCT key FROM semantic_memory
			 WHERE modified_at > ?
			   AND deleted = 0
			   AND key NOT LIKE '_internal.%'`,
		)
		.all(baseline) as Array<{ key: string }>;
}

export function countActiveMemory(db: Database): number {
	return (
		db.query("SELECT COUNT(*) AS c FROM semantic_memory WHERE deleted = 0").get() as { c: number }
	).c;
}
