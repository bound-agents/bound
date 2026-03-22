import type { Database } from "bun:sqlite";

/**
 * Check if a user is allowlisted by their Discord ID.
 * Queries the users table for a non-deleted user with the matching discord_id.
 * Per spec R-W1: silent rejection for non-allowlisted users (no response, no error).
 */
export function isAllowlisted(discordId: string, db: Database): boolean {
	const result = db
		.query(
			`
		SELECT id FROM users
		WHERE discord_id = ? AND deleted = 0
		LIMIT 1
	`,
		)
		.get(discordId) as { id: string } | null;

	return result !== null && result !== undefined;
}
