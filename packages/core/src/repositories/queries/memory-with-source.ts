import type { Database } from "bun:sqlite";

/**
 * Cross-table reads that resolve a `semantic_memory` entry's source pointer
 * (its `source` column, which may be a task id or a thread id) into a
 * human-readable label by LEFT JOINing `tasks` and `threads`.
 *
 * Powers the volatile-context staging tiers in
 * `packages/agent/src/summary-extraction.ts` (L0 pinned, L1 summaries + their
 * summarizes-children, L2 graph-seeded source enrichment, L3 recency).
 *
 * See ../index.ts for conventions. Reads only; bun:sqlite `.get()` returns
 * `null` on empty reads.
 */

/**
 * A `semantic_memory` row with its source resolved against tasks/threads.
 * Column names mirror exactly what `summary-extraction.ts` destructures.
 */
export interface MemoryWithSourceRow {
	key: string;
	value: string;
	source: string | null;
	modified_at: string;
	tier: string;
	/** tasks.trigger_spec when `source` is a live task id, else null. */
	task_name: string | null;
	/** threads.id when `source` is a live thread id, else null. */
	thread_id: string | null;
	/** threads.title when `source` is a live thread id, else null. */
	thread_title: string | null;
}

/**
 * Like {@link MemoryWithSourceRow} but additionally carries the row's `deleted`
 * flag (0/1). Used by the L3 recency stage, which renders soft-deleted entries
 * with a `[forgotten]` tag.
 */
export interface MemoryWithSourceAndDeletedRow extends MemoryWithSourceRow {
	deleted: number;
}

const MEMORY_SOURCE_JOIN = `LEFT JOIN tasks   t_src  ON m.source = t_src.id AND t_src.deleted = 0
		 LEFT JOIN threads th_src ON m.source = th_src.id AND th_src.deleted = 0`;

/**
 * L0 — all pinned entries with resolved source, ordered `m.key ASC`.
 */
export function listPinnedMemoryWithSource(db: Database): MemoryWithSourceRow[] {
	return db
		.prepare(
			`SELECT m.key, m.value, m.source, m.modified_at, m.tier,
			        t_src.trigger_spec AS task_name,
			        th_src.id          AS thread_id,
			        th_src.title       AS thread_title
			 FROM semantic_memory m
			 ${MEMORY_SOURCE_JOIN}
			 WHERE m.deleted = 0
			   AND m.tier = 'pinned'
			 ORDER BY m.key ASC`,
		)
		.all() as MemoryWithSourceRow[];
}

/**
 * L1 — all summary-tier entries with resolved source, ordered
 * `m.modified_at DESC, m.key ASC`.
 */
export function listSummaryMemoryWithSource(db: Database): MemoryWithSourceRow[] {
	return db
		.prepare(
			`SELECT m.key, m.value, m.source, m.modified_at, m.tier,
			        t_src.trigger_spec AS task_name,
			        th_src.id          AS thread_id,
			        th_src.title       AS thread_title
			 FROM semantic_memory m
			 ${MEMORY_SOURCE_JOIN}
			 WHERE m.tier = 'summary' AND m.deleted = 0
			 ORDER BY m.modified_at DESC, m.key ASC`,
		)
		.all() as MemoryWithSourceRow[];
}

/**
 * L1 children — entries reachable from a summary key via outgoing `summarizes`
 * edges, with resolved source, ordered `m.key ASC`. JOINs `memory_edges` →
 * `semantic_memory` (live only) and LEFT JOINs tasks/threads for source labels.
 */
export function listSummaryChildrenWithSource(
	db: Database,
	summaryKey: string,
): MemoryWithSourceRow[] {
	return db
		.prepare(
			`SELECT m.key, m.value, m.source, m.modified_at, m.tier,
			        t_src.trigger_spec AS task_name,
			        th_src.id          AS thread_id,
			        th_src.title       AS thread_title
			 FROM memory_edges e
			 JOIN semantic_memory m ON m.key = e.target_key AND m.deleted = 0
			 ${MEMORY_SOURCE_JOIN}
			 WHERE e.source_key = ? AND e.relation = 'summarizes' AND e.deleted = 0
			 ORDER BY m.key ASC`,
		)
		.all(summaryKey) as MemoryWithSourceRow[];
}

/**
 * L2 — for a set of memory keys (graph-seed results), resolve each key's source
 * label. `deleted` is intentionally NOT filtered on `m` here, matching the
 * production query (the seeds were already filtered upstream). Returns one row
 * per matched key. Returns `[]` for an empty `keys` array without touching the
 * DB.
 */
export function listMemorySourceInfoByKeys(
	db: Database,
	keys: string[],
): Array<Pick<MemoryWithSourceRow, "key" | "task_name" | "thread_id" | "thread_title">> {
	if (keys.length === 0) return [];
	const placeholders = keys.map(() => "?").join(",");
	return db
		.prepare(
			`SELECT m.key,
			        t_src.trigger_spec AS task_name,
			        th_src.id          AS thread_id,
			        th_src.title       AS thread_title
			 FROM semantic_memory m
			 ${MEMORY_SOURCE_JOIN}
			 WHERE m.key IN (${placeholders})`,
		)
		.all(...keys) as Array<
		Pick<MemoryWithSourceRow, "key" | "task_name" | "thread_id" | "thread_title">
	>;
}

/**
 * L3 — recency-ordered entries with resolved source, INCLUDING soft-deleted
 * rows (so `[forgotten]` entries can render). Excludes pinned/summary tiers and
 * non-orphan detail tiers (detail entries with an incoming `summarizes` edge),
 * plus `_internal.%` keys, requiring `modified_at > baseline`. Ordered
 * `m.modified_at DESC`, capped at `limit`.
 */
export function listRecencyMemoryWithSource(
	db: Database,
	baseline: string,
	limit: number,
): MemoryWithSourceAndDeletedRow[] {
	return db
		.prepare(
			`SELECT m.key, m.value, m.source, m.modified_at, m.tier, m.deleted,
			        t_src.trigger_spec AS task_name,
			        th_src.id          AS thread_id,
			        th_src.title       AS thread_title
			 FROM semantic_memory m
			 ${MEMORY_SOURCE_JOIN}
			 WHERE m.modified_at > ?
			   AND m.key NOT LIKE '_internal.%'
			   AND (
			     m.tier NOT IN ('detail', 'pinned', 'summary')
			     OR (m.tier = 'detail' AND NOT EXISTS (
			       SELECT 1 FROM memory_edges e
			       WHERE e.target_key = m.key AND e.relation = 'summarizes' AND e.deleted = 0
			     ))
			   )
			 ORDER BY m.modified_at DESC
			 LIMIT ?`,
		)
		.all(baseline, limit) as MemoryWithSourceAndDeletedRow[];
}
