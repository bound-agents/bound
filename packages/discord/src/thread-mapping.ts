import type { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import type { Thread, User } from "@bound/shared";

/**
 * Look up a user by their Discord ID.
 * Returns the user object if found, null otherwise.
 */
export function mapDiscordUser(db: Database, discordId: string): User | null {
	const user = db
		.query(
			`
		SELECT * FROM users
		WHERE discord_id = ? AND deleted = 0
		LIMIT 1
	`,
		)
		.get(discordId) as User | null;

	return user;
}

/**
 * Find or create a thread for a Discord user.
 * Queries for an existing non-deleted thread with this user_id and interface='discord'.
 * If found, returns it. If not, creates a new thread.
 */
export function findOrCreateThread(db: Database, userId: string, siteId: string): Thread {
	// Look for existing thread
	const existing = db
		.query(
			`
		SELECT * FROM threads
		WHERE user_id = ? AND interface = 'discord' AND deleted = 0
		LIMIT 1
	`,
		)
		.get(userId) as Thread | null;

	if (existing) {
		return existing;
	}

	// Create new thread
	const threadId = randomUUID();
	const now = new Date().toISOString();

	db.run(
		`INSERT INTO threads (id, user_id, interface, host_origin, created_at, last_message_at, modified_at, deleted)
		 VALUES (?, ?, ?, ?, ?, ?, ?, 0)`,
		[threadId, userId, "discord", siteId, now, now, now],
	);

	const thread = db.query("SELECT * FROM threads WHERE id = ?").get(threadId) as Thread;

	return thread;
}
