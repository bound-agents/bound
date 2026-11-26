import type { Database } from "bun:sqlite";
import { agentNamespace } from "./queries/sql-fragments";

/** Includes soft-deleted tombstones. */
export function findEdgeDeletedStateById(
	db: Database,
	id: string,
): { id: string; deleted: number } | null {
	return db.prepare("SELECT id, deleted FROM memory_edges WHERE id = ?").get(id) as {
		id: string;
		deleted: number;
	} | null;
}

export function findActiveEdgeIdById(db: Database, id: string): { id: string } | null {
	return db.prepare("SELECT id FROM memory_edges WHERE id = ? AND deleted = 0").get(id) as {
		id: string;
	} | null;
}

export function listActiveEdgeIdsBySourceAndTarget(
	db: Database,
	sourceKey: string,
	targetKey: string,
	agentId: string | null = null,
): Array<{ id: string }> {
	const ns = agentNamespace(agentId);
	return db
		.prepare(
			`SELECT id FROM memory_edges WHERE source_key = ? AND target_key = ? AND deleted = 0 AND agent_id ${ns.sql}`,
		)
		.all(sourceKey, targetKey, ...ns.params) as Array<{ id: string }>;
}

/** Active edge ids referencing a key as either source or target. */
export function listActiveEdgeIdsReferencingKey(
	db: Database,
	memoryKey: string,
	agentId: string | null = null,
): Array<{ id: string }> {
	const ns = agentNamespace(agentId);
	return db
		.prepare(
			`SELECT id FROM memory_edges WHERE (source_key = ? OR target_key = ?) AND deleted = 0 AND agent_id ${ns.sql}`,
		)
		.all(memoryKey, memoryKey, ...ns.params) as Array<{ id: string }>;
}

/** (child -> parent) pairs for the given detail keys via incoming active `summarizes` edges. */
export function listSummarizesParentsByChildKeys(
	db: Database,
	targetKeys: readonly string[],
): Array<{ child: string; parent: string }> {
	const placeholders = targetKeys.map(() => "?").join(",");
	return db
		.prepare(
			`SELECT e.target_key AS child, e.source_key AS parent
			 FROM memory_edges e
			 WHERE e.relation = 'summarizes'
			   AND e.deleted = 0
			   AND e.target_key IN (${placeholders})`,
		)
		.all(...targetKeys) as Array<{ child: string; parent: string }>;
}
