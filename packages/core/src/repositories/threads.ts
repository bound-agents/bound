import type { Database } from "bun:sqlite";
import type { Thread } from "@bound/shared";

/**
 * Read repository for the `threads` table.
 *
 * Conventions (mirror across every repository module — see ./index.ts):
 *  - Standalone functions, `db: Database` first arg, no classes.
 *  - Return `SyncedTableRowMap[T] | null` (here `Thread | null`) for single-row
 *    finders; `Thread[]` for list finders.
 *  - bun:sqlite `.get()` returns `null` (NOT undefined) on an empty read — type
 *    the cast as `... | null` and guard for null at call sites.
 *  - Reads only. Writes go through insertRow/updateRow/softDelete in change-log.ts.
 */

export function findThreadById(db: Database, id: string): Thread | null {
	return db.query("SELECT * FROM threads WHERE id = ?").get(id) as Thread | null;
}

export function listThreadsByUser(db: Database, userId: string): Thread[] {
	return db
		.query("SELECT * FROM threads WHERE user_id = ? AND deleted = 0 ORDER BY last_message_at DESC")
		.all(userId) as Thread[];
}

/** `SELECT * FROM threads WHERE id = ? AND deleted = 0` — full row, live only. */
export function findLiveThreadById(db: Database, id: string): Thread | null {
	return db.query("SELECT * FROM threads WHERE id = ? AND deleted = 0").get(id) as Thread | null;
}

/** `SELECT id FROM threads WHERE id = ?` — existence probe, ignores deleted flag. */
export function findThreadIdById(db: Database, id: string): { id: string } | null {
	return db.query("SELECT id FROM threads WHERE id = ?").get(id) as { id: string } | null;
}

/** `SELECT id FROM threads WHERE id = ? AND deleted = 0` — existence probe, live only. */
export function findLiveThreadIdById(db: Database, id: string): { id: string } | null {
	return db.query("SELECT id FROM threads WHERE id = ? AND deleted = 0").get(id) as {
		id: string;
	} | null;
}

/** `SELECT interface FROM threads WHERE id = ? AND deleted = 0` — live only. */
export function findLiveThreadInterfaceById(
	db: Database,
	id: string,
): { interface: string | null } | null {
	return db.query("SELECT interface FROM threads WHERE id = ? AND deleted = 0").get(id) as {
		interface: string | null;
	} | null;
}

/** `SELECT user_id, interface FROM threads WHERE id = ?` — ignores deleted flag. */
export function findThreadUserAndInterfaceById(
	db: Database,
	id: string,
): { user_id: string; interface: string } | null {
	return db.query("SELECT user_id, interface FROM threads WHERE id = ?").get(id) as {
		user_id: string;
		interface: string;
	} | null;
}

/** `SELECT summary FROM threads WHERE id = ?` — ignores deleted flag. */
export function findThreadSummaryById(db: Database, id: string): { summary: string | null } | null {
	return db.query("SELECT summary FROM threads WHERE id = ?").get(id) as {
		summary: string | null;
	} | null;
}

/** `SELECT summary, summary_through, last_message_at FROM threads WHERE id = ?` — ignores deleted flag. */
export function findThreadSummaryStateById(
	db: Database,
	id: string,
): {
	summary: string | null;
	summary_through: string | null;
	last_message_at: string | null;
} | null {
	return db
		.query("SELECT summary, summary_through, last_message_at FROM threads WHERE id = ?")
		.get(id) as {
		summary: string | null;
		summary_through: string | null;
		last_message_at: string | null;
	} | null;
}

/** `SELECT title FROM threads WHERE id = ?` — ignores deleted flag. */
export function findThreadTitleById(db: Database, id: string): Pick<Thread, "title"> | null {
	return db.query("SELECT title FROM threads WHERE id = ?").get(id) as Pick<Thread, "title"> | null;
}

/** `SELECT created_at FROM threads WHERE id = ?` — ignores deleted flag. */
export function findThreadCreatedAtById(db: Database, id: string): { created_at: string } | null {
	return db.query("SELECT created_at FROM threads WHERE id = ?").get(id) as {
		created_at: string;
	} | null;
}

/** `SELECT model_hint FROM threads WHERE id = ?` — ignores deleted flag. */
export function findThreadModelHintById(
	db: Database,
	id: string,
): { model_hint: string | null } | null {
	return db.query("SELECT model_hint FROM threads WHERE id = ?").get(id) as {
		model_hint: string | null;
	} | null;
}

/**
 * `SELECT id FROM threads WHERE last_message_at < ? AND deleted = 0` — live
 * threads idle since the cutoff timestamp.
 */
export function listLiveThreadIdsIdleBefore(
	db: Database,
	cutoffTime: string,
): Array<{ id: string }> {
	return db
		.query("SELECT id FROM threads WHERE last_message_at < ? AND deleted = 0")
		.all(cutoffTime) as Array<{ id: string }>;
}

/**
 * `SELECT color FROM threads WHERE deleted = 0 AND interface NOT IN (...) ORDER
 * BY created_at DESC LIMIT 1` — color of the most recently created live thread,
 * excluding a fixed list of non-user-facing interfaces. The exclusion list is a
 * constant array bound as parameters.
 */
export function findLatestThreadColorExcludingInterfaces(
	db: Database,
	excludedInterfaces: readonly string[],
): { color: number } | null {
	const placeholders = excludedInterfaces.map(() => "?").join(", ");
	return db
		.query(
			`SELECT color FROM threads WHERE deleted = 0 AND interface NOT IN (${placeholders}) ORDER BY created_at DESC LIMIT 1`,
		)
		.get(...excludedInterfaces) as { color: number } | null;
}

/** `SELECT parent_thread_id FROM threads WHERE id = ?` — one link up the ancestry chain. */
export function findThreadParentIdById(
	db: Database,
	id: string,
): { parent_thread_id: string | null } | null {
	return db.query("SELECT parent_thread_id FROM threads WHERE id = ? AND deleted = 0").get(id) as {
		parent_thread_id: string | null;
	} | null;
}
