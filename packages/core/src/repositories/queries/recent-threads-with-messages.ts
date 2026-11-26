import type { Database } from "bun:sqlite";
import { getAll, queryBuilder } from "../../query-builder";

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
	return getAll(
		db,
		queryBuilder
			.selectFrom("threads")
			.select(["id", "title", "color", "last_message_at", "summary"])
			.where("user_id", "=", userId)
			.$if(Boolean(excludeThreadId), (qb) => qb.where("id", "!=", excludeThreadId as string))
			.where("deleted", "=", 0)
			.where(({ exists, selectFrom, lit }) =>
				exists(
					selectFrom("messages")
						.select(lit(1).as("one"))
						.whereRef("messages.thread_id", "=", "threads.id"),
				),
			)
			.orderBy("last_message_at", "desc")
			.limit(5)
			.$narrowType<{ color: number }>(),
	);
}
