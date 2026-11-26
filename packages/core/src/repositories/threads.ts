import type { Database } from "bun:sqlite";
import type { Thread } from "@bound/shared";

export function findThreadById(db: Database, id: string): Thread | null {
	return db.query("SELECT * FROM threads WHERE id = ?").get(id) as Thread | null;
}

export function findLiveThreadById(db: Database, id: string): Thread | null {
	return db.query("SELECT * FROM threads WHERE id = ? AND deleted = 0").get(id) as Thread | null;
}

export function findThreadIdById(db: Database, id: string): { id: string } | null {
	return db.query("SELECT id FROM threads WHERE id = ?").get(id) as { id: string } | null;
}

export function findLiveThreadIdById(db: Database, id: string): { id: string } | null {
	return db.query("SELECT id FROM threads WHERE id = ? AND deleted = 0").get(id) as {
		id: string;
	} | null;
}

export function findThreadUserAndInterfaceById(
	db: Database,
	id: string,
): { user_id: string; interface: string } | null {
	return db.query("SELECT user_id, interface FROM threads WHERE id = ?").get(id) as {
		user_id: string;
		interface: string;
	} | null;
}

export function findThreadSummaryById(db: Database, id: string): { summary: string | null } | null {
	return db.query("SELECT summary FROM threads WHERE id = ?").get(id) as {
		summary: string | null;
	} | null;
}

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

export function findThreadTitleById(db: Database, id: string): Pick<Thread, "title"> | null {
	return db.query("SELECT title FROM threads WHERE id = ?").get(id) as Pick<Thread, "title"> | null;
}

export function findThreadCreatedAtById(db: Database, id: string): { created_at: string } | null {
	return db.query("SELECT created_at FROM threads WHERE id = ?").get(id) as {
		created_at: string;
	} | null;
}

export function findThreadModelHintById(
	db: Database,
	id: string,
): { model_hint: string | null } | null {
	return db.query("SELECT model_hint FROM threads WHERE id = ?").get(id) as {
		model_hint: string | null;
	} | null;
}

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

/** One link up the ancestry chain (live rows only). */
export function findThreadParentIdById(
	db: Database,
	id: string,
): { parent_thread_id: string | null } | null {
	return db.query("SELECT parent_thread_id FROM threads WHERE id = ? AND deleted = 0").get(id) as {
		parent_thread_id: string | null;
	} | null;
}

/**
 * The owning aux identity, or null for a main-agent thread.
 *
 * Behavioral code identifies aux threads by `agent_id IS NOT NULL`, never by the
 * `interface` tag (#201) — `interface='aux'` is descriptive only.
 */
export function findThreadAgentIdById(
	db: Database,
	id: string,
): { agent_id: string | null } | null {
	return db.query("SELECT agent_id FROM threads WHERE id = ? AND deleted = 0").get(id) as {
		agent_id: string | null;
	} | null;
}
