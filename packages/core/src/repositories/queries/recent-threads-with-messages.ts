import type { Database } from "bun:sqlite";

/**
 * Cross-table read over `threads` gated by an `EXISTS` against `messages`:
 * the recent-threads set that feeds `buildCrossThreadDigest` in
 * `packages/agent/src/summary-extraction.ts`.
 *
 * See ../index.ts for conventions. Reads only.
 */

/**
 * One recent-thread row for the cross-thread digest. Column names mirror
 * exactly what `buildCrossThreadDigest` destructures.
 */
export interface RecentThreadWithMessagesRow {
	id: string;
	title: string | null;
	color: number;
	last_message_at: string;
	summary: string | null;
}

/**
 * The five most recently active live threads for a user that have at least one
 * message, ordered `last_message_at DESC LIMIT 5`. Pass `excludeThreadId` to
 * omit the current thread (the conditional `id != ?` clause is toggled inside
 * the finder). The `EXISTS (SELECT 1 FROM messages ...)` gate preserves the
 * original (unfiltered-by-deleted) message-existence check exactly.
 */
export function listRecentThreadsWithMessages(
	db: Database,
	userId: string,
	excludeThreadId?: string,
): RecentThreadWithMessagesRow[] {
	const hasMessages = "AND EXISTS (SELECT 1 FROM messages WHERE messages.thread_id = threads.id)";
	const sql = excludeThreadId
		? `SELECT id, title, color, last_message_at, summary FROM threads WHERE user_id = ? AND id != ? AND deleted = 0 ${hasMessages} ORDER BY last_message_at DESC LIMIT 5`
		: `SELECT id, title, color, last_message_at, summary FROM threads WHERE user_id = ? AND deleted = 0 ${hasMessages} ORDER BY last_message_at DESC LIMIT 5`;
	const params = excludeThreadId ? [userId, excludeThreadId] : [userId];
	return db.prepare(sql).all(...params) as RecentThreadWithMessagesRow[];
}
