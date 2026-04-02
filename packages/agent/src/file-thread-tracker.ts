import type { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import { insertRow, updateRow } from "@bound/core";

const MEMORY_KEY_PREFIX = "_internal.file_thread.";

export function trackFilePath(
	db: Database,
	filePath: string,
	threadId: string,
	siteId: string,
): void {
	const key = MEMORY_KEY_PREFIX + filePath;
	const now = new Date().toISOString();

	// Check if memory entry exists (including soft-deleted to avoid UNIQUE violations)
	const existing = db.prepare("SELECT id FROM semantic_memory WHERE key = ?").get(key) as
		| { id: string }
		| undefined;

	if (existing) {
		// Update existing entry via change-log outbox
		updateRow(
			db,
			"semantic_memory",
			existing.id,
			{ value: threadId, source: filePath, deleted: 0 },
			siteId,
		);
	} else {
		// Create new entry via change-log outbox
		insertRow(
			db,
			"semantic_memory",
			{
				id: randomUUID(),
				key,
				value: threadId,
				source: filePath,
				created_at: now,
				modified_at: now,
				last_accessed_at: now,
				deleted: 0,
			},
			siteId,
		);
	}
}

export function getLastThreadForFile(db: Database, filePath: string): string | null {
	const key = MEMORY_KEY_PREFIX + filePath;
	const result = db
		.prepare("SELECT value FROM semantic_memory WHERE key = ? AND deleted = 0")
		.get(key) as { value: string } | undefined;

	return result?.value || null;
}

export function getFileThreadNotificationMessage(
	filePath: string,
	otherThreadTitle: string,
): string {
	return `File ${filePath} was modified from thread "${otherThreadTitle}".`;
}
