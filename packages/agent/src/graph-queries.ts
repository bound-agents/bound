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
