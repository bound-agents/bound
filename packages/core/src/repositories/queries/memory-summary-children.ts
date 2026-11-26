import type { Database } from "bun:sqlite";
import { getAll, getAllUncached, queryBuilder } from "../../query-builder";

/**
 * Cross-table reads over `memory_edges` JOIN `semantic_memory` that compute the
 * `summarizes` parent/child relationships behind the Working Knowledge and
 * Discoverable Archive renderers.
 */

/**
 * Active `summarizes` edges JOINed to the live child `semantic_memory` row
 * they target.
 */
function summarizesChildren() {
	return queryBuilder
		.selectFrom("memory_edges as e")
		.innerJoin("semantic_memory as m", (join) =>
			join.onRef("m.key", "=", "e.target_key").on("m.deleted", "=", 0),
		)
		.where("e.relation", "=", "summarizes")
		.where("e.deleted", "=", 0);
}

/**
 * Projection for a `summarizes` child resolved against its `semantic_memory`
 * row.
 */
export interface SummaryChildRow {
	/** edge.source_key — the parent summary key. */
	parent: string;
	/** edge.target_key — the child entry key. */
	child_key: string;
	child_value: string;
	child_modified_at: string;
	/** semantic_memory.tier of the child. */
	tier: string;
}

/**
 * For a set of summary keys, return each summary's outgoing `summarizes`
 * children resolved against the live `semantic_memory` rows. Staleness
 * (`child.modified_at > parent.modified_at`) is computed by the caller — this
 * finder returns ALL children. Returns `[]` for an empty `summaryKeys` array
 * without touching the DB.
 */
export function listSummaryChildrenForStaleness(
	db: Database,
	summaryKeys: string[],
): SummaryChildRow[] {
	if (summaryKeys.length === 0) return [];
	return getAllUncached(
		db,
		summarizesChildren()
			.select([
				"e.source_key as parent",
				"e.target_key as child_key",
				"m.value as child_value",
				"m.modified_at as child_modified_at",
				"m.tier as tier",
			])
			.where("e.source_key", "in", summaryKeys)
			.$narrowType<{ tier: string }>(),
	);
}

/**
 * Projection for the R-VC9b coverage check: a `summarizes` child key + value.
 */
export interface SummaryChildKeyValueRow {
	key: string;
	value: string;
}

/**
 * Children of a single parent summary key via outgoing `summarizes` edges,
 * resolved against live `semantic_memory` rows (R-VC9b compliance check).
 */
export function listSummarizesChildrenKeyValue(
	db: Database,
	parentKey: string,
): SummaryChildKeyValueRow[] {
	return getAll(
		db,
		summarizesChildren()
			.select(["m.key as key", "m.value as value"])
			.where("e.source_key", "=", parentKey),
	);
}
