import type { Database } from "bun:sqlite";

/** Read repository for the `memory_edges` table. See ./index.ts for conventions. */

/**
 * Find an edge by id, including soft-deleted tombstones (NO `deleted = 0`
 * filter). Returns only `id` + `deleted`.
 */
export function findEdgeDeletedStateById(
	db: Database,
	id: string,
): { id: string; deleted: number } | null {
	return db.prepare("SELECT id, deleted FROM memory_edges WHERE id = ?").get(id) as {
		id: string;
		deleted: number;
	} | null;
}

/** Find an active (non-deleted) edge by id. Returns only `id`. */
export function findActiveEdgeIdById(db: Database, id: string): { id: string } | null {
	return db.prepare("SELECT id FROM memory_edges WHERE id = ? AND deleted = 0").get(id) as {
		id: string;
	} | null;
}

/** List active edge ids for a directed (source -> target) pair. */
export function listActiveEdgeIdsBySourceAndTarget(
	db: Database,
	sourceKey: string,
	targetKey: string,
	agentId: string | null = null,
): Array<{ id: string }> {
	const nsClause = agentId === null ? "AND agent_id IS NULL" : "AND agent_id = ?";
	const stmt = db.prepare(
		`SELECT id FROM memory_edges WHERE source_key = ? AND target_key = ? AND deleted = 0 ${nsClause}`,
	);
	return (
		agentId === null ? stmt.all(sourceKey, targetKey) : stmt.all(sourceKey, targetKey, agentId)
	) as Array<{ id: string }>;
}
/** List active edge ids referencing a key as either source OR target. */
export function listActiveEdgeIdsReferencingKey(
	db: Database,
	memoryKey: string,
	agentId: string | null = null,
): Array<{ id: string }> {
	const nsClause = agentId === null ? "AND agent_id IS NULL" : "AND agent_id = ?";
	const stmt = db.prepare(
		`SELECT id FROM memory_edges WHERE (source_key = ? OR target_key = ?) AND deleted = 0 ${nsClause}`,
	);
	return (
		agentId === null ? stmt.all(memoryKey, memoryKey) : stmt.all(memoryKey, memoryKey, agentId)
	) as Array<{ id: string }>;
}
/** List target keys of active `summarizes` edges outgoing from a source key. */
export function listSummarizesChildKeysBySource(
	db: Database,
	sourceKey: string,
): Array<{ target_key: string }> {
	return db
		.prepare(
			"SELECT target_key FROM memory_edges WHERE source_key = ? AND relation = 'summarizes' AND deleted = 0",
		)
		.all(sourceKey) as Array<{ target_key: string }>;
}

/** Count active incoming `summarizes` edges for a target key. */
export function countIncomingSummarizesEdges(db: Database, targetKey: string): number {
	const row = db
		.prepare(
			"SELECT COUNT(*) as cnt FROM memory_edges WHERE target_key = ? AND relation = 'summarizes' AND deleted = 0",
		)
		.get(targetKey) as { cnt: number };
	return row.cnt;
}

/**
 * List all edges (active AND soft-deleted) whose relation is NOT in the supplied
 * canonical-relation list. Pass the canonical relations as `canonicalRelations`;
 * the `NOT IN (...)` placeholder set is built from its length. Returns a column
 * subset including the non-`MemoryEdge` `context` column.
 */
export function listEdgesWithNonCanonicalRelation(
	db: Database,
	canonicalRelations: readonly string[],
): Array<{
	id: string;
	source_key: string;
	target_key: string;
	relation: string;
	weight: number;
	context: string | null;
	deleted: number;
}> {
	const placeholders = canonicalRelations.map(() => "?").join(", ");
	return db
		.prepare(
			`SELECT id, source_key, target_key, relation, weight, context, deleted
			 FROM memory_edges
			 WHERE relation NOT IN (${placeholders})`,
		)
		.all(...canonicalRelations) as Array<{
		id: string;
		source_key: string;
		target_key: string;
		relation: string;
		weight: number;
		context: string | null;
		deleted: number;
	}>;
}

/**
 * Find an active edge colliding on the (source, target, relation) triple,
 * excluding a given edge id. Returns `id`, `weight`, `context`.
 */
export function findCollidingActiveEdge(
	db: Database,
	sourceKey: string,
	targetKey: string,
	relation: string,
	excludeId: string,
): { id: string; weight: number; context: string | null } | null {
	return db
		.prepare(
			`SELECT id, weight, context
			 FROM memory_edges
			 WHERE source_key = ? AND target_key = ? AND relation = ?
			   AND deleted = 0 AND id != ?`,
		)
		.get(sourceKey, targetKey, relation, excludeId) as {
		id: string;
		weight: number;
		context: string | null;
	} | null;
}

/**
 * List all active edges as a (source, target, relation, modified_at) subset —
 * used to build the memory-graph view.
 */
export function listActiveEdgeSummaries(db: Database): Array<{
	source_key: string;
	target_key: string;
	relation: string;
	modified_at: string;
}> {
	return db
		.query(
			"SELECT source_key, target_key, relation, modified_at FROM memory_edges WHERE deleted = 0",
		)
		.all() as Array<{
		source_key: string;
		target_key: string;
		relation: string;
		modified_at: string;
	}>;
}

/**
 * For a set of detail keys, return each detail's (child -> parent) mapping via
 * incoming active `summarizes` edges. Pass `targetKeys`; the placeholder set is
 * built from its length.
 */
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
