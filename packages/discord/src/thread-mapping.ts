import type { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import { insertRow } from "@bound/core";
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
 * If found, returns it. If not, creates a new thread via insertRow for sync compliance.
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

	// Create new thread via insertRow for change-log outbox compliance
	const threadId = randomUUID();
	const now = new Date().toISOString();

	insertRow(
		db,
		"threads",
		{
			id: threadId,
			user_id: userId,
			interface: "discord",
			host_origin: siteId,
			color: 0,
			title: null,
			summary: null,
			created_at: now,
			last_message_at: now,
			modified_at: now,
			deleted: 0,
		},
		siteId,
	);

	const thread = db.query("SELECT * FROM threads WHERE id = ?").get(threadId) as Thread;

	return thread;
}
