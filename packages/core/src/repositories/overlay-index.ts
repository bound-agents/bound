import type { Database } from "bun:sqlite";
import type { OverlayIndexEntry } from "@bound/shared";

/** Read repository for the `overlay_index` table. See ./index.ts for conventions. */

export function findOverlayContentHashByPathActive(
	db: Database,
	path: string,
): Pick<OverlayIndexEntry, "content_hash"> | null {
	return db
		.query("SELECT content_hash FROM overlay_index WHERE path = ? AND deleted = 0")
		.get(path) as Pick<OverlayIndexEntry, "content_hash"> | null;
}

/** Same as {@link findOverlayContentHashByPathActive}, looked up by row id instead of path. */
export function findOverlayContentHashByIdActive(
	db: Database,
	id: string,
): Pick<OverlayIndexEntry, "content_hash"> | null {
	return db
		.query("SELECT content_hash FROM overlay_index WHERE id = ? AND deleted = 0")
		.get(id) as Pick<OverlayIndexEntry, "content_hash"> | null;
}

export function listOverlayIdPathBySiteActive(
	db: Database,
	siteId: string,
): Array<Pick<OverlayIndexEntry, "id" | "path">> {
	return db
		.query("SELECT id, path FROM overlay_index WHERE site_id = ? AND deleted = 0")
		.all(siteId) as Array<Pick<OverlayIndexEntry, "id" | "path">>;
}
