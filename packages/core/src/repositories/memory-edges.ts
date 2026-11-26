import type { Database } from "bun:sqlite";
import { getAll, getOne, queryBuilder } from "../query-builder";

/** Includes soft-deleted tombstones. */
export function findEdgeDeletedStateById(
	db: Database,
	id: string,
): { id: string; deleted: number } | null {
	return getOne(
		db,
		queryBuilder
			.selectFrom("memory_edges")
			.select(["id", "deleted"])
			.where("id", "=", id)
			.$narrowType<{ deleted: number }>(),
	);
}

export function findActiveEdgeIdById(db: Database, id: string): { id: string } | null {
	return getOne(
		db,
		queryBuilder
			.selectFrom("memory_edges")
			.select("id")
			.where("id", "=", id)
			.where("deleted", "=", 0),
	);
}

export function listActiveEdgeIdsBySourceAndTarget(
	db: Database,
	sourceKey: string,
	targetKey: string,
	agentId: string | null = null,
): Array<{ id: string }> {
	return getAll(
		db,
		queryBuilder
			.selectFrom("memory_edges")
			.select("id")
			.where("source_key", "=", sourceKey)
			.where("target_key", "=", targetKey)
			.where("deleted", "=", 0)
			.where("agent_id", agentId === null ? "is" : "=", agentId),
	);
}

/** Active edge ids referencing a key as either source or target. */
export function listActiveEdgeIdsReferencingKey(
	db: Database,
	memoryKey: string,
	agentId: string | null = null,
): Array<{ id: string }> {
	return getAll(
		db,
		queryBuilder
			.selectFrom("memory_edges")
			.select("id")
			.where((eb) => eb.or([eb("source_key", "=", memoryKey), eb("target_key", "=", memoryKey)]))
			.where("deleted", "=", 0)
			.where("agent_id", agentId === null ? "is" : "=", agentId),
	);
}

/** (child -> parent) pairs for the given detail keys via incoming active `summarizes` edges. */
export function listSummarizesParentsByChildKeys(
	db: Database,
	targetKeys: readonly string[],
): Array<{ child: string; parent: string }> {
	return getAll(
		db,
		queryBuilder
			.selectFrom("memory_edges as e")
			.select(["e.target_key as child", "e.source_key as parent"])
			.where("e.relation", "=", "summarizes")
			.where("e.deleted", "=", 0)
			.where("e.target_key", "in", targetKeys),
	);
}
