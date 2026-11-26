import type { Database } from "bun:sqlite";
import { getOne, queryBuilder } from "../../query-builder";

/**
 * Whole-life spend for a user-facing thread and the aux-agent threads directly
 * created from it. Nested descendants are intentionally excluded: an aux
 * invocation is linked directly to its caller, and the statusline should show
 * only work the displayed thread delegated itself.
 */
export function sumTurnCostByThreadAndDirectChildren(
	db: Database,
	threadId: string,
): { total: number | null } {
	// An aggregate without GROUP BY always yields exactly one row.
	return (
		getOne(
			db,
			queryBuilder
				.selectFrom("turns")
				.select((eb) => eb.fn.sum<number | null>("cost_usd").as("total"))
				.where("deleted", "=", 0)
				.where((eb) =>
					eb.or([
						eb("thread_id", "=", threadId),
						eb(
							"thread_id",
							"in",
							eb.selectFrom("threads").select("id").where("parent_thread_id", "=", threadId),
						),
					]),
				),
		) ?? { total: null }
	);
}
