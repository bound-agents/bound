import type { Database } from "bun:sqlite";

/**
 * Cross-table reads over `memory_edges` JOIN `semantic_memory` for knowledge-
 * graph traversal and one-hop neighbor lookup. Powers `traverseGraph` and
 * `getNeighbors` in `packages/agent/src/graph-queries.ts`.
 *
 * See ../index.ts for conventions. Reads only.
 */

/**
 * One row of a recursive graph traversal: a reachable entry resolved against
 * its live `semantic_memory` row, tagged with the edge it was reached through.
 * Column names mirror exactly what `traverseGraph` destructures.
 */
export interface GraphTraversalRow {
	key: string;
	depth: number;
	via_relation: string | null;
	via_weight: number | null;
	via_context: string | null;
	value: string;
	modified_at: string;
	source: string | null;
	tier: string;
}

/**
 * Walk the memory graph from `startKey` using a recursive CTE, up to
 * `effectiveDepth` hops (the caller clamps depth). Cycle prevention uses a
 * `/key/`-delimited path string. Optionally filter to a single `relation`
 * (`relationParam = null` follows all relations). Joins to live `semantic_memory`
 * and orders `r.depth ASC, m.modified_at DESC`.
 *
 * Bind order: `startKey, startKey, effectiveDepth, relationParam, relationParam`.
 */
export function traverseMemoryGraph(
	db: Database,
	startKey: string,
	effectiveDepth: number,
	relationParam: string | null,
): GraphTraversalRow[] {
	return db
		.prepare(
			`WITH RECURSIVE reachable(key, depth, path, via_relation, via_weight, via_context) AS (
				SELECT ?, 0, '/' || ? || '/', NULL, NULL, NULL
				UNION ALL
				SELECT e.target_key, r.depth + 1,
					   r.path || e.target_key || '/',
					   e.relation, e.weight, e.context
				FROM memory_edges e
				JOIN reachable r ON e.source_key = r.key
				WHERE r.depth < ?
				  AND e.deleted = 0
				  AND INSTR(r.path, '/' || e.target_key || '/') = 0
				  AND (? IS NULL OR e.relation = ?)
			)
			SELECT r.key, r.depth, r.via_relation, r.via_weight, r.via_context,
				   m.value, m.modified_at, m.source, m.tier
			FROM reachable r
			JOIN semantic_memory m ON m.key = r.key AND m.deleted = 0
			WHERE r.depth > 0
			ORDER BY r.depth ASC, m.modified_at DESC`,
		)
		.all(startKey, startKey, effectiveDepth, relationParam, relationParam) as GraphTraversalRow[];
}

/**
 * One neighbor edge resolved against its live `semantic_memory` row. Column
 * names mirror exactly what `getNeighbors` destructures.
 */
export interface GraphNeighborRow {
	key: string;
	relation: string;
	weight: number;
	context: string | null;
	value: string;
	modified_at: string;
}

/**
 * Outgoing one-hop neighbors of `key`: edges where `key` is the source,
 * resolved against the live target `semantic_memory` row. Ordered
 * `e.weight DESC, m.modified_at DESC`.
 */
export function listOutgoingNeighbors(db: Database, key: string): GraphNeighborRow[] {
	return db
		.prepare(
			`SELECT e.target_key AS key, e.relation, e.weight, e.context, m.value, m.modified_at
			 FROM memory_edges e
			 JOIN semantic_memory m ON m.key = e.target_key AND m.deleted = 0
			 WHERE e.source_key = ? AND e.deleted = 0
			 ORDER BY e.weight DESC, m.modified_at DESC`,
		)
		.all(key) as GraphNeighborRow[];
}

/**
 * Incoming one-hop neighbors of `key`: edges where `key` is the target,
 * resolved against the live source `semantic_memory` row. Ordered
 * `e.weight DESC, m.modified_at DESC`.
 */
export function listIncomingNeighbors(db: Database, key: string): GraphNeighborRow[] {
	return db
		.prepare(
			`SELECT e.source_key AS key, e.relation, e.weight, e.context, m.value, m.modified_at
			 FROM memory_edges e
			 JOIN semantic_memory m ON m.key = e.source_key AND m.deleted = 0
			 WHERE e.target_key = ? AND e.deleted = 0
			 ORDER BY e.weight DESC, m.modified_at DESC`,
		)
		.all(key) as GraphNeighborRow[];
}
