import type { Database } from "bun:sqlite";

/**
 * Cross-table read joining `threads` to `users` to resolve the display name of
 * a thread's owner. Used by `packages/agent/src/summary-extraction.ts` so the
 * generated summary references the user by name instead of "you".
 *
 * See ../index.ts for conventions. Reads only; bun:sqlite `.get()` returns
 * `null` on empty reads.
 */

/** Projection: the thread owner's display name. */
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
	return db
		.prepare("SELECT u.display_name FROM threads t JOIN users u ON t.user_id = u.id WHERE t.id = ?")
		.get(threadId) as ThreadUserDisplayNameRow | null;
}
