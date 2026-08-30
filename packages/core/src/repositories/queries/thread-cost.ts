import type { Database } from "bun:sqlite";

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
	return db
		.query(
			`SELECT SUM(cost_usd) AS total
			 FROM turns
			 WHERE deleted = 0
			   AND (
				thread_id = ?
				OR thread_id IN (SELECT id FROM threads WHERE parent_thread_id = ?)
			   )`,
		)
		.get(threadId, threadId) as { total: number | null };
}
