import type { Database } from "bun:sqlite";

/**
 * Cross-table read: sibling thread summaries for cross-thread injection (#178).
 * Distinct from `listRecentThreadsWithMessages` (which feeds the metadata-only
 * `buildCrossThreadDigest`): this query returns the summary *content* and
 * `summary_through`, filtered to threads whose summary was written within the
 * recency window.
 */

/** One sibling thread's summary content for cross-thread injection. */
export interface CrossThreadSummaryRow {
	id: string;
	title: string | null;
	summary: string;
	summary_through: string;
	last_message_at: string;
}

/**
 * The 5 most recently active live sibling threads (excluding `excludeThreadId`)
 * that have a non-null summary whose `summary_through` is at or after
 * `recencyCutoff` (an ISO-8601 timestamp). Ordered `last_message_at DESC LIMIT 5`.
 *
 * Threads with zero messages are excluded even if they carry a summary (same
 * gate as `listRecentThreadsWithMessages`).
 *
 * @param recencyCutoff ISO-8601 timestamp; only threads whose
 *   `summary_through >= recencyCutoff` are returned. Callers compute this
 *   as `now - 24h`.
 */
export function listCrossThreadSummaries(
	db: Database,
	userId: string,
	excludeThreadId: string,
	recencyCutoff: string,
): CrossThreadSummaryRow[] {
	const sql = `
		SELECT id, title, summary, summary_through, last_message_at
		FROM threads
		WHERE user_id = ?
		  AND id != ?
		  AND deleted = 0
		  AND summary IS NOT NULL
		  AND summary_through IS NOT NULL
		  AND summary_through >= ?
		  AND EXISTS (SELECT 1 FROM messages WHERE messages.thread_id = threads.id)
		ORDER BY last_message_at DESC
		LIMIT 5
	`;
	return db.prepare(sql).all(userId, excludeThreadId, recencyCutoff) as CrossThreadSummaryRow[];
}
