import type { Database } from "bun:sqlite";
import { getOne, queryBuilder } from "../../query-builder";

/**
 * Cross-table read joining `threads` to `users` to resolve the display name of
 * a thread's owner, so generated summaries can name the user instead of "you".
 */

export interface ThreadUserDisplayNameRow {
	display_name: string;
}

/**
 * Resolve the `users.display_name` for a thread's owner via
 * `threads JOIN users`. Returns `null` when the thread (or its user) is absent.
 * The thread's `deleted` flag is intentionally NOT filtered — the caller
 * resolves the owner name for summary generation regardless.
 */
export function getThreadUserDisplayName(
	db: Database,
	threadId: string,
): ThreadUserDisplayNameRow | null {
	return getOne(
		db,
		queryBuilder
			.selectFrom("threads as t")
			.innerJoin("users as u", "t.user_id", "u.id")
			.select("u.display_name")
			.where("t.id", "=", threadId),
	);
}
