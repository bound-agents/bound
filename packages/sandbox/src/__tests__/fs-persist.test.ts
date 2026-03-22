import Database from "bun:sqlite";
import { beforeEach, describe, expect, test } from "bun:test";

import { applySchema } from "@bound/core";
import { TypedEventEmitter } from "@bound/shared";

import { createClusterFs, snapshotWorkspace } from "../cluster-fs";
import { persistWorkspaceChanges } from "../fs-persist";

describe("Filesystem Persistence with OCC", () => {
	let db: Database;
	let eventBus: TypedEventEmitter;

	beforeEach(() => {
		db = new Database(":memory:");
		eventBus = new TypedEventEmitter();

		applySchema(db);
	});

	test("persists file changes and writes to database", async () => {
		const fs = createClusterFs({ hostName: "localhost", syncEnabled: true });
		await fs.writeFile("/home/user/test.txt", "initial");
		const before = await snapshotWorkspace(fs);

		await fs.writeFile("/home/user/test.txt", "modified content");
		const after = await snapshotWorkspace(fs);

		const result = await persistWorkspaceChanges(
			db,
			"test-site",
			before,
			after,
			eventBus,
			undefined,
			fs,
		);

		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.value.changes).toBeGreaterThan(0);
			expect(result.value.conflicts).toBe(0);

			// Verify data was actually written to database
			const dbFiles = db
				.query("SELECT * FROM files WHERE path = ?")
				.all("/home/user/test.txt") as Array<{
				path: string;
				content: string;
			}>;
			expect(dbFiles.length).toBeGreaterThan(0);
			expect(dbFiles[0].content).toBe("modified content");
		}
	});

	test("creates change_log entries for persisted changes", async () => {
		const fs = createClusterFs({ hostName: "localhost", syncEnabled: true });
		await fs.writeFile("/home/user/file.txt", "content");
		const before = await snapshotWorkspace(fs);

		await fs.writeFile("/home/user/file.txt", "new content");
		const after = await snapshotWorkspace(fs);

		const result = await persistWorkspaceChanges(
			db,
			"test-site",
			before,
			after,
			eventBus,
			undefined,
			fs,
		);

		expect(result.ok).toBe(true);
		if (result.ok) {
			// Verify change_log entries were created
			const logs = db
				.query("SELECT * FROM change_log WHERE table_name = ?")
				.all("files") as Array<unknown>;
			expect(logs.length).toBeGreaterThan(0);
		}
	});

	test("rejects files exceeding individual size limit", async () => {
		const fs = createClusterFs({ hostName: "localhost", syncEnabled: true });
		const largeContent = "x".repeat(2 * 1024 * 1024); // 2MB
		await fs.writeFile("/home/user/large.txt", largeContent);
		const before = new Map<string, string>(); // Start empty

		const after = await snapshotWorkspace(fs); // Now we have the large file

		const result = await persistWorkspaceChanges(
			db,
			"test-site",
			before,
			after,
			eventBus,
			{
				maxFileSizeBytes: 1024 * 1024, // 1MB limit
			},
			fs,
		);

		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.error.failedPaths).toContain("/home/user/large.txt");
		}
	});

	test("rejects when total size exceeds aggregate limit", async () => {
		const fs = createClusterFs({ hostName: "localhost", syncEnabled: true });
		await fs.writeFile("/home/user/file1.txt", "x".repeat(60 * 1024 * 1024)); // 60MB, exceeds 50MB limit
		const before = new Map<string, string>(); // Start empty

		const after = await snapshotWorkspace(fs); // Now we have 60MB

		const result = await persistWorkspaceChanges(
			db,
			"test-site",
			before,
			after,
			eventBus,
			{
				maxTotalSizeBytes: 50 * 1024 * 1024, // 50MB limit
				maxFileSizeBytes: 100 * 1024 * 1024, // file size limit allows up to 100MB
			},
			fs,
		);

		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.error.message).toContain("Total workspace size exceeds limit");
		}
	});

	test("returns early with zero changes", async () => {
		const snapshot = new Map<string, string>();
		snapshot.set("/home/user/file.txt", "hash123");

		const result = await persistWorkspaceChanges(db, "test-site", snapshot, snapshot, eventBus);

		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.value.changes).toBe(0);
		}
	});

	test("emits file:changed events for each modification", async () => {
		const fs = createClusterFs({ hostName: "localhost", syncEnabled: true });
		await fs.writeFile("/home/user/file1.txt", "content1");
		await fs.writeFile("/home/user/file2.txt", "content2");
		const before = await snapshotWorkspace(fs);

		await fs.writeFile("/home/user/file3.txt", "content3");
		const after = await snapshotWorkspace(fs);

		let emittedCount = 0;
		eventBus.on("file:changed", () => {
			emittedCount++;
		});

		await persistWorkspaceChanges(db, "test-site", before, after, eventBus, undefined, fs);

		expect(emittedCount).toBeGreaterThan(0);
	});

	test("detects OCC conflicts and logs them", async () => {
		// Set up initial state
		const fs = createClusterFs({ hostName: "localhost", syncEnabled: true });
		await fs.writeFile("/home/user/contested.txt", "original");
		const before = await snapshotWorkspace(fs);

		// Simulate concurrent modification in DB
		const now = new Date().toISOString();
		db.run(
			`INSERT INTO files (id, path, content, deleted, created_at, modified_at, size_bytes)
			 VALUES (?, ?, ?, 0, ?, ?, ?)`,
			[
				"/home/user/contested.txt",
				"/home/user/contested.txt",
				"concurrent change",
				now,
				now,
				18, // size of "concurrent change"
			],
		);

		// Modify locally
		await fs.writeFile("/home/user/contested.txt", "local change");
		const after = await snapshotWorkspace(fs);

		const result = await persistWorkspaceChanges(
			db,
			"test-site",
			before,
			after,
			eventBus,
			undefined,
			fs,
		);

		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.value.conflicts).toBeGreaterThan(0);
			expect(result.value.conflictPaths).toContain("/home/user/contested.txt");
		}
	});
});
