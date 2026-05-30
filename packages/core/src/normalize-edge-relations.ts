import type { Database } from "bun:sqlite";
import { softDelete, updateRow } from "./change-log";
import { CANONICAL_RELATIONS, normalizeRelationValue } from "./memory-relations";

export interface NormalizationSummary {
	variants_mapped: number;
	moved_to_context: number;
	collisions_merged: number;
	tombstones_normalized: number;
	total_scanned: number;
}

/**
 * Normalize memory_edges relations to the canonical set.
 *
 * Must be called AFTER applySchema() (so the context column and triggers exist)
 * and AFTER siteId is available (because updateRow() needs it for changelog entries).
 *
 * Scans BOTH active rows and soft-deleted tombstones. Tombstones matter because a
 * soft-delete (UPDATE without touching `relation`) leaves the invalid relation value
 * in place — and the canonical-relation INSERT trigger fires for ANY row (regardless
 * of `deleted`), so a peer reseeding from a snapshot or backfill rejects the invalid
 * tombstone and re-warns on every reconnection until the source rewrites it. Rewriting
 * tombstones to a canonical relation makes them sync cleanly.
 *
 * Idempotent: when all rows are already canonical, returns zeros.
 */
export function normalizeEdgeRelations(db: Database, siteId: string): NormalizationSummary {
	const summary: NormalizationSummary = {
		variants_mapped: 0,
		moved_to_context: 0,
		collisions_merged: 0,
		tombstones_normalized: 0,
		total_scanned: 0,
	};

	// Build the NOT IN clause from canonical set
	const canonicalList = CANONICAL_RELATIONS.map((r) => `'${r}'`).join(", ");

	// Select all rows with non-canonical relations — active AND soft-deleted.
	const rows = db
		.prepare(
			`SELECT id, source_key, target_key, relation, weight, context, deleted
			 FROM memory_edges
			 WHERE relation NOT IN (${canonicalList})`,
		)
		.all() as Array<{
		id: string;
		source_key: string;
		target_key: string;
		relation: string;
		weight: number;
		context: string | null;
		deleted: number;
	}>;

	summary.total_scanned = rows.length;

	for (const row of rows) {
		const normalized = normalizeRelationValue(row.relation, row.context);
		const preserveInContext =
			normalized.relation !== row.relation && normalized.context !== row.context;

		// Soft-deleted tombstones: rewrite the relation in place (no collision merge —
		// a deleted edge must never fold its weight/context into an active edge). This
		// makes the tombstone sync cleanly without tripping the receiving trigger.
		if (row.deleted === 1) {
			const updates: Record<string, unknown> = { relation: normalized.relation };
			if (normalized.context !== row.context) {
				updates.context = normalized.context;
			}
			updateRow(db, "memory_edges", row.id, updates, siteId);
			summary.tombstones_normalized++;
			continue;
		}

		const targetRelation = normalized.relation;

		// Check for collision: does an active row already exist with
		// (source_key, target_key, targetRelation)?
		const collisionRow = db
			.prepare(
				`SELECT id, weight, context
				 FROM memory_edges
				 WHERE source_key = ? AND target_key = ? AND relation = ?
				   AND deleted = 0 AND id != ?`,
			)
			.get(row.source_key, row.target_key, targetRelation, row.id) as {
			id: string;
			weight: number;
			context: string | null;
		} | null;

		if (collisionRow) {
			// Collision-merge path:
			// - Survivor = the pre-existing row (collisionRow)
			// - Loser = the current row being normalized

			// Compute merged weight (max of both)
			const mergedWeight = Math.max(collisionRow.weight, row.weight);

			// Compute merged context (join distinct values with " | ")
			const contextParts: string[] = [];
			if (collisionRow.context) contextParts.push(collisionRow.context);
			if (preserveInContext && row.relation) contextParts.push(row.relation);
			if (row.context) contextParts.push(row.context);
			// Deduplicate parts
			const distinctParts = [...new Set(contextParts)];
			const mergedContext = distinctParts.length > 0 ? distinctParts.join(" | ") : null;

			// Update survivor with merged data
			const survivorUpdates: Record<string, unknown> = { weight: mergedWeight };
			if (mergedContext !== null) {
				survivorUpdates.context = mergedContext;
			}
			updateRow(db, "memory_edges", collisionRow.id, survivorUpdates, siteId);

			// Soft-delete the loser
			softDelete(db, "memory_edges", row.id, siteId);

			summary.collisions_merged++;
		} else {
			// No collision — straightforward rewrite
			const updates: Record<string, unknown> = { relation: targetRelation };

			if (preserveInContext) {
				// Join original relation with any existing context
				const contextParts: string[] = [];
				contextParts.push(row.relation);
				if (row.context) contextParts.push(row.context);
				updates.context = contextParts.join(" | ");
			}

			updateRow(db, "memory_edges", row.id, updates, siteId);

			if (preserveInContext) {
				summary.moved_to_context++;
			} else {
				summary.variants_mapped++;
			}
		}
	}

	return summary;
}
