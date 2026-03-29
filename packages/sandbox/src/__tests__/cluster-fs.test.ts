import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import Database from "bun:sqlite";
import { applySchema, insertRow } from "@bound/core";
import { createClusterFs, diffWorkspaceAsync, snapshotWorkspace } from "../cluster-fs";
import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";

describe("ClusterFs", () => {
	test("creates a ClusterFs with proper mount structure", () => {
		const clusterFs = createClusterFs({ hostName: "localhost", syncEnabled: true });
		expect(clusterFs).toBeDefined();
	});

	test("allows writing and reading files from /home/user/", async () => {
		const clusterFs = createClusterFs({ hostName: "localhost", syncEnabled: true });
		const testContent = "Hello, world!";
		await clusterFs.writeFile("/home/user/test.txt", testContent);
		const read = await clusterFs.readFile("/home/user/test.txt");
		expect(read).toBe(testContent);
	});

	test("snapshotWorkspace captures file hashes before execution", async () => {
		const clusterFs = createClusterFs({ hostName: "localhost", syncEnabled: true });
		await clusterFs.writeFile("/home/user/file1.txt", "content1");
		await clusterFs.writeFile("/home/user/file2.txt", "content2");

		const snapshot = await snapshotWorkspace(clusterFs);
		expect(snapshot.size).toBe(2);
		expect(snapshot.get("/home/user/file1.txt")).toBeDefined();
		expect(snapshot.get("/home/user/file2.txt")).toBeDefined();
	});

	test("diffWorkspace detects created files", async () => {
		const clusterFs = createClusterFs({ hostName: "localhost", syncEnabled: true });
		const before = await snapshotWorkspace(clusterFs);

		await clusterFs.writeFile("/home/user/new.txt", "new content");

		const after = await snapshotWorkspace(clusterFs);
		const changes = await diffWorkspaceAsync(before, after, clusterFs);

		expect(changes.length).toBeGreaterThan(0);
		const created = changes.find((c) => c.path === "/home/user/new.txt");
		expect(created).toBeDefined();
		expect(created?.operation).toBe("created");
		expect(created?.content).toBe("new content");
	});

	test("diffWorkspace detects modified files", async () => {
		const clusterFs = createClusterFs({ hostName: "localhost", syncEnabled: true });
		await clusterFs.writeFile("/home/user/file.txt", "original");
		const before = await snapshotWorkspace(clusterFs);

		await clusterFs.writeFile("/home/user/file.txt", "modified");

		const after = await snapshotWorkspace(clusterFs);
		const changes = await diffWorkspaceAsync(before, after, clusterFs);

		const modified = changes.find((c) => c.path === "/home/user/file.txt");
		expect(modified).toBeDefined();
		expect(modified?.operation).toBe("modified");
		expect(modified?.content).toBe("modified");
	});

	test("diffWorkspace detects deleted files", async () => {
		const clusterFs = createClusterFs({ hostName: "localhost", syncEnabled: true });
		await clusterFs.writeFile("/home/user/file.txt", "content");
		const before = await snapshotWorkspace(clusterFs);

		await clusterFs.rm("/home/user/file.txt");

		const after = await snapshotWorkspace(clusterFs);
		const changes = await diffWorkspaceAsync(before, after, clusterFs);

		const deleted = changes.find((c) => c.path === "/home/user/file.txt");
		expect(deleted).toBeDefined();
		expect(deleted?.operation).toBe("deleted");
	});

	test("diffWorkspace returns empty array when no changes", async () => {
		const clusterFs = createClusterFs({ hostName: "localhost", syncEnabled: true });
		await clusterFs.writeFile("/home/user/file.txt", "content");
		const before = await snapshotWorkspace(clusterFs);
		const after = await snapshotWorkspace(clusterFs);

		const changes = await diffWorkspaceAsync(before, after);
		expect(changes.length).toBe(0);
	});

	test("includes file size in diff output", async () => {
		const clusterFs = createClusterFs({ hostName: "localhost", syncEnabled: true });
		await clusterFs.writeFile("/home/user/file.txt", "12345");
		const after = await snapshotWorkspace(clusterFs);

		const changes = await diffWorkspaceAsync(new Map(), after, clusterFs);
		const change = changes.find((c) => c.path === "/home/user/file.txt");

		expect(change?.sizeBytes).toBe(5);
	});
});

describe("getInMemoryPaths", () => {
	let db: Database;

	beforeEach(() => {
		db = new Database(":memory:");
		applySchema(db);
	});

	test("AC1.1: includes files written to /tmp/", async () => {
		const result = createClusterFs({
			hostName: "localhost",
			syncEnabled: false,
			db,
			siteId: "test-site",
		});
		await result.fs.writeFile("/tmp/foo.txt", "content");

		const paths = result.getInMemoryPaths();

		expect(paths).toContain("/tmp/foo.txt");
	});

	test("AC1.2: includes files at arbitrary agent-created paths", async () => {
		const result = createClusterFs({
			hostName: "localhost",
			syncEnabled: false,
			db,
			siteId: "test-site",
		});
		await result.fs.writeFile("/workspace/project/main.py", "print('hello')");

		const paths = result.getInMemoryPaths();

		expect(paths).toContain("/workspace/project/main.py");
	});

	test("AC1.3: includes existing /home/user/ files (no regression)", async () => {
		const result = createClusterFs({
			hostName: "localhost",
			syncEnabled: false,
			db,
			siteId: "test-site",
		});
		await result.fs.writeFile("/home/user/notes.txt", "my notes");

		const paths = result.getInMemoryPaths();

		expect(paths).toContain("/home/user/notes.txt");
	});

	test("AC1.4 + AC1.5: excludes /mnt/ paths and OverlayFs files", async () => {
		const tmpDir = mkdtempSync("/tmp/test-overlay-");
		const testFile = join(tmpDir, "real-file.txt");
		writeFileSync(testFile, "real content");

		try {
			const result = createClusterFs({
				hostName: "localhost",
				syncEnabled: false,
				db,
				siteId: "test-site",
				overlayMounts: {
					[tmpDir]: "/mnt/host",
				},
			});

			const paths = result.getInMemoryPaths();

			// Verify no paths start with /mnt/
			for (const path of paths) {
				expect(path.startsWith("/mnt/")).toBe(false);
			}
		} finally {
			// Cleanup
			const fs = require("node:fs");
			fs.rmSync(tmpDir, { recursive: true });
		}
	});
});

describe("snapshotWorkspace with paths option", () => {
	test("snapshots only listed paths when paths option provided", async () => {
		const clusterFs = createClusterFs({ hostName: "localhost", syncEnabled: true });
		await clusterFs.writeFile("/tmp/foo.txt", "foo content");
		await clusterFs.writeFile("/home/user/bar.txt", "bar content");

		const snapshot = await snapshotWorkspace(clusterFs, { paths: ["/tmp/foo.txt"] });

		expect(snapshot.has("/tmp/foo.txt")).toBe(true);
		expect(snapshot.has("/home/user/bar.txt")).toBe(false);
		expect(snapshot.size).toBe(1);
	});

	test("backward compat: no options still filters to /home/user/", async () => {
		const clusterFs = createClusterFs({ hostName: "localhost", syncEnabled: true });
		await clusterFs.writeFile("/home/user/file.txt", "home content");
		await clusterFs.writeFile("/tmp/ignored.txt", "ignored content");

		const snapshot = await snapshotWorkspace(clusterFs);

		expect(snapshot.has("/home/user/file.txt")).toBe(true);
		expect(snapshot.has("/tmp/ignored.txt")).toBe(false);
	});

	test("empty paths array returns empty snapshot", async () => {
		const clusterFs = createClusterFs({ hostName: "localhost", syncEnabled: true });
		await clusterFs.writeFile("/tmp/foo.txt", "foo content");

		const snapshot = await snapshotWorkspace(clusterFs, { paths: [] });

		expect(snapshot.size).toBe(0);
	});
});
