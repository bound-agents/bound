import type { Database } from "bun:sqlite";

/**
 * Cross-table read over `threads` with an `EXISTS` subquery against `messages`:
 * find live threads with no summary that already have at least one assistant
 * message (i.e. worth summarizing). Powers post-restart summary-extraction
 * recovery in `packages/cli/src/commands/start/inference.ts`.
 *
 * See ../index.ts for conventions. Reads only.
 */

/** Projection: just the thread id. */
export interface ThreadIdRow {
	id: string;
}

/**
 * Live, summary-less threads that have ≥ 1 live assistant message, capped at
 * `limit`. Predicate preserved exactly: `t.deleted = 0 AND t.summary IS NULL`
 * AND an `EXISTS` against live `role = 'assistant'` messages.
 */
export function listThreadsNeedingSummary(db: Database, limit: number): ThreadIdRow[] {
	return db
		.query(
			`SELECT t.id FROM threads t
			 WHERE t.deleted = 0 AND t.summary IS NULL
			 AND EXISTS (SELECT 1 FROM messages m WHERE m.thread_id = t.id AND m.deleted = 0 AND m.role = 'assistant')
			 LIMIT ?`,
		)
		.all(limit) as ThreadIdRow[];
}
