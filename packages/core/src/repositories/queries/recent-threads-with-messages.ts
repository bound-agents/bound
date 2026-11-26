import type { Database } from "bun:sqlite";

export interface RecentThreadWithMessagesRow {
	id: string;
	title: string | null;
	color: number;
	last_message_at: string;
	summary: string | null;
}

/**
 * The five most recently active live threads for a user that have at least one
 * message (deleted messages count). Pass `excludeThreadId` to omit the current
 * thread.
 */
export function listRecentThreadsWithMessages(
	db: Database,
	userId: string,
	excludeThreadId?: string,
): RecentThreadWithMessagesRow[] {
	const excludeClause = excludeThreadId ? "AND id != ?" : "";
	const params = excludeThreadId ? [userId, excludeThreadId] : [userId];
	return db
		.prepare(
			`SELECT id, title, color, last_message_at, summary FROM threads
			 WHERE user_id = ? ${excludeClause} AND deleted = 0
			   AND EXISTS (SELECT 1 FROM messages WHERE messages.thread_id = threads.id)
			 ORDER BY last_message_at DESC LIMIT 5`,
		)
		.all(...params) as RecentThreadWithMessagesRow[];
}
