import Database from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { AgentFile } from "@bound/shared";
import { applyMetricsSchema, applySchema, insertRow, softDelete } from "../../index";
import {
	findFileById,
	findFileByIdActive,
	findFileByPath,
	findFileByPathActive,
	findFileContentBinaryByIdActive,
	findFileContentByIdActive,
	findFileContentByPathActive,
	findFileContentModifiedByPathActive,
	findFileIdByIdActive,
	findFileIdByPathActive,
	findFileIdContentByPathActive,
	findFileIdContentDeletedByPath,
	listFileIdPathSizeByPrefixActive,
	listFilePathContentByPrefixActive,
	listFilePathSizeModifiedByPrefixActive,
	listFilesActiveByCreatedDesc,
	listWorkspaceFiles,
	listWorkspaceFilesModifiedSince,
} from "../files";

const SITE = "site-test-0001";

/** Build a complete AgentFile row; every column from the type is populated. */
function makeFile(overrides: Partial<AgentFile> & Pick<AgentFile, "id" | "path">): AgentFile {
	return {
		content: "default-content",
		is_binary: 0,
		size_bytes: 14,
		created_at: "2026-01-01T00:00:00.000Z",
		modified_at: "2026-01-01T00:00:00.000Z",
		deleted: 0,
		created_by: SITE,
		host_origin: SITE,
		...overrides,
	};
}

let db: Database;

beforeEach(() => {
	db = new Database(":memory:");
	applySchema(db);
	applyMetricsSchema(db);
});

afterEach(() => {
	db.close();
});

describe("findFileById", () => {
	it("returns the row regardless of deleted flag (happy path)", () => {
		insertRow(db, "files", makeFile({ id: "f1", path: "/a.txt", content: "hello" }), SITE);

		const row = findFileById(db, "f1");
		expect(row).not.toBeNull();
		expect(row?.id).toBe("f1");
		expect(row?.path).toBe("/a.txt");
		expect(row?.content).toBe("hello");
	});

	it("returns null for an absent id (miss path)", () => {
		expect(findFileById(db, "nope")).toBeNull();
	});
});

describe("findFileByIdActive", () => {
	it("returns a live row by id", () => {
		insertRow(db, "files", makeFile({ id: "f1", path: "/a.txt" }), SITE);
		expect(findFileByIdActive(db, "f1")?.id).toBe("f1");
	});

	it("returns null for a soft-deleted row", () => {
		insertRow(db, "files", makeFile({ id: "f1", path: "/a.txt" }), SITE);
		softDelete(db, "files", "f1", SITE);
		expect(findFileByIdActive(db, "f1")).toBeNull();
	});

	it("returns null for an absent id", () => {
		expect(findFileByIdActive(db, "nope")).toBeNull();
	});
});

describe("findFileByPathActive", () => {
	it("returns a live row by path", () => {
		insertRow(db, "files", makeFile({ id: "f1", path: "/a.txt", content: "x" }), SITE);
		const row = findFileByPathActive(db, "/a.txt");
		expect(row?.id).toBe("f1");
		expect(row?.content).toBe("x");
	});

	it("returns null for a soft-deleted path", () => {
		insertRow(db, "files", makeFile({ id: "f1", path: "/a.txt" }), SITE);
		softDelete(db, "files", "f1", SITE);
		expect(findFileByPathActive(db, "/a.txt")).toBeNull();
	});

	it("returns null for an absent path", () => {
		expect(findFileByPathActive(db, "/missing.txt")).toBeNull();
	});
});

// --- deleted-filter OMISSION variants -----------------------------------

describe("findFileByPath (deleted-filter OMITTED)", () => {
	it("returns the tombstoned row that its deleted=0 sibling does NOT", () => {
		insertRow(
			db,
			"files",
			makeFile({
				id: "f1",
				path: "/tomb.txt",
				content: "buried",
				modified_at: "2026-02-02T00:00:00.000Z",
			}),
			SITE,
		);
		softDelete(db, "files", "f1", SITE);

		// Omission finder sees the tombstone...
		const omitted = findFileByPath(db, "/tomb.txt");
		expect(omitted).not.toBeNull();
		expect(omitted?.path).toBe("/tomb.txt");
		expect(omitted?.content).toBe("buried");
		// modified_at was overwritten by softDelete to wall-clock, so only assert shape.
		expect(typeof omitted?.modified_at).toBe("string");
		// ...the omitted projection has exactly the three selected columns.
		expect(Object.keys(omitted as object).sort()).toEqual(["content", "modified_at", "path"]);

		// ...while the deleted=0 sibling does not.
		expect(findFileByPathActive(db, "/tomb.txt")).toBeNull();
	});

	it("returns a live row too", () => {
		insertRow(db, "files", makeFile({ id: "f1", path: "/live.txt", content: "c" }), SITE);
		expect(findFileByPath(db, "/live.txt")?.content).toBe("c");
	});

	it("returns null for an absent path", () => {
		expect(findFileByPath(db, "/nope.txt")).toBeNull();
	});
});

describe("findFileIdContentDeletedByPath (deleted-filter OMITTED, exposes deleted flag)", () => {
	it("returns the tombstone with deleted=1 where the active sibling returns null", () => {
		insertRow(db, "files", makeFile({ id: "f1", path: "/t.txt", content: "z" }), SITE);
		softDelete(db, "files", "f1", SITE);

		const omitted = findFileIdContentDeletedByPath(db, "/t.txt");
		expect(omitted).not.toBeNull();
		expect(omitted?.id).toBe("f1");
		expect(omitted?.content).toBe("z");
		expect(omitted?.deleted).toBe(1);
		expect(Object.keys(omitted as object).sort()).toEqual(["content", "deleted", "id"]);

		// deleted=0 sibling on the same path returns nothing.
		expect(findFileIdContentByPathActive(db, "/t.txt")).toBeNull();
	});

	it("reports deleted=0 for a live row", () => {
		insertRow(db, "files", makeFile({ id: "f1", path: "/l.txt" }), SITE);
		expect(findFileIdContentDeletedByPath(db, "/l.txt")?.deleted).toBe(0);
	});

	it("returns null for an absent path", () => {
		expect(findFileIdContentDeletedByPath(db, "/nope")).toBeNull();
	});
});

// --- simple active-by-path / active-by-id projections (representative shape) ---

describe("active path/id projection finders", () => {
	beforeEach(() => {
		insertRow(
			db,
			"files",
			makeFile({ id: "f1", path: "/p.txt", content: "body", is_binary: 1, size_bytes: 4 }),
			SITE,
		);
	});

	it("findFileIdContentByPathActive returns {id, content}", () => {
		const r = findFileIdContentByPathActive(db, "/p.txt");
		expect(r).toEqual({ id: "f1", content: "body" });
	});

	it("findFileContentByPathActive returns {content}", () => {
		expect(findFileContentByPathActive(db, "/p.txt")).toEqual({ content: "body" });
	});

	it("findFileContentModifiedByPathActive returns {content, modified_at}", () => {
		const r = findFileContentModifiedByPathActive(db, "/p.txt");
		expect(r?.content).toBe("body");
		expect(r?.modified_at).toBe("2026-01-01T00:00:00.000Z");
	});

	it("findFileIdByPathActive returns {id}", () => {
		expect(findFileIdByPathActive(db, "/p.txt")).toEqual({ id: "f1" });
	});

	it("findFileIdByIdActive returns {id}", () => {
		expect(findFileIdByIdActive(db, "f1")).toEqual({ id: "f1" });
	});

	it("findFileContentByIdActive returns {content}", () => {
		expect(findFileContentByIdActive(db, "f1")).toEqual({ content: "body" });
	});

	it("findFileContentBinaryByIdActive returns {content, is_binary}", () => {
		expect(findFileContentBinaryByIdActive(db, "f1")).toEqual({ content: "body", is_binary: 1 });
	});

	it("all active projections return null for a soft-deleted row", () => {
		softDelete(db, "files", "f1", SITE);
		expect(findFileIdContentByPathActive(db, "/p.txt")).toBeNull();
		expect(findFileContentByPathActive(db, "/p.txt")).toBeNull();
		expect(findFileContentModifiedByPathActive(db, "/p.txt")).toBeNull();
		expect(findFileIdByPathActive(db, "/p.txt")).toBeNull();
		expect(findFileIdByIdActive(db, "f1")).toBeNull();
		expect(findFileContentByIdActive(db, "f1")).toBeNull();
		expect(findFileContentBinaryByIdActive(db, "f1")).toBeNull();
	});

	it("all active projections return null for an absent key", () => {
		expect(findFileIdContentByPathActive(db, "/x")).toBeNull();
		expect(findFileContentByIdActive(db, "x")).toBeNull();
	});
});

// --- ordering finder: listFilesActiveByCreatedDesc ----------------------

describe("listFilesActiveByCreatedDesc", () => {
	it("orders live rows by created_at DESC and omits deleted rows", () => {
		insertRow(
			db,
			"files",
			makeFile({ id: "old", path: "/old.txt", created_at: "2026-01-01T00:00:00.000Z" }),
			SITE,
		);
		insertRow(
			db,
			"files",
			makeFile({ id: "mid", path: "/mid.txt", created_at: "2026-03-01T00:00:00.000Z" }),
			SITE,
		);
		insertRow(
			db,
			"files",
			makeFile({ id: "new", path: "/new.txt", created_at: "2026-06-01T00:00:00.000Z" }),
			SITE,
		);
		insertRow(
			db,
			"files",
			makeFile({ id: "gone", path: "/gone.txt", created_at: "2026-12-01T00:00:00.000Z" }),
			SITE,
		);
		softDelete(db, "files", "gone", SITE);

		const rows = listFilesActiveByCreatedDesc(db);
		expect(rows.map((r) => r.id)).toEqual(["new", "mid", "old"]);
	});

	it("returns [] when there are no live rows", () => {
		expect(listFilesActiveByCreatedDesc(db)).toEqual([]);
	});
});

// --- listWorkspaceFiles: mount-path exclusion ---------------------------

describe("listWorkspaceFiles", () => {
	it("excludes /mnt/* and deleted rows, keeps active workspace files", () => {
		insertRow(db, "files", makeFile({ id: "w1", path: "/work.txt", content: "a" }), SITE);
		insertRow(db, "files", makeFile({ id: "w2", path: "/dir/nested.txt", content: "b" }), SITE);
		insertRow(db, "files", makeFile({ id: "m1", path: "/mnt/repo/file.txt", content: "c" }), SITE);
		insertRow(db, "files", makeFile({ id: "d1", path: "/deleted.txt", content: "d" }), SITE);
		softDelete(db, "files", "d1", SITE);

		const rows = listWorkspaceFiles(db);
		const paths = rows.map((r) => r.path).sort();
		expect(paths).toEqual(["/dir/nested.txt", "/work.txt"]);
	});

	it("returns [] on an empty table", () => {
		expect(listWorkspaceFiles(db)).toEqual([]);
	});
});

// --- listWorkspaceFilesModifiedSince: cursor (strict >) -----------------

describe("listWorkspaceFilesModifiedSince", () => {
	it("returns only active non-mount files with modified_at strictly greater than the cursor", () => {
		// modified_at is set at insert time and never touched (no updateRow), so it stays deterministic.
		insertRow(
			db,
			"files",
			makeFile({ id: "before", path: "/before.txt", modified_at: "2026-01-01T00:00:00.000Z" }),
			SITE,
		);
		insertRow(
			db,
			"files",
			makeFile({ id: "equal", path: "/equal.txt", modified_at: "2026-05-01T00:00:00.000Z" }),
			SITE,
		);
		insertRow(
			db,
			"files",
			makeFile({ id: "after", path: "/after.txt", modified_at: "2026-09-01T00:00:00.000Z" }),
			SITE,
		);
		insertRow(
			db,
			"files",
			makeFile({ id: "mnt", path: "/mnt/x.txt", modified_at: "2026-09-01T00:00:00.000Z" }),
			SITE,
		);

		const rows = listWorkspaceFilesModifiedSince(db, "2026-05-01T00:00:00.000Z");
		// Strict > excludes the equal cursor and the /mnt path; only "after" survives.
		expect(rows.map((r) => r.path)).toEqual(["/after.txt"]);
	});

	it("returns [] when nothing is newer than the cursor", () => {
		insertRow(
			db,
			"files",
			makeFile({ id: "f1", path: "/f1.txt", modified_at: "2026-01-01T00:00:00.000Z" }),
			SITE,
		);
		expect(listWorkspaceFilesModifiedSince(db, "2027-01-01T00:00:00.000Z")).toEqual([]);
	});
});

// --- LIKE-prefix listing finders ----------------------------------------

describe("listFilePathContentByPrefixActive", () => {
	it("matches the LIKE pattern and omits deleted rows", () => {
		insertRow(db, "files", makeFile({ id: "a", path: "/proj/a.txt", content: "ca" }), SITE);
		insertRow(db, "files", makeFile({ id: "b", path: "/proj/b.txt", content: "cb" }), SITE);
		insertRow(db, "files", makeFile({ id: "c", path: "/other/c.txt", content: "cc" }), SITE);
		insertRow(db, "files", makeFile({ id: "d", path: "/proj/d.txt", content: "cd" }), SITE);
		softDelete(db, "files", "d", SITE);

		const rows = listFilePathContentByPrefixActive(db, "/proj/%");
		const out = rows
			.map((r) => ({ path: r.path, content: r.content }))
			.sort((x, y) => (x.path < y.path ? -1 : 1));
		expect(out).toEqual([
			{ path: "/proj/a.txt", content: "ca" },
			{ path: "/proj/b.txt", content: "cb" },
		]);
	});

	it("returns [] when no path matches the pattern", () => {
		insertRow(db, "files", makeFile({ id: "a", path: "/proj/a.txt" }), SITE);
		expect(listFilePathContentByPrefixActive(db, "/none/%")).toEqual([]);
	});
});

describe("listFileIdPathSizeByPrefixActive", () => {
	it("projects {id, path, size_bytes} for matching active rows", () => {
		insertRow(db, "files", makeFile({ id: "a", path: "/p/a.txt", size_bytes: 10 }), SITE);
		insertRow(db, "files", makeFile({ id: "b", path: "/p/b.txt", size_bytes: 20 }), SITE);
		insertRow(db, "files", makeFile({ id: "c", path: "/q/c.txt", size_bytes: 30 }), SITE);

		const rows = listFileIdPathSizeByPrefixActive(db, "/p/%");
		const out = rows.sort((x, y) => (x.path < y.path ? -1 : 1));
		expect(out).toEqual([
			{ id: "a", path: "/p/a.txt", size_bytes: 10 },
			{ id: "b", path: "/p/b.txt", size_bytes: 20 },
		]);
	});
});

describe("listFilePathSizeModifiedByPrefixActive (ORDER BY path)", () => {
	it("returns matching active rows ordered by path ascending", () => {
		// Insert out of path order to prove the ORDER BY path sort.
		insertRow(
			db,
			"files",
			makeFile({
				id: "c",
				path: "/p/charlie.txt",
				size_bytes: 3,
				modified_at: "2026-03-03T00:00:00.000Z",
			}),
			SITE,
		);
		insertRow(
			db,
			"files",
			makeFile({
				id: "a",
				path: "/p/alpha.txt",
				size_bytes: 1,
				modified_at: "2026-01-01T00:00:00.000Z",
			}),
			SITE,
		);
		insertRow(
			db,
			"files",
			makeFile({
				id: "b",
				path: "/p/bravo.txt",
				size_bytes: 2,
				modified_at: "2026-02-02T00:00:00.000Z",
			}),
			SITE,
		);
		insertRow(db, "files", makeFile({ id: "z", path: "/p/zeta.txt", size_bytes: 9 }), SITE);
		softDelete(db, "files", "z", SITE);

		const rows = listFilePathSizeModifiedByPrefixActive(db, "/p/%");
		expect(rows).toEqual([
			{ path: "/p/alpha.txt", size_bytes: 1, modified_at: "2026-01-01T00:00:00.000Z" },
			{ path: "/p/bravo.txt", size_bytes: 2, modified_at: "2026-02-02T00:00:00.000Z" },
			{ path: "/p/charlie.txt", size_bytes: 3, modified_at: "2026-03-03T00:00:00.000Z" },
		]);
	});

	it("returns [] when nothing matches", () => {
		expect(listFilePathSizeModifiedByPrefixActive(db, "/p/%")).toEqual([]);
	});
});
