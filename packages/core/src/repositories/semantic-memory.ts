import type { Database } from "bun:sqlite";
import { getAll, getOne, queryBuilder } from "../query-builder";

/** All active entry values (used for token-frequency analysis). */
export function listMemoryValues(db: Database): Array<{ value: string }> {
	return getAll(
		db,
		queryBuilder.selectFrom("semantic_memory").select("value").where("deleted", "=", 0),
	);
}

export function findMemoryValueByKey(db: Database, key: string): { value: string } | null {
	return getOne(
		db,
		queryBuilder
			.selectFrom("semantic_memory")
			.select("value")
			.where("key", "=", key)
			.where("deleted", "=", 0),
	);
}

export function countMemoryByKeyPrefix(db: Database, keyPattern: string): number {
	const row = getOne(
		db,
		queryBuilder
			.selectFrom("semantic_memory")
			.select((eb) => eb.fn.countAll<number>().as("count"))
			.where("key", "like", keyPattern)
			.where("deleted", "=", 0),
	);
	return row?.count ?? 0;
}

/**
 * Entry id for a key, including soft-deleted rows (used to avoid UNIQUE
 * violations before re-inserting). Intentionally omits the `deleted = 0` filter.
 */
export function findMemoryIdByKeyIncludingDeleted(
	db: Database,
	key: string,
): { id: string } | null {
	return getOne(db, queryBuilder.selectFrom("semantic_memory").select("id").where("key", "=", key));
}

/** Active detail-tier entries ordered by most recently accessed. */
export function listDetailMemoryAccessOrder(
	db: Database,
): Array<{ id: string; key: string; last_accessed_at: string | null }> {
	return getAll(
		db,
		queryBuilder
			.selectFrom("semantic_memory")
			.select(["id", "key", "last_accessed_at"])
			.where("tier", "=", "detail")
			.where("deleted", "=", 0)
			.orderBy("last_accessed_at", "desc"),
	);
}

/** Distinct keys of active, non-internal entries modified after the baseline. */
export function listMemoryDeltaKeysSince(db: Database, baseline: string): Array<{ key: string }> {
	return getAll(
		db,
		queryBuilder
			.selectFrom("semantic_memory")
			.select("key")
			.distinct()
			.where("modified_at", ">", baseline)
			.where("deleted", "=", 0)
			.where("key", "not like", "_internal.%"),
	);
}

export function countActiveMemory(db: Database): number {
	const row = getOne(
		db,
		queryBuilder
			.selectFrom("semantic_memory")
			.select((eb) => eb.fn.countAll<number>().as("c"))
			.where("deleted", "=", 0),
	);
	return row?.c ?? 0;
}
