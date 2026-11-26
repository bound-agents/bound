import type { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import { findMemoryIdByKeyIncludingDeleted, insertRow, updateRow } from "@bound/core";

const MEMORY_KEY_PREFIX = "_internal.file_thread.";

// Paths matching these patterns are ephemeral — they are unique per tool call,
// scratch writes, or OS pseudo-files that will never be meaningfully revisited
// across threads. Tracking them pollutes semantic_memory with unbounded,
// un-actionable rows. Skip them at the write site.
const EPHEMERAL_PATH_PATTERNS: RegExp[] = [
	/^\/tmp\//,
	/^\/private\/tmp\//,
	/^\/dev\//,
	/(^|\/)\.tool-results\//,
	/(^|\/)\.cache\//,
];

function isEphemeralPath(filePath: string): boolean {
	return EPHEMERAL_PATH_PATTERNS.some((re) => re.test(filePath));
}

// A Windows absolute path (`C:\...` or `C:/...`) can arrive with a spurious
// leading POSIX `/` prepended by the boundless/ACP path-resolution layer
// upstream (observed live: `/C:\Users\<user>\...`). Strip exactly that leading
// slash so the path keys canonically. Idempotent, and a no-op for POSIX paths
// (a leading `/` there is load-bearing and must survive).
const WINDOWS_DRIVE_WITH_LEADING_SLASH = /^\/([A-Za-z]:[\\/])/;

export function normalizeFilePathForKey(filePath: string): string {
	return filePath.replace(WINDOWS_DRIVE_WITH_LEADING_SLASH, "$1");
}

export function trackFilePath(
	db: Database,
	filePath: string,
	threadId: string,
	siteId: string,
): void {
	if (isEphemeralPath(filePath)) return;

	const key = MEMORY_KEY_PREFIX + normalizeFilePathForKey(filePath);
	const now = new Date().toISOString();

	// Include soft-deleted rows to avoid UNIQUE violations on the key.
	const existing = findMemoryIdByKeyIncludingDeleted(db, key);

	if (existing) {
		updateRow(
			db,
			"semantic_memory",
			existing.id,
			{ value: threadId, source: filePath, deleted: 0 },
			siteId,
		);
	} else {
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
				tier: "default",
				deleted: 0,
			},
			siteId,
		);
	}
}
