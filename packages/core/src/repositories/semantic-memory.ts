import type { Database } from "bun:sqlite";
import type { SemanticMemory } from "@bound/shared";

/** Read repository for the `semantic_memory` table. See ./index.ts for conventions. */

export function findMemoryById(db: Database, id: string): SemanticMemory | null {
	return db.query("SELECT * FROM semantic_memory WHERE id = ?").get(id) as SemanticMemory | null;
}

export function findMemoryByKey(db: Database, key: string): SemanticMemory | null {
	return db
		.query("SELECT * FROM semantic_memory WHERE key = ? AND deleted = 0")
		.get(key) as SemanticMemory | null;
}

/** Active (id, key) pairs whose source matches the given id. */
export function listMemoryIdKeyBySource(
	db: Database,
	source: string,
): Array<{ id: string; key: string }> {
	return db
		.query("SELECT id, key FROM semantic_memory WHERE source = ? AND deleted = 0")
		.all(source) as Array<{ id: string; key: string }>;
}

/** Random sample of active summary/detail entries modified at or after the cutoff. */
export function listMemorySamplesByTierSince(
	db: Database,
	modifiedAtCutoff: string,
	limit: number,
): Array<{ key: string; value: string; tier: string }> {
	return db
		.query(
			`SELECT key, value, tier
             FROM semantic_memory
             WHERE deleted = 0
               AND tier IN ('summary', 'detail')
               AND modified_at >= ?
             ORDER BY RANDOM()
             LIMIT ?`,
		)
		.all(modifiedAtCutoff, limit) as Array<{ key: string; value: string; tier: string }>;
}

/** All active entry values (used for token-frequency analysis). */
export function listMemoryValues(db: Database): Array<{ value: string }> {
	return db.query("SELECT value FROM semantic_memory WHERE deleted = 0").all() as Array<{
		value: string;
	}>;
}

/** Active entry value for a key, or null if absent. */
export function findMemoryValueByKey(db: Database, key: string): { value: string } | null {
	return db.query("SELECT value FROM semantic_memory WHERE key = ? AND deleted = 0").get(key) as {
		value: string;
	} | null;
}

/** Count active entries whose key matches the given LIKE pattern. */
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

/** Count of all active entries. */
export function countActiveMemory(db: Database): number {
	return (
		db.query("SELECT COUNT(*) AS c FROM semantic_memory WHERE deleted = 0").get() as { c: number }
	).c;
}

/**
 * Count active pinned entries, optionally excluding a fixed set of system keys.
 * `excludeKeys` is a constant allowlist of reserved key names, not user input.
 */
export function countPinnedMemoryExcludingKeys(db: Database, excludeKeys: string[]): number {
	const notInClause =
		excludeKeys.length > 0 ? ` AND key NOT IN (${excludeKeys.map(() => "?").join(", ")})` : "";
	const row = db
		.query(
			`SELECT COUNT(*) as n FROM semantic_memory WHERE tier = 'pinned' AND deleted = 0${notInClause}`,
		)
		.get(...excludeKeys) as { n: number };
	return row.n;
}

/**
 * (id, deleted, tier) for a key, including soft-deleted rows. Intentionally
 * omits the `deleted = 0` filter so callers can detect tombstoned entries.
 */
export function findMemoryStateByKeyIncludingDeleted(
	db: Database,
	key: string,
): { id: string; deleted: number; tier: string } | null {
	return db.query("SELECT id, deleted, tier FROM semantic_memory WHERE key = ?").get(key) as {
		id: string;
		deleted: number;
		tier: string;
	} | null;
}

/** Active (id, key) pairs whose key matches the given LIKE pattern. */
export function listMemoryIdKeyByKeyPrefix(
	db: Database,
	keyPattern: string,
): Array<{ id: string; key: string }> {
	return db
		.query("SELECT id, key FROM semantic_memory WHERE key LIKE ? AND deleted = 0")
		.all(keyPattern) as Array<{ id: string; key: string }>;
}

/** (id, tier) for an active entry by key, or null. */
export function findMemoryIdTierByKey(
	db: Database,
	key: string,
): { id: string; tier: string } | null {
	return db
		.query("SELECT id, tier FROM semantic_memory WHERE key = ? AND deleted = 0")
		.get(key) as { id: string; tier: string } | null;
}

/** Entry id for an active key, or null. */
export function findMemoryIdByKey(db: Database, key: string): { id: string } | null {
	return db.query("SELECT id FROM semantic_memory WHERE key = ? AND deleted = 0").get(key) as {
		id: string;
	} | null;
}
