import Database from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { applySchema } from "@bound/core";
import { cleanupTmpDir } from "@bound/shared/test-utils";
import { type ClusterFsResult, createClusterFs } from "../cluster-fs";

describe("ClusterFs auto-cache on overlay read", () => {
	let db: Database;
	let tmpDir: string;

	beforeEach(() => {
		db = new Database(":memory:");
		applySchema(db);

		// Create a temporary directory for overlay mounts
		const hex = Buffer.from(crypto.getRandomValues(new Uint8Array(4))).toString("hex");
		tmpDir = join("/tmp", `bound-test-overlay-${hex}`);
		mkdirSync(tmpDir, { recursive: true });
	});

	afterEach(async () => {
		try {
			await cleanupTmpDir(tmpDir);
		} catch {
			// Ignore cleanup failures
		}
	});

	test("auto-caches file to files table on overlay read when sync enabled", async () => {
		// Write a file to the real filesystem
		const testContent = "overlay file content";
		writeFileSync(join(tmpDir, "test.txt"), testContent);

		const mountPath = "/mnt/project";
		const result = createClusterFs({
			hostName: "localhost",
			syncEnabled: true,
			overlayMounts: { [tmpDir]: mountPath },
			db,
			siteId: "test-site",
		}) as ClusterFsResult;

		// Read from overlay
		const content = await result.fs.readFile(`${mountPath}/test.txt`);
		expect(content).toBe(testContent);

		// Verify it was cached to the files table
		const cached = db
			.query("SELECT * FROM files WHERE path = ? AND deleted = 0")
			.get(`${mountPath}/test.txt`) as { content: string; size_bytes: number } | null;

		expect(cached).not.toBeNull();
		expect(cached?.content).toBe(testContent);
		expect(cached?.size_bytes).toBe(Buffer.byteLength(testContent));
	});

	test("creates change_log entry on auto-cache", async () => {
		writeFileSync(join(tmpDir, "logged.txt"), "logged content");

		const mountPath = "/mnt/project";
		const result = createClusterFs({
			hostName: "localhost",
			syncEnabled: true,
			overlayMounts: { [tmpDir]: mountPath },
			db,
			siteId: "test-site",
		}) as ClusterFsResult;

		await result.fs.readFile(`${mountPath}/logged.txt`);

		const logs = db.query("SELECT * FROM change_log WHERE table_name = 'files'").all() as Array<{
			row_id: string;
		}>;

		expect(logs.length).toBeGreaterThan(0);
	});

	test("skips auto-cache when syncEnabled is false", async () => {
		writeFileSync(join(tmpDir, "test.txt"), "no sync content");

		const mountPath = "/mnt/project";
		// When syncEnabled is false, auto-cache is not enabled even with db/siteId
		const result = createClusterFs({
			hostName: "localhost",
			syncEnabled: false,
			overlayMounts: { [tmpDir]: mountPath },
			db,
			siteId: "test-site",
		}) as ClusterFsResult;

		// Read from overlay
		const content = await result.fs.readFile(`${mountPath}/test.txt`);
		expect(content).toBe("no sync content");

		// Should NOT be in the files table since sync is disabled
		const cached = db
			.query("SELECT * FROM files WHERE path = ? AND deleted = 0")
			.get(`${mountPath}/test.txt`);

		expect(cached).toBeNull();
	});

	test("does not re-cache when content hash is unchanged", async () => {
		const testContent = "stable content";
		writeFileSync(join(tmpDir, "stable.txt"), testContent);

		const mountPath = "/mnt/project";
		const result = createClusterFs({
			hostName: "localhost",
			syncEnabled: true,
			overlayMounts: { [tmpDir]: mountPath },
			db,
			siteId: "test-site",
		}) as ClusterFsResult;

		// Read twice
		await result.fs.readFile(`${mountPath}/stable.txt`);
		await result.fs.readFile(`${mountPath}/stable.txt`);

		// Should only have one change_log entry (the initial insert)
		const logs = db
			.query("SELECT * FROM change_log WHERE table_name = 'files' AND row_id = ?")
			.all(`${mountPath}/stable.txt`) as Array<unknown>;

		expect(logs.length).toBe(1);
	});

	test("updates cache when overlay content changes", async () => {
		writeFileSync(join(tmpDir, "changing.txt"), "version 1");

		const mountPath = "/mnt/project";
		const result = createClusterFs({
			hostName: "localhost",
			syncEnabled: true,
			overlayMounts: { [tmpDir]: mountPath },
			db,
			siteId: "test-site",
		}) as ClusterFsResult;

		// First read caches version 1
		await result.fs.readFile(`${mountPath}/changing.txt`);

		// Modify through the overlay (write in-memory layer)
		await result.fs.writeFile(`${mountPath}/changing.txt`, "version 2");

		// Read again should update cache
		await result.fs.readFile(`${mountPath}/changing.txt`);

		const cached = db
			.query("SELECT content FROM files WHERE path = ? AND deleted = 0")
			.get(`${mountPath}/changing.txt`) as { content: string } | null;

		expect(cached).not.toBeNull();
		expect(cached?.content).toBe("version 2");
	});

	test("does not auto-cache non-overlay paths", async () => {
		writeFileSync(join(tmpDir, "test.txt"), "overlay content");

		const mountPath = "/mnt/project";
		const result = createClusterFs({
			hostName: "localhost",
			syncEnabled: true,
			overlayMounts: { [tmpDir]: mountPath },
			db,
			siteId: "test-site",
		}) as ClusterFsResult;

		// Write and read from /home/user (not overlay)
		await result.fs.writeFile("/home/user/local.txt", "local content");
		await result.fs.readFile("/home/user/local.txt");

		// Should NOT be auto-cached
		const cached = db
			.query("SELECT * FROM files WHERE path = ? AND deleted = 0")
			.get("/home/user/local.txt");

		expect(cached).toBeNull();
	});
});

describe("ClusterFs staleness detection", () => {
	let db: Database;
	let tmpDir: string;

	beforeEach(() => {
		db = new Database(":memory:");
		applySchema(db);

		const hex = Buffer.from(crypto.getRandomValues(new Uint8Array(4))).toString("hex");
		tmpDir = join("/tmp", `bound-test-staleness-${hex}`);
		mkdirSync(tmpDir, { recursive: true });
	});

	afterEach(async () => {
		try {
			await cleanupTmpDir(tmpDir);
		} catch {
			// Ignore cleanup failures
		}
	});

	test("returns null when path is not in files table", () => {
		const result = createClusterFs({
			hostName: "localhost",
			syncEnabled: true,
			overlayMounts: {},
			db,
			siteId: "test-site",
		}) as ClusterFsResult;

		const staleness = result.checkStaleness("/mnt/project/nonexistent.txt");
		expect(staleness).toBeNull();
	});

	test("returns null when path is not in overlay_index", () => {
		// Insert into files but not overlay_index
		const now = new Date().toISOString();
		db.run(
			"INSERT INTO files (id, path, content, deleted, size_bytes, created_at, modified_at) VALUES (?, ?, ?, 0, ?, ?, ?)",
			["/mnt/project/test.txt", "/mnt/project/test.txt", "content", 7, now, now],
		);

		const result = createClusterFs({
			hostName: "localhost",
			syncEnabled: true,
			overlayMounts: {},
			db,
			siteId: "test-site",
		}) as ClusterFsResult;

		const staleness = result.checkStaleness("/mnt/project/test.txt");
		expect(staleness).toBeNull();
	});

	test("returns stale=false when hashes match", () => {
		const content = "matching content";
		const contentHash = createHash("sha256").update(content).digest("hex");
		const now = new Date().toISOString();

		// Insert into files
		db.run(
			"INSERT INTO files (id, path, content, deleted, size_bytes, created_at, modified_at) VALUES (?, ?, ?, 0, ?, ?, ?)",
			[
				"/mnt/project/test.txt",
				"/mnt/project/test.txt",
				content,
				Buffer.byteLength(content),
				now,
				now,
			],
		);

		// Insert into overlay_index with same hash
		db.run(
			"INSERT INTO overlay_index (id, site_id, path, size_bytes, content_hash, indexed_at, deleted) VALUES (?, ?, ?, ?, ?, ?, 0)",
			["idx-1", "test-site", "/mnt/project/test.txt", Buffer.byteLength(content), contentHash, now],
		);

		const result = createClusterFs({
			hostName: "localhost",
			syncEnabled: true,
			overlayMounts: {},
			db,
			siteId: "test-site",
		}) as ClusterFsResult;

		const staleness = result.checkStaleness("/mnt/project/test.txt");
		expect(staleness).not.toBeNull();
		expect(staleness?.stale).toBe(false);
		expect(staleness?.cachedHash).toBe(contentHash);
		expect(staleness?.indexHash).toBe(contentHash);
	});

	test("returns stale=true when hashes differ", () => {
		const cachedContent = "old content";
		const newContentHash = createHash("sha256").update("new content").digest("hex");
		const now = new Date().toISOString();

		// Insert into files with old content
		db.run(
			"INSERT INTO files (id, path, content, deleted, size_bytes, created_at, modified_at) VALUES (?, ?, ?, 0, ?, ?, ?)",
			[
				"/mnt/project/test.txt",
				"/mnt/project/test.txt",
				cachedContent,
				Buffer.byteLength(cachedContent),
				now,
				now,
			],
		);

		// Insert into overlay_index with different hash (from newer content)
		db.run(
			"INSERT INTO overlay_index (id, site_id, path, size_bytes, content_hash, indexed_at, deleted) VALUES (?, ?, ?, ?, ?, ?, 0)",
			["idx-1", "test-site", "/mnt/project/test.txt", 11, newContentHash, now],
		);

		const result = createClusterFs({
			hostName: "localhost",
			syncEnabled: true,
			overlayMounts: {},
			db,
			siteId: "test-site",
		}) as ClusterFsResult;

		const staleness = result.checkStaleness("/mnt/project/test.txt");
		expect(staleness).not.toBeNull();
		expect(staleness?.stale).toBe(true);
		expect(staleness?.cachedHash).not.toBe(staleness?.indexHash);
	});

	test("auto-cache + staleness detection integration", async () => {
		const testContent = "hello from overlay";
		writeFileSync(join(tmpDir, "integrated.txt"), testContent);

		const mountPath = "/mnt/project";
		const result = createClusterFs({
			hostName: "localhost",
			syncEnabled: true,
			overlayMounts: { [tmpDir]: mountPath },
			db,
			siteId: "test-site",
		}) as ClusterFsResult;

		// Read from overlay to auto-cache
		await result.fs.readFile(`${mountPath}/integrated.txt`);

		// Add an overlay_index entry with the same hash
		const contentHash = createHash("sha256").update(testContent).digest("hex");
		const now = new Date().toISOString();
		db.run(
			"INSERT INTO overlay_index (id, site_id, path, size_bytes, content_hash, indexed_at, deleted) VALUES (?, ?, ?, ?, ?, ?, 0)",
			[
				"idx-1",
				"test-site",
				`${mountPath}/integrated.txt`,
				Buffer.byteLength(testContent),
				contentHash,
				now,
			],
		);

		// Should not be stale
		const staleness = result.checkStaleness(`${mountPath}/integrated.txt`);
		expect(staleness).not.toBeNull();
		expect(staleness?.stale).toBe(false);
	});
});
