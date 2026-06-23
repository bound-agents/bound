import type { Database } from "bun:sqlite";
import type { User } from "@bound/shared";

/** Read repository for the `users` table. See ./index.ts for conventions. */

export function findUserById(db: Database, id: string): User | null {
	return db.query("SELECT * FROM users WHERE id = ?").get(id) as User | null;
}

export function listUsers(db: Database): User[] {
	return db
		.query("SELECT * FROM users WHERE deleted = 0 ORDER BY display_name ASC")
		.all() as User[];
}

/** Existence check by id (no `deleted` filter — matches the raw read-back). */
export function findUserIdById(db: Database, id: string): { id: string } | null {
	return db.query("SELECT id FROM users WHERE id = ?").get(id) as { id: string } | null;
}

export function findUserDisplayNameById(db: Database, id: string): { display_name: string } | null {
	return db.query("SELECT display_name FROM users WHERE id = ? AND deleted = 0").get(id) as {
		display_name: string;
	} | null;
}
