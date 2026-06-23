import type { Database } from "bun:sqlite";
import type { AgentFile } from "@bound/shared";

/** Read repository for the `files` table. See ./index.ts for conventions. */

export function findFileById(db: Database, id: string): AgentFile | null {
	return db.query("SELECT * FROM files WHERE id = ?").get(id) as AgentFile | null;
}

export function findFileByIdActive(db: Database, id: string): AgentFile | null {
	return db.query("SELECT * FROM files WHERE id = ? AND deleted = 0").get(id) as AgentFile | null;
}

export function findFileByPathActive(db: Database, path: string): AgentFile | null {
	return db
		.query("SELECT * FROM files WHERE path = ? AND deleted = 0")
		.get(path) as AgentFile | null;
}

/** Read-back without a `deleted` filter (used by OCC pre-snapshot checks). */
export function findFileByPath(
	db: Database,
	path: string,
): Pick<AgentFile, "path" | "content" | "modified_at"> | null {
	return db.query("SELECT path, content, modified_at FROM files WHERE path = ?").get(path) as Pick<
		AgentFile,
		"path" | "content" | "modified_at"
	> | null;
}

/** Read-back without a `deleted` filter, including the `deleted` flag itself. */
export function findFileIdContentDeletedByPath(
	db: Database,
	path: string,
): Pick<AgentFile, "id" | "content" | "deleted"> | null {
	return db.query("SELECT id, content, deleted FROM files WHERE path = ?").get(path) as Pick<
		AgentFile,
		"id" | "content" | "deleted"
	> | null;
}

export function findFileIdContentByPathActive(
	db: Database,
	path: string,
): Pick<AgentFile, "id" | "content"> | null {
	return db.query("SELECT id, content FROM files WHERE path = ? AND deleted = 0").get(path) as Pick<
		AgentFile,
		"id" | "content"
	> | null;
}

export function findFileContentByPathActive(
	db: Database,
	path: string,
): Pick<AgentFile, "content"> | null {
	return db.query("SELECT content FROM files WHERE path = ? AND deleted = 0").get(path) as Pick<
		AgentFile,
		"content"
	> | null;
}

export function findFileContentModifiedByPathActive(
	db: Database,
	path: string,
): Pick<AgentFile, "content" | "modified_at"> | null {
	return db
		.query("SELECT content, modified_at FROM files WHERE path = ? AND deleted = 0")
		.get(path) as Pick<AgentFile, "content" | "modified_at"> | null;
}

export function findFileIdByPathActive(db: Database, path: string): Pick<AgentFile, "id"> | null {
	return db.query("SELECT id FROM files WHERE path = ? AND deleted = 0").get(path) as Pick<
		AgentFile,
		"id"
	> | null;
}

export function findFileIdByIdActive(db: Database, id: string): Pick<AgentFile, "id"> | null {
	return db.query("SELECT id FROM files WHERE id = ? AND deleted = 0").get(id) as Pick<
		AgentFile,
		"id"
	> | null;
}

export function findFileContentByIdActive(
	db: Database,
	id: string,
): Pick<AgentFile, "content"> | null {
	return db.query("SELECT content FROM files WHERE id = ? AND deleted = 0").get(id) as Pick<
		AgentFile,
		"content"
	> | null;
}

export function findFileContentBinaryByIdActive(
	db: Database,
	id: string,
): Pick<AgentFile, "content" | "is_binary"> | null {
	return db
		.query("SELECT content, is_binary FROM files WHERE id = ? AND deleted = 0")
		.get(id) as Pick<AgentFile, "content" | "is_binary"> | null;
}

export function listFilesActiveByCreatedDesc(db: Database): AgentFile[] {
	return db
		.query("SELECT * FROM files WHERE deleted = 0 ORDER BY created_at DESC")
		.all() as AgentFile[];
}

/** Active, non-mount files for full workspace hydration. */
export function listWorkspaceFiles(
	db: Database,
): Array<Pick<AgentFile, "path" | "content" | "is_binary">> {
	return db
		.query(
			"SELECT path, content, is_binary FROM files WHERE deleted = 0 AND path NOT LIKE '/mnt/%'",
		)
		.all() as Array<Pick<AgentFile, "path" | "content" | "is_binary">>;
}

/** Active, non-mount files modified since a cursor, for incremental re-hydration. */
export function listWorkspaceFilesModifiedSince(
	db: Database,
	sinceIso: string,
): Array<Pick<AgentFile, "path" | "content" | "is_binary">> {
	return db
		.query(
			"SELECT path, content, is_binary FROM files WHERE deleted = 0 AND path NOT LIKE '/mnt/%' AND modified_at > ?",
		)
		.all(sinceIso) as Array<Pick<AgentFile, "path" | "content" | "is_binary">>;
}

export function listFilePathContentByPrefixActive(
	db: Database,
	pathPattern: string,
): Array<Pick<AgentFile, "path" | "content">> {
	return db
		.query("SELECT path, content FROM files WHERE path LIKE ? AND deleted = 0")
		.all(pathPattern) as Array<Pick<AgentFile, "path" | "content">>;
}

export function listFileIdPathSizeByPrefixActive(
	db: Database,
	pathPattern: string,
): Array<Pick<AgentFile, "id" | "path" | "size_bytes">> {
	return db
		.query("SELECT id, path, size_bytes FROM files WHERE path LIKE ? AND deleted = 0")
		.all(pathPattern) as Array<Pick<AgentFile, "id" | "path" | "size_bytes">>;
}

export function listFilePathSizeModifiedByPrefixActive(
	db: Database,
	pathPattern: string,
): Array<Pick<AgentFile, "path" | "size_bytes" | "modified_at">> {
	return db
		.query(
			"SELECT path, size_bytes, modified_at FROM files WHERE path LIKE ? AND deleted = 0 ORDER BY path",
		)
		.all(pathPattern) as Array<Pick<AgentFile, "path" | "size_bytes" | "modified_at">>;
}
