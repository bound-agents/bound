/**
 * LoopSandbox integration tests.
 *
 * Tests the full snapshot → persist pipeline wired through loopSandbox:
 * - AC5.3: Files written by agent bash commands appear in files table
 * - AC5.4: No-change loops return changes: 0
 * - AC3.4: Files survive restart via hydrateWorkspace
 * - AC4.1: Files under 1MB persist normally
 * - AC4.2: Files over 1MB trigger size limit
 * - AC3.1-AC3.3: File tree structure (root nodes, /tmp, /workspace paths)
 */

import type Database from "bun:sqlite";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyMetricsSchema, applySchema, createDatabase } from "@bound/core";
import {
	type ClusterFsResult,
	createClusterFs,
	diffWorkspace,
	hydrateWorkspace,
	persistWorkspaceChanges,
	snapshotWorkspace,
} from "@bound/sandbox";
import { TypedEventEmitter } from "@bound/shared";

/**
 * Build a loopSandbox wrapper from ClusterFsResult + dependencies.
 * This mirrors the pattern that agentLoopFactory creates.
 */
function makeLoopSandbox(
	clusterFsObj: ClusterFsResult,
	db: Database,
	siteId: string,
	eventBus: TypedEventEmitter,
) {
	let preSnapshot: Map<string, string> | null = null;
	return {
		capturePreSnapshot: async (): Promise<void> => {
			preSnapshot = await snapshotWorkspace(clusterFsObj.fs, {
				paths: clusterFsObj.getInMemoryPaths(),
			});
		},
		persistFs: async (): Promise<{ changes: number; changedPaths?: string[] }> => {
			if (!preSnapshot) return { changes: 0 };
			const postSnapshot = await snapshotWorkspace(clusterFsObj.fs, {
				paths: clusterFsObj.getInMemoryPaths(),
			});
			const changedPaths = diffWorkspace(preSnapshot, postSnapshot).map((c) => c.path);
			const result = await persistWorkspaceChanges(
				db,
				siteId,
				preSnapshot,
				postSnapshot,
				eventBus,
				undefined,
				clusterFsObj.fs,
			);
			preSnapshot = null;
			if (!result.ok) return { changes: 0 };
			return { changes: result.value.changes, changedPaths };
		},
	};
}

describe("LoopSandbox", () => {
	let tmpDir: string;
	let dbPath: string;
	let db: Database;
	let siteId: string;
	let eventBus: TypedEventEmitter;

	beforeAll(() => {
		tmpDir = mkdtempSync(join(tmpdir(), `loop-sandbox-${randomBytes(4).toString("hex")}-`));
		dbPath = join(tmpDir, "test.db");
		db = createDatabase(dbPath);
		applySchema(db);
		applyMetricsSchema(db);
	});

	beforeEach(() => {
		siteId = randomUUID();
		eventBus = new TypedEventEmitter();

		// Seed host_meta
		db.run("DELETE FROM host_meta");
		db.run("INSERT INTO host_meta (key, value) VALUES ('site_id', ?)", [siteId]);

		// Clear files table before each test
		db.run("DELETE FROM files");
		db.run("DELETE FROM change_log");
	});

	afterAll(() => {
		db.close();
		rmSync(tmpDir, { recursive: true, force: true });
	});

	describe("AC5.3: Files written to /tmp appear in files table", () => {
		it("persists a file written to /tmp", async () => {
			const clusterFsResult = createClusterFs({
				hostName: "test-host",
				syncEnabled: false,
				db,
				siteId,
			});
			const loopSandbox = makeLoopSandbox(clusterFsResult, db, siteId, eventBus);

			// Capture pre-state before any writes
			await loopSandbox.capturePreSnapshot();

			// Write file to /tmp
			await clusterFsResult.fs.writeFile("/tmp/scratch.txt", "test content");

			// Persist changes
			const result = await loopSandbox.persistFs();

			expect(result.changes).toBe(1);

			// Query files table
			const row = db
				.query("SELECT path, content FROM files WHERE path = ? AND deleted = 0")
				.get("/tmp/scratch.txt") as { path: string; content: string } | null;

			expect(row).toBeDefined();
			expect(row?.path).toBe("/tmp/scratch.txt");
			expect(row?.content).toBe("test content");
		});

		it("persists a file written to /workspace", async () => {
			const clusterFsResult = createClusterFs({
				hostName: "test-host",
				syncEnabled: false,
				db,
				siteId,
			});
			const loopSandbox = makeLoopSandbox(clusterFsResult, db, siteId, eventBus);

			await loopSandbox.capturePreSnapshot();
			await clusterFsResult.fs.writeFile("/workspace/project.ts", "const x = 1;");
			const result = await loopSandbox.persistFs();

			expect(result.changes).toBe(1);

			const row = db
				.query("SELECT path, content FROM files WHERE path = ? AND deleted = 0")
				.get("/workspace/project.ts") as { path: string; content: string } | null;

			expect(row?.path).toBe("/workspace/project.ts");
			expect(row?.content).toBe("const x = 1;");
		});
	});

	describe("AC5.4: No-change loop returns changes: 0", () => {
		it("returns 0 when capturePreSnapshot but no writes occur", async () => {
			const clusterFsResult = createClusterFs({
				hostName: "test-host",
				syncEnabled: false,
				db,
				siteId,
			});
			const loopSandbox = makeLoopSandbox(clusterFsResult, db, siteId, eventBus);

			// Capture, write nothing, persist
			await loopSandbox.capturePreSnapshot();
			const result = await loopSandbox.persistFs();

			expect(result.changes).toBe(0);
		});

		it("returns 0 when persistFs called without capturePreSnapshot", async () => {
			const clusterFsResult = createClusterFs({
				hostName: "test-host",
				syncEnabled: false,
				db,
				siteId,
			});
			const loopSandbox = makeLoopSandbox(clusterFsResult, db, siteId, eventBus);

			// Skip capturePreSnapshot
			const result = await loopSandbox.persistFs();

			expect(result.changes).toBe(0);
		});
	});

	describe("AC3.4: Files survive restart via hydrateWorkspace", () => {
		it("persists files and rehydrates them to a fresh ClusterFsResult", async () => {
			// First instance: create, write, persist
			const clusterFsResult1 = createClusterFs({
				hostName: "test-host",
				syncEnabled: false,
				db,
				siteId,
			});
			const loopSandbox1 = makeLoopSandbox(clusterFsResult1, db, siteId, eventBus);

			await loopSandbox1.capturePreSnapshot();
			await clusterFsResult1.fs.writeFile("/tmp/restart.txt", "persistent content");
			await loopSandbox1.persistFs();

			// Verify it's in the DB
			const row = db
				.query("SELECT content FROM files WHERE path = ? AND deleted = 0")
				.get("/tmp/restart.txt") as { content: string } | null;
			expect(row?.content).toBe("persistent content");

			// Second instance: fresh ClusterFsResult, hydrate from DB
			const clusterFsResult2 = createClusterFs({
				hostName: "test-host",
				syncEnabled: false,
				db,
				siteId,
			});
			await hydrateWorkspace(clusterFsResult2.fs, db);

			// Read the file from the fresh instance
			const content = await clusterFsResult2.fs.readFile("/tmp/restart.txt");
			expect(content).toBe("persistent content");
		});
	});

	describe("AC4.1: Files under 1MB persist normally", () => {
		it("persists a 500KB file to /tmp", async () => {
			const clusterFsResult = createClusterFs({
				hostName: "test-host",
				syncEnabled: false,
				db,
				siteId,
			});
			const loopSandbox = makeLoopSandbox(clusterFsResult, db, siteId, eventBus);

			const smallContent = "x".repeat(500 * 1024); // 500KB
			await loopSandbox.capturePreSnapshot();
			await clusterFsResult.fs.writeFile("/tmp/small.txt", smallContent);
			const result = await loopSandbox.persistFs();

			expect(result.changes).toBe(1);

			const row = db
				.query("SELECT content FROM files WHERE path = ? AND deleted = 0")
				.get("/tmp/small.txt") as { content: string } | null;

			expect(row).toBeDefined();
			expect(row?.content.length).toBe(500 * 1024);
		});
	});

	describe("AC4.2: Files over 1MB trigger size limit", () => {
		it("skips a 2MB file (exceeds per-file 1MB limit)", async () => {
			const clusterFsResult = createClusterFs({
				hostName: "test-host",
				syncEnabled: false,
				db,
				siteId,
			});
			const loopSandbox = makeLoopSandbox(clusterFsResult, db, siteId, eventBus);

			const bigContent = "x".repeat(2 * 1024 * 1024); // 2MB
			await loopSandbox.capturePreSnapshot();
			await clusterFsResult.fs.writeFile("/tmp/big.txt", bigContent);
			const result = await loopSandbox.persistFs();

			// persistWorkspaceChanges should skip files over 1MB per-file limit
			// The file should not be in the database (changes: 0)
			expect(result.changes).toBe(0);

			const row = db
				.query("SELECT content FROM files WHERE path = ? AND deleted = 0")
				.get("/tmp/big.txt") as { content: string } | null;

			expect(row).toBeNull();
		});
	});

	describe("changedPaths populated correctly", () => {
		it("includes all modified paths in persistFs result", async () => {
			const clusterFsResult = createClusterFs({
				hostName: "test-host",
				syncEnabled: false,
				db,
				siteId,
			});
			const loopSandbox = makeLoopSandbox(clusterFsResult, db, siteId, eventBus);

			await loopSandbox.capturePreSnapshot();
			await clusterFsResult.fs.writeFile("/tmp/a.txt", "content a");
			await clusterFsResult.fs.writeFile("/home/user/b.txt", "content b");
			const result = await loopSandbox.persistFs();

			expect(result.changes).toBe(2);
			expect(result.changedPaths).toBeDefined();
			expect(result.changedPaths).toContain("/tmp/a.txt");
			expect(result.changedPaths).toContain("/home/user/b.txt");
		});
	});

	describe("File tree structure: AC3.1-AC3.3", () => {
		it("AC3.1 — /tmp/output.txt appears in files table", async () => {
			const clusterFsResult = createClusterFs({
				hostName: "test-host",
				syncEnabled: false,
				db,
				siteId,
			});
			const loopSandbox = makeLoopSandbox(clusterFsResult, db, siteId, eventBus);

			await loopSandbox.capturePreSnapshot();
			await clusterFsResult.fs.writeFile("/tmp/output.txt", "output data");
			await loopSandbox.persistFs();

			const row = db
				.query("SELECT path, content FROM files WHERE path = ? AND deleted = 0")
				.get("/tmp/output.txt") as { path: string; content: string } | null;

			expect(row).toBeDefined();
			expect(row?.path).toBe("/tmp/output.txt");
			expect(row?.content).toBe("output data");
		});

		it("AC3.2 — /tmp appears as a root node in file tree", async () => {
			const clusterFsResult = createClusterFs({
				hostName: "test-host",
				syncEnabled: false,
				db,
				siteId,
			});
			const loopSandbox = makeLoopSandbox(clusterFsResult, db, siteId, eventBus);

			await loopSandbox.capturePreSnapshot();
			await clusterFsResult.fs.writeFile("/tmp/output.txt", "data");
			await loopSandbox.persistFs();

			// Extract root nodes from files table
			const files = db.query("SELECT path FROM files WHERE deleted = 0").all() as
				| { path: string }[]
				| null;

			expect(files).toBeDefined();
			expect(files?.length).toBeGreaterThan(0);

			const rootSegments = (files ?? []).map((f) => f.path.split("/").filter(Boolean)[0]);
			expect(rootSegments).toContain("tmp");
		});

		it("AC3.3 — /workspace appears as a root node", async () => {
			const clusterFsResult = createClusterFs({
				hostName: "test-host",
				syncEnabled: false,
				db,
				siteId,
			});
			const loopSandbox = makeLoopSandbox(clusterFsResult, db, siteId, eventBus);

			await loopSandbox.capturePreSnapshot();
			await clusterFsResult.fs.writeFile("/workspace/main.py", "import os");
			await loopSandbox.persistFs();

			// Extract root nodes
			const files = db.query("SELECT path FROM files WHERE deleted = 0").all() as
				| { path: string }[]
				| null;

			expect(files).toBeDefined();

			const rootSegments = (files ?? []).map((f) => f.path.split("/").filter(Boolean)[0]);
			expect(rootSegments).toContain("workspace");
		});
	});
});
