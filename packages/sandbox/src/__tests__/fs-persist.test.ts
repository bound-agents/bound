import Database from "bun:sqlite";
import { beforeEach, describe, expect, test } from "bun:test";

import { TypedEventEmitter } from "@bound/shared";

import { createClusterFs, snapshotWorkspace } from "../cluster-fs";
import { persistWorkspaceChanges } from "../fs-persist";

describe("Filesystem Persistence with OCC", () => {
	let db: Database;
	let eventBus: TypedEventEmitter;

	beforeEach(() => {
		db = new Database(":memory:");
		eventBus = new TypedEventEmitter();

		db.exec(`
			CREATE TABLE files (
				id TEXT PRIMARY KEY,
				siteId TEXT NOT NULL,
				path TEXT NOT NULL,
				content TEXT,
				deleted INTEGER DEFAULT 0,
				modified_at INTEGER NOT NULL,
				created_at INTEGER NOT NULL
			);

			CREATE TABLE change_log (
				id TEXT PRIMARY KEY,
				siteId TEXT NOT NULL,
				table_name TEXT NOT NULL,
				record_id TEXT NOT NULL,
				operation TEXT NOT NULL,
				before_values TEXT,
				after_values TEXT,
				created_at INTEGER NOT NULL
			);
		`);
	});

	test("persists clean file changes without conflicts", async () => {
		const fs = createClusterFs({ hostName: "localhost", syncEnabled: true });
		await fs.writeFile("/home/user/test.txt", "initial");
		const before = await snapshotWorkspace(fs);

		await fs.writeFile("/home/user/test.txt", "modified");
		const after = await snapshotWorkspace(fs);

		const result = await persistWorkspaceChanges(db, "test-site", before, after, eventBus);

		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.value.changes).toBeGreaterThan(0);
			expect(result.value.conflicts).toBe(0);
		}
	});

	test("detects file changes and updates database", async () => {
		const fs = createClusterFs({ hostName: "localhost", syncEnabled: true });
		await fs.writeFile("/home/user/file1.txt", "content1");
		const before = await snapshotWorkspace(fs);

		await fs.writeFile("/home/user/file2.txt", "content2");
		await fs.writeFile("/home/user/file1.txt", "modified");
		const after = await snapshotWorkspace(fs);

		const result = await persistWorkspaceChanges(db, "test-site", before, after, eventBus);

		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.value.changes).toBeGreaterThan(0);
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

		await persistWorkspaceChanges(db, "test-site", before, after, eventBus);

		expect(emittedCount).toBeGreaterThan(0);
	});
});
