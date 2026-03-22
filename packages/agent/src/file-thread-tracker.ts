import type { Database } from "bun:sqlite";

const MEMORY_KEY_PREFIX = "_internal.file_thread.";

export function trackFilePath(db: Database, filePath: string, threadId: string): void {
	const key = MEMORY_KEY_PREFIX + filePath;
	const now = new Date().toISOString();

	// Check if memory entry exists
	const existing = db
		.prepare("SELECT id FROM semantic_memory WHERE key = ? AND deleted = 0")
		.get(key);

	if (existing) {
		// Update existing entry
		db.prepare("UPDATE semantic_memory SET value = ?, modified_at = ? WHERE key = ?").run(
			threadId,
			now,
			key,
		);
	} else {
		// Create new entry
		const id = Math.random().toString(36).substr(2, 9);
		db.prepare(
			`INSERT INTO semantic_memory (id, key, value, source, created_at, modified_at)
			 VALUES (?, ?, ?, ?, ?, ?)`,
		).run(id, key, threadId, filePath, now, now);
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
