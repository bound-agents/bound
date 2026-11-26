import type { Database } from "bun:sqlite";
import type { AgentFile } from "@bound/shared";
import type { NotNull } from "kysely";
import { getAll, getOne, queryBuilder } from "../query-builder";

/**
 * `AgentFile` treats `is_binary` and `deleted` as non-null; the schema declares
 * them nullable with a default, so full-row reads narrow them.
 */
const fullFileRows = () =>
	queryBuilder
		.selectFrom("files")
		.selectAll()
		.$narrowType<{ is_binary: NotNull; deleted: NotNull }>();

export function findFileById(db: Database, id: string): AgentFile | null {
	return getOne(db, fullFileRows().where("id", "=", id));
}

export function findFileByIdActive(db: Database, id: string): AgentFile | null {
	return getOne(db, fullFileRows().where("id", "=", id).where("deleted", "=", 0));
}

export function findFileByPathActive(db: Database, path: string): AgentFile | null {
	return getOne(db, fullFileRows().where("path", "=", path).where("deleted", "=", 0));
}

/** Read-back without a `deleted` filter (used by OCC pre-snapshot checks). */
export function findFileByPath(
	db: Database,
	path: string,
): Pick<AgentFile, "path" | "content" | "modified_at"> | null {
	return getOne(
		db,
		queryBuilder
			.selectFrom("files")
			.select(["path", "content", "modified_at"])
			.where("path", "=", path),
	);
}

/** Read-back without a `deleted` filter, including the `deleted` flag itself. */
export function findFileIdContentDeletedByPath(
	db: Database,
	path: string,
): Pick<AgentFile, "id" | "content" | "deleted"> | null {
	return getOne(
		db,
		queryBuilder
			.selectFrom("files")
			.select(["id", "content", "deleted"])
			.where("path", "=", path)
			.$narrowType<{ deleted: NotNull }>(),
	);
}

/** Like {@link findFileContentByPathActive} but also returns `id`, for callers that need to follow up with an update/delete keyed by row id. */
export function findFileIdContentByPathActive(
	db: Database,
	path: string,
): Pick<AgentFile, "id" | "content"> | null {
	return getOne(
		db,
		queryBuilder
			.selectFrom("files")
			.select(["id", "content"])
			.where("path", "=", path)
			.where("deleted", "=", 0),
	);
}

export function findFileContentByPathActive(
	db: Database,
	path: string,
): Pick<AgentFile, "content"> | null {
	return getOne(
		db,
		queryBuilder
			.selectFrom("files")
			.select("content")
			.where("path", "=", path)
			.where("deleted", "=", 0),
	);
}

export function findFileIdByPathActive(db: Database, path: string): Pick<AgentFile, "id"> | null {
	return getOne(
		db,
		queryBuilder.selectFrom("files").select("id").where("path", "=", path).where("deleted", "=", 0),
	);
}

export function findFileContentByIdActive(
	db: Database,
	id: string,
): Pick<AgentFile, "content"> | null {
	return getOne(
		db,
		queryBuilder
			.selectFrom("files")
			.select("content")
			.where("id", "=", id)
			.where("deleted", "=", 0),
	);
}

/** Every active file, full rows, newest-created-first. Small-scale admin/debug listing — see {@link listWorkspaceFiles} for the bulk-hydration path. */
export function listFilesActiveByCreatedDesc(db: Database): AgentFile[] {
	return getAll(db, fullFileRows().where("deleted", "=", 0).orderBy("created_at", "desc"));
}

const workspaceFileRows = () =>
	queryBuilder
		.selectFrom("files")
		.select(["path", "content", "is_binary"])
		.where("deleted", "=", 0)
		.where("path", "not like", "/mnt/%")
		.$narrowType<{ is_binary: NotNull }>();

/** Active, non-mount files for full workspace hydration. */
export function listWorkspaceFiles(
	db: Database,
): Array<Pick<AgentFile, "path" | "content" | "is_binary">> {
	return getAll(db, workspaceFileRows());
}

/** Active, non-mount files modified since a cursor, for incremental re-hydration. */
export function listWorkspaceFilesModifiedSince(
	db: Database,
	sinceIso: string,
): Array<Pick<AgentFile, "path" | "content" | "is_binary">> {
	return getAll(db, workspaceFileRows().where("modified_at", ">", sinceIso));
}

/** Path + content of every active file whose path matches `pathPattern` (a SQL LIKE pattern) — bulk read for a directory-prefix listing. */
export function listFilePathContentByPrefixActive(
	db: Database,
	pathPattern: string,
): Array<Pick<AgentFile, "path" | "content">> {
	return getAll(
		db,
		queryBuilder
			.selectFrom("files")
			.select(["path", "content"])
			.where("path", "like", pathPattern)
			.where("deleted", "=", 0),
	);
}

/** Like {@link listFilePathContentByPrefixActive} but returns id + size instead of content — for a directory listing that shouldn't pull full file bodies. */
export function listFileIdPathSizeByPrefixActive(
	db: Database,
	pathPattern: string,
): Array<Pick<AgentFile, "id" | "path" | "size_bytes">> {
	return getAll(
		db,
		queryBuilder
			.selectFrom("files")
			.select(["id", "path", "size_bytes"])
			.where("path", "like", pathPattern)
			.where("deleted", "=", 0),
	);
}
