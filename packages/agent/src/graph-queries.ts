import type { Database } from "bun:sqlite";
import { insertRow, softDelete, updateRow } from "@bound/core";
import { BOUND_NAMESPACE, deterministicUUID } from "@bound/shared";

/**
 * Compute the deterministic edge ID from the (source, target, relation) triple.
 * Uses the same deterministicUUID pattern as semantic_memory keys.
 */
export function edgeId(sourceKey: string, targetKey: string, relation: string): string {
	return deterministicUUID(BOUND_NAMESPACE, `${sourceKey}|${targetKey}|${relation}`);
}

/**
 * Create or restore a graph edge between two memory keys.
 *
 * If a soft-deleted edge with the same triple exists, restores it
 * with the new weight. If an active edge exists, updates its weight
 * and modified_at. Otherwise creates a new edge.
 *
 * Returns the edge ID.
 */
export function upsertEdge(
	db: Database,
	sourceKey: string,
	targetKey: string,
	relation: string,
	weight: number,
	siteId: string,
): string {
	const id = edgeId(sourceKey, targetKey, relation);
	const now = new Date().toISOString();

	// Check for existing edge (including soft-deleted) by deterministic ID
	const existing = db.prepare("SELECT id, deleted FROM memory_edges WHERE id = ?").get(id) as {
		id: string;
		deleted: number;
	} | null;

	if (existing) {
		// Update existing (active or soft-deleted) — restores if deleted
		updateRow(db, "memory_edges", id, { weight, deleted: 0 }, siteId);
	} else {
		// Create new edge
		insertRow(
			db,
			"memory_edges",
			{
				id,
				source_key: sourceKey,
				target_key: targetKey,
				relation,
				weight,
				created_at: now,
				modified_at: now,
				deleted: 0,
			},
			siteId,
		);
	}

	return id;
}

/**
 * Soft-delete edges between two keys.
 * If relation is provided, deletes only that specific edge.
 * If relation is omitted, deletes ALL edges between the two keys (both directions).
 */
export function removeEdges(
	db: Database,
	sourceKey: string,
	targetKey: string,
	relation: string | undefined,
	siteId: string,
): number {
	if (relation) {
		// Delete specific edge by triple
		const id = edgeId(sourceKey, targetKey, relation);
		const existing = db
			.prepare("SELECT id FROM memory_edges WHERE id = ? AND deleted = 0")
			.get(id) as { id: string } | null;
		if (existing) {
			softDelete(db, "memory_edges", id, siteId);
			return 1;
		}
		return 0;
	}

	// Delete all edges between the two keys (source->target direction only,
	// matching the design: disconnect <src> <tgt>)
	const edges = db
		.prepare("SELECT id FROM memory_edges WHERE source_key = ? AND target_key = ? AND deleted = 0")
		.all(sourceKey, targetKey) as Array<{ id: string }>;

	for (const edge of edges) {
		softDelete(db, "memory_edges", edge.id, siteId);
	}

	return edges.length;
}

/**
 * Soft-delete ALL edges referencing a memory key (as source OR target).
 * Used when a memory entry is forgotten — prevents dangling edges.
 */
export function cascadeDeleteEdges(db: Database, memoryKey: string, siteId: string): number {
	const edges = db
		.prepare("SELECT id FROM memory_edges WHERE (source_key = ? OR target_key = ?) AND deleted = 0")
		.all(memoryKey, memoryKey) as Array<{ id: string }>;

	for (const edge of edges) {
		softDelete(db, "memory_edges", edge.id, siteId);
	}

	return edges.length;
}

export interface TraversalResult {
	key: string;
	value: string;
	depth: number;
	viaRelation: string | null;
	viaWeight: number | null;
	modifiedAt: string;
}

export interface NeighborResult {
	key: string;
	value: string;
	relation: string;
	weight: number;
	direction: "out" | "in";
}

const MAX_DEPTH = 3;

/**
 * Walk the memory graph from a starting key using a recursive CTE.
 * Returns all reachable entries up to the given depth.
 * Cycle prevention uses path-string with /key/ delimiters.
 *
 * @param depth - Max traversal depth (1-3, default 2, clamped to MAX_DEPTH)
 * @param relation - Optional filter to only follow edges of this type
 */
export function traverseGraph(
	db: Database,
	startKey: string,
	depth = 2,
	relation?: string,
): TraversalResult[] {
	const effectiveDepth = Math.min(Math.max(depth, 1), MAX_DEPTH);
	const relationParam = relation ?? null;

	const rows = db
		.prepare(
			`WITH RECURSIVE reachable(key, depth, path, via_relation, via_weight) AS (
				SELECT ?, 0, '/' || ? || '/', NULL, NULL
				UNION ALL
				SELECT e.target_key, r.depth + 1,
					   r.path || e.target_key || '/',
					   e.relation, e.weight
				FROM memory_edges e
				JOIN reachable r ON e.source_key = r.key
				WHERE r.depth < ?
				  AND e.deleted = 0
				  AND INSTR(r.path, '/' || e.target_key || '/') = 0
				  AND (? IS NULL OR e.relation = ?)
			)
			SELECT r.key, r.depth, r.via_relation, r.via_weight,
				   m.value, m.modified_at
			FROM reachable r
			JOIN semantic_memory m ON m.key = r.key AND m.deleted = 0
			WHERE r.depth > 0
			ORDER BY r.depth ASC, m.modified_at DESC`,
		)
		.all(startKey, startKey, effectiveDepth, relationParam, relationParam) as Array<{
		key: string;
		depth: number;
		via_relation: string | null;
		via_weight: number | null;
		value: string;
		modified_at: string;
	}>;

	return rows.map((r) => ({
		key: r.key,
		value: r.value,
		depth: r.depth,
		viaRelation: r.via_relation,
		viaWeight: r.via_weight,
		modifiedAt: r.modified_at,
	}));
}

/**
 * Return one-hop connections for a memory key.
 * Direction: "out" = edges where key is source, "in" = edges where key is target, "both" = both.
 */
export function getNeighbors(
	db: Database,
	key: string,
	direction: "out" | "in" | "both" = "both",
): NeighborResult[] {
	const results: NeighborResult[] = [];

	if (direction === "out" || direction === "both") {
		const outEdges = db
			.prepare(
				`SELECT e.target_key AS key, e.relation, e.weight, m.value
				 FROM memory_edges e
				 JOIN semantic_memory m ON m.key = e.target_key AND m.deleted = 0
				 WHERE e.source_key = ? AND e.deleted = 0
				 ORDER BY e.weight DESC, m.modified_at DESC`,
			)
			.all(key) as Array<{
			key: string;
			relation: string;
			weight: number;
			value: string;
		}>;

		for (const e of outEdges) {
			results.push({
				key: e.key,
				value: e.value,
				relation: e.relation,
				weight: e.weight,
				direction: "out",
			});
		}
	}

	if (direction === "in" || direction === "both") {
		const inEdges = db
			.prepare(
				`SELECT e.source_key AS key, e.relation, e.weight, m.value
				 FROM memory_edges e
				 JOIN semantic_memory m ON m.key = e.source_key AND m.deleted = 0
				 WHERE e.target_key = ? AND e.deleted = 0
				 ORDER BY e.weight DESC, m.modified_at DESC`,
			)
			.all(key) as Array<{
			key: string;
			relation: string;
			weight: number;
			value: string;
		}>;

		for (const e of inEdges) {
			results.push({
				key: e.key,
				value: e.value,
				relation: e.relation,
				weight: e.weight,
				direction: "in",
			});
		}
	}

	return results;
}

export interface GraphRetrievalResult {
	key: string;
	value: string;
	source: string | null;
	modifiedAt: string;
	retrievalMethod: "seed" | "graph" | "recency";
	depth?: number;
	viaRelation?: string;
}

/**
 * Graph-seeded retrieval for context assembly.
 * 1. Find seed memories via keyword matching
 * 2. Run depth-2 traversal from each seed
 * 3. Deduplicate and cap at maxResults
 * 4. Return results tagged with retrieval method
 */
export function graphSeededRetrieval(
	db: Database,
	keywords: string[],
	maxResults: number,
	depth = 2,
): GraphRetrievalResult[] {
	if (keywords.length === 0) return [];

	// Step 1: Find seed memories via keyword matching
	const likeConditions = keywords.map(
		() => "(LOWER(key) LIKE '%' || ? || '%' OR LOWER(value) LIKE '%' || ? || '%')",
	);
	const params = keywords.flatMap((kw) => [kw, kw]);

	const seeds = db
		.prepare(
			`SELECT key, value, source, modified_at
			 FROM semantic_memory
			 WHERE deleted = 0
			   AND key NOT LIKE '_policy%' AND key NOT LIKE '_pinned%'
			   AND (${likeConditions.join(" OR ")})
			 ORDER BY modified_at DESC
			 LIMIT 10`,
		)
		.all(...params) as Array<{
		key: string;
		value: string;
		source: string | null;
		modified_at: string;
	}>;

	if (seeds.length === 0) return [];

	// Build result set with dedup
	const seen = new Set<string>();
	const results: GraphRetrievalResult[] = [];

	// Add seeds first
	for (const seed of seeds) {
		if (seen.has(seed.key)) continue;
		seen.add(seed.key);
		results.push({
			key: seed.key,
			value: seed.value,
			source: seed.source,
			modifiedAt: seed.modified_at,
			retrievalMethod: "seed",
		});
	}

	// Step 2: Traverse from each seed
	for (const seed of seeds) {
		if (results.length >= maxResults) break;

		const traversed = traverseGraph(db, seed.key, depth);
		for (const t of traversed) {
			if (seen.has(t.key)) continue;
			seen.add(t.key);

			// Look up source for the traversed entry
			const entry = db
				.prepare("SELECT source FROM semantic_memory WHERE key = ? AND deleted = 0")
				.get(t.key) as { source: string | null } | null;

			results.push({
				key: t.key,
				value: t.value,
				source: entry?.source ?? null,
				modifiedAt: t.modifiedAt,
				retrievalMethod: "graph",
				depth: t.depth,
				viaRelation: t.viaRelation ?? undefined,
			});

			if (results.length >= maxResults) break;
		}
	}

	return results.slice(0, maxResults);
}
