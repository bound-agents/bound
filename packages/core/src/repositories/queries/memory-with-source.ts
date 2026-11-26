import type { Database } from "bun:sqlite";
import { getAll, queryBuilder } from "../../query-builder";

/**
 * Cross-table reads that resolve a `semantic_memory` entry's source pointer
 * (its `source` column, which may be a task id or a thread id) into a
 * human-readable label by LEFT JOINing `tasks` and `threads`. One finder per
 * volatile-context staging tier (L0 pinned, L1 summaries + their
 * summarizes-children, L2 graph-seeded source enrichment, L3 recency).
 */

/** A `semantic_memory` row with its source resolved against tasks/threads. */
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

const MEMORY_SOURCE_COLUMNS = [
	"t_src.trigger_spec as task_name",
	"th_src.id as thread_id",
	"th_src.title as thread_title",
] as const;

/**
 * `semantic_memory m` LEFT JOINed to the live `tasks` / `threads` row its
 * `source` names.
 */
function memoryWithSourceJoins() {
	return queryBuilder
		.selectFrom("semantic_memory as m")
		.leftJoin("tasks as t_src", (join) =>
			join.onRef("m.source", "=", "t_src.id").on("t_src.deleted", "=", 0),
		)
		.leftJoin("threads as th_src", (join) =>
			join.onRef("m.source", "=", "th_src.id").on("th_src.deleted", "=", 0),
		);
}

/**
 * L0 — all pinned entries with resolved source, ordered `m.key ASC`.
 */
export function listPinnedMemoryWithSource(db: Database): MemoryWithSourceRow[] {
	return getAll(
		db,
		memoryWithSourceJoins()
			.select(["m.key", "m.value", "m.source", "m.modified_at", "m.tier", ...MEMORY_SOURCE_COLUMNS])
			.where("m.deleted", "=", 0)
			.where("m.tier", "=", "pinned")
			.orderBy("m.key", "asc")
			.$narrowType<{ tier: string }>(),
	);
}

/**
 * L1 — all summary-tier entries with resolved source, ordered
 * `m.modified_at DESC, m.key ASC`.
 */
export function listSummaryMemoryWithSource(db: Database): MemoryWithSourceRow[] {
	return getAll(
		db,
		memoryWithSourceJoins()
			.select(["m.key", "m.value", "m.source", "m.modified_at", "m.tier", ...MEMORY_SOURCE_COLUMNS])
			.where("m.tier", "=", "summary")
			.where("m.deleted", "=", 0)
			.orderBy("m.modified_at", "desc")
			.orderBy("m.key", "asc")
			.$narrowType<{ tier: string }>(),
	);
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
	return getAll(
		db,
		queryBuilder
			.selectFrom("memory_edges as e")
			.innerJoin("semantic_memory as m", (join) =>
				join.onRef("m.key", "=", "e.target_key").on("m.deleted", "=", 0),
			)
			.leftJoin("tasks as t_src", (join) =>
				join.onRef("m.source", "=", "t_src.id").on("t_src.deleted", "=", 0),
			)
			.leftJoin("threads as th_src", (join) =>
				join.onRef("m.source", "=", "th_src.id").on("th_src.deleted", "=", 0),
			)
			.select(["m.key", "m.value", "m.source", "m.modified_at", "m.tier", ...MEMORY_SOURCE_COLUMNS])
			.where("e.source_key", "=", summaryKey)
			.where("e.relation", "=", "summarizes")
			.where("e.deleted", "=", 0)
			.orderBy("m.key", "asc")
			.$narrowType<{ tier: string }>(),
	);
}

/**
 * L2 — for a set of memory keys (graph-seed results), resolve each key's source
 * label. `deleted` is not filtered on `m`: the seeds were already filtered
 * upstream. Returns `[]` for an empty `keys` array without touching the DB.
 */
export function listMemorySourceInfoByKeys(
	db: Database,
	keys: string[],
): Array<Pick<MemoryWithSourceRow, "key" | "task_name" | "thread_id" | "thread_title">> {
	if (keys.length === 0) return [];
	return getAll(
		db,
		memoryWithSourceJoins()
			.select(["m.key", ...MEMORY_SOURCE_COLUMNS])
			.where("m.key", "in", keys),
	);
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
	return getAll(
		db,
		memoryWithSourceJoins()
			.select([
				"m.key",
				"m.value",
				"m.source",
				"m.modified_at",
				"m.tier",
				"m.deleted",
				...MEMORY_SOURCE_COLUMNS,
			])
			.where("m.modified_at", ">", baseline)
			.where("m.key", "not like", "_internal.%")
			.where((eb) =>
				eb.or([
					eb("m.tier", "not in", ["detail", "pinned", "summary"]),
					eb.and([
						eb("m.tier", "=", "detail"),
						eb.not(
							eb.exists(
								eb
									.selectFrom("memory_edges as e")
									.select(eb.lit(1).as("one"))
									.whereRef("e.target_key", "=", "m.key")
									.where("e.relation", "=", "summarizes")
									.where("e.deleted", "=", 0),
							),
						),
					]),
				]),
			)
			.orderBy("m.modified_at", "desc")
			.limit(limit)
			.$narrowType<{ tier: string; deleted: number }>(),
	);
}
