import type { Database } from "bun:sqlite";

/**
 * Cross-table reads over `memory_edges` JOIN `semantic_memory` that compute the
 * `summarizes` parent/child relationships used by the Working Knowledge and
 * Discoverable Archive renderers in `packages/agent/src/summary-extraction.ts`.
 *
 * See ../index.ts for conventions. Reads only.
 */

/**
 * Projection for a `summarizes` child resolved against its `semantic_memory`
 * row. Column names mirror exactly what `buildStaleChildrenMap` destructures.
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
	const placeholders = summaryKeys.map(() => "?").join(",");
	return db
		.prepare(
			`SELECT e.source_key AS parent, e.target_key AS child_key,
					m.value AS child_value, m.modified_at AS child_modified_at, m.tier AS tier
			 FROM memory_edges e
			 JOIN semantic_memory m ON m.key = e.target_key AND m.deleted = 0
			 WHERE e.relation = 'summarizes'
			   AND e.deleted = 0
			   AND e.source_key IN (${placeholders})`,
		)
		.all(...summaryKeys) as SummaryChildRow[];
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
 * resolved against live `semantic_memory` rows. Used by the R-VC9b compliance
 * check in `packages/agent/src/validation/r-vc9-compliance.ts`.
 */
export function listSummarizesChildrenKeyValue(
	db: Database,
	parentKey: string,
): SummaryChildKeyValueRow[] {
	return db
		.prepare(
			`SELECT m.key AS key, m.value AS value
             FROM memory_edges e
             JOIN semantic_memory m ON m.key = e.target_key AND m.deleted = 0
             WHERE e.relation = 'summarizes' AND e.deleted = 0 AND e.source_key = ?`,
		)
		.all(parentKey) as SummaryChildKeyValueRow[];
}
