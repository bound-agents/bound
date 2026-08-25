/** Soft-delete stale VFS files from ephemeral paths during heartbeat context build. */

import type { Database } from "bun:sqlite";
import { softDelete } from "@bound/core";

/** Files older than this are considered stale. */
const STALE_FILE_AGE_MS = 48 * 60 * 60 * 1000; // 48 hours

/** Ephemeral path prefixes that are safe to prune. */
const EPHEMERAL_PATH_PATTERNS = ["/tmp/%", "/home/user/.tool-results/%"] as const;

export function cleanupStaleFiles(db: Database, siteId: string): { pruned: number } {
	const cutoff = new Date(Date.now() - STALE_FILE_AGE_MS).toISOString();

	const likeClauses = EPHEMERAL_PATH_PATTERNS.map(() => "path LIKE ?").join(" OR ");
	const params = [cutoff, ...EPHEMERAL_PATH_PATTERNS];

	const rows = db
		.prepare(
			`SELECT id FROM files
			 WHERE deleted = 0 AND modified_at < ?
			 AND (${likeClauses})`,
		)
		.all(...params) as Array<{ id: string }>;

	for (const row of rows) {
		softDelete(db, "files", row.id, siteId);
	}

	return { pruned: rows.length };
}
