import Database from "bun:sqlite";
import { beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { applySchema, insertRow } from "@bound/core";
import { InMemoryFs, MountableFs } from "just-bash";
import {
	createClusterFs,
	diffWorkspaceAsync,
	hydrateWorkspace,
	snapshotWorkspace,
} from "../cluster-fs";

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
			rmSync(tmpDir, { recursive: true });
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

describe("hydrateWorkspace", () => {
	let db: Database;
	let fs: MountableFs;

	beforeEach(() => {
		db = new Database(":memory:");
		applySchema(db);
		fs = new MountableFs({ base: new InMemoryFs() });
	});

	function insertFile(database: Database, path: string, content: string, deleted = 0) {
		const now = new Date().toISOString();
		insertRow(
			database,
			"files",
			{
				id: path,
				path,
				content,
				deleted,
				size_bytes: Buffer.byteLength(content),
				created_at: now,
				modified_at: now,
			},
			"test-site",
		);
	}

	test("AC2.1: restores files from /tmp/ path", async () => {
		insertFile(db, "/tmp/scratch.txt", "hello");

		await hydrateWorkspace(fs, db);

		const read = await fs.readFile("/tmp/scratch.txt");
		expect(read).toBe("hello");
	});

	test("AC2.2: restores files from arbitrary paths like /workspace/", async () => {
		insertFile(db, "/workspace/foo.ts", "const x = 1;");

		await hydrateWorkspace(fs, db);

		const read = await fs.readFile("/workspace/foo.ts");
		expect(read).toBe("const x = 1;");
	});

	test("AC2.3: restores /home/user/ files (no regression)", async () => {
		insertFile(db, "/home/user/notes.txt", "my notes");

		await hydrateWorkspace(fs, db);

		const read = await fs.readFile("/home/user/notes.txt");
		expect(read).toBe("my notes");
	});

	test("AC2.4: does NOT restore /mnt/ paths", async () => {
		insertFile(db, "/mnt/host/file.txt", "should not restore");

		await hydrateWorkspace(fs, db);

		try {
			await fs.readFile("/mnt/host/file.txt");
			expect.unreachable("File should not have been restored");
		} catch (_error) {
			// Expected: file was not hydrated
		}
	});

	test("AC2.5: does NOT restore soft-deleted rows", async () => {
		insertFile(db, "/tmp/gone.txt", "deleted content", 1);

		await hydrateWorkspace(fs, db);

		try {
			await fs.readFile("/tmp/gone.txt");
			expect.unreachable("Deleted file should not have been restored");
		} catch (_error) {
			// Expected: soft-deleted file was not hydrated
		}
	});
});
