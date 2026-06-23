import type { Database } from "bun:sqlite";

/**
 * Cross-table read joining `semantic_memory` to `threads` to resolve each
 * memory entry's source thread title + color for the web memory-graph view
 * (`packages/web/src/server/routes/memory.ts`, `GET /graph`).
 *
 * See ../index.ts for conventions. Reads only.
 */

/**
 * One memory node for the graph view, with its source thread (if any) resolved
 * to a title + palette color. Column names mirror exactly what the route
 * destructures.
 */
export interface MemoryGraphNodeRow {
	id: string;
	key: string;
	value: string;
	tier: string;
	source: string | null;
	modified_at: string;
	/** threads.title when `source` is a live thread id, else null. */
	source_thread_title: string | null;
	/** threads.color when `source` is a live thread id, else null. */
	source_color: number | null;
}

/**
 * All non-deleted memory entries with their source thread title + color
 * resolved via LEFT JOIN threads (`sm.source = t.id AND t.deleted = 0`). No
 * ordering — the route builds the node set as-is.
 */
export function listMemoryGraphNodes(db: Database): MemoryGraphNodeRow[] {
	return db
		.query(
			`
		SELECT sm.id, sm.key, sm.value, sm.tier, sm.source, sm.modified_at,
			   t.title as source_thread_title, t.color as source_color
		FROM semantic_memory sm
		LEFT JOIN threads t ON sm.source = t.id AND t.deleted = 0
		WHERE sm.deleted = 0
	`,
		)
		.all() as MemoryGraphNodeRow[];
}
