import type { Database } from "bun:sqlite";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applySchema, createDatabase, insertRow } from "@bound/core";
import { cleanupTmpDir } from "@bound/shared/test-utils";
import { cleanupStaleFiles } from "../cleanup-stale-files";

describe("cleanupStaleFiles", () => {
	let tmpDir: string;
	let db: Database;
	let siteId: string;

	beforeAll(() => {
		tmpDir = mkdtempSync(join(tmpdir(), `cleanup-stale-${randomBytes(4).toString("hex")}-`));
		const dbPath = join(tmpDir, "test.db");
		db = createDatabase(dbPath);
		applySchema(db);
	});

	beforeEach(() => {
		siteId = randomUUID();
		db.run("DELETE FROM files");
	});

	afterAll(async () => {
		db.close();
		await cleanupTmpDir(tmpDir);
	});

	it("soft-deletes tool-results files older than 48h", () => {
		const old = new Date(Date.now() - 49 * 60 * 60 * 1000).toISOString();
		const recent = new Date(Date.now() - 1 * 60 * 60 * 1000).toISOString();

		insertRow(db, "files", {
			id: randomUUID(), path: "/home/user/.tool-results/old.txt",
			content: "x", is_binary: 0, size_bytes: 1,
			created_at: old, modified_at: old, deleted: 0,
		}, siteId);
		insertRow(db, "files", {
			id: randomUUID(), path: "/home/user/.tool-results/recent.txt",
			content: "y", is_binary: 0, size_bytes: 1,
			created_at: recent, modified_at: recent, deleted: 0,
		}, siteId);

		const { pruned } = cleanupStaleFiles(db, siteId);
		expect(pruned).toBe(1);

		const remaining = db
			.prepare("SELECT path FROM files WHERE deleted = 0 ORDER BY path")
			.all() as Array<{ path: string }>;
		expect(remaining.map((r) => r.path)).toEqual(["/home/user/.tool-results/recent.txt"]);
	});

	it("soft-deletes /tmp files older than 48h", () => {
		const old = new Date(Date.now() - 50 * 60 * 60 * 1000).toISOString();

		insertRow(db, "files", {
			id: randomUUID(), path: "/tmp/old-cache.txt",
			content: "x", is_binary: 0, size_bytes: 1,
			created_at: old, modified_at: old, deleted: 0,
		}, siteId);

		const { pruned } = cleanupStaleFiles(db, siteId);
		expect(pruned).toBe(1);
	});

	it("does not touch workspace files regardless of age", () => {
		const old = new Date(Date.now() - 72 * 60 * 60 * 1000).toISOString();

		insertRow(db, "files", {
			id: randomUUID(), path: "/home/user/notes.md",
			content: "x", is_binary: 0, size_bytes: 1,
			created_at: old, modified_at: old, deleted: 0,
		}, siteId);

		const { pruned } = cleanupStaleFiles(db, siteId);
		expect(pruned).toBe(0);
	});

	it("does not touch files younger than 48h", () => {
		const recent = new Date(Date.now() - 47 * 60 * 60 * 1000).toISOString();

		insertRow(db, "files", {
			id: randomUUID(), path: "/tmp/recent.txt",
			content: "x", is_binary: 0, size_bytes: 1,
			created_at: recent, modified_at: recent, deleted: 0,
		}, siteId);

		const { pruned } = cleanupStaleFiles(db, siteId);
		expect(pruned).toBe(0);
	});

	it("skips already-deleted files", () => {
		const old = new Date(Date.now() - 50 * 60 * 60 * 1000).toISOString();

		insertRow(db, "files", {
			id: randomUUID(), path: "/tmp/already-deleted.txt",
			content: "x", is_binary: 0, size_bytes: 1,
			created_at: old, modified_at: old, deleted: 0,
		}, siteId);
		// Soft-delete it
		db.prepare("UPDATE files SET deleted = 1 WHERE path = ?").run("/tmp/already-deleted.txt");

		const { pruned } = cleanupStaleFiles(db, siteId);
		expect(pruned).toBe(0);
	});
});
