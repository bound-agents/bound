import Database from "bun:sqlite";
import { beforeEach, describe, expect, test } from "bun:test";
import { applySchema } from "@bound/core";
import { TypedEventEmitter } from "@bound/shared";
import {
	createClusterFs,
	diffWorkspace,
	hydrateWorkspace,
	persistWorkspaceChanges,
	snapshotWorkspace,
} from "../index";

describe("Sandbox integration", () => {
	let db: Database;
	let siteId: string;

	beforeEach(() => {
		siteId = "test-site-id";
		db = new Database(":memory:");
		applySchema(db);
	});

	test("diffs workspace snapshots", () => {
		const before = new Map<string, string>();
		const after = new Map<string, string>();

		// Simulate a file being added
		after.set("/home/user/test.txt", "abc123");

		// Diff should show the change
		const changes = diffWorkspace(before, after);
		expect(changes).toBeDefined();
		expect(Array.isArray(changes)).toBe(true);
		expect(changes.length).toBe(1);
		expect(changes[0].operation).toBe("created");
	});

	test("completes full hydrate-exec-persist lifecycle", async () => {
		const eventBus = new TypedEventEmitter();

		// 1. Seed database with initial file
		const now = new Date().toISOString();
		db.run(
			"INSERT INTO files (id, path, content, deleted, created_at, modified_at, size_bytes) VALUES (?, ?, ?, 0, ?, ?, ?)",
			["/home/user/initial.txt", "/home/user/initial.txt", "initial content", now, now, 15],
		);

		// 2. Create and hydrate ClusterFs
		const fs = createClusterFs({ hostName: "localhost", syncEnabled: true });
		await hydrateWorkspace(fs, db);

		// Verify file was hydrated
		const content = await fs.readFile("/home/user/initial.txt");
		expect(content).toBe("initial content");

		// 3. Take snapshot before modifications
		const before = await snapshotWorkspace(fs);

		// 4. Modify file
		await fs.writeFile("/home/user/initial.txt", "modified content");

		// 5. Take snapshot after modifications
		const after = await snapshotWorkspace(fs);

		// 6. Persist changes
		const result = await persistWorkspaceChanges(
			db,
			siteId,
			before,
			after,
			eventBus,
			undefined,
			fs,
		);

		expect(result.ok).toBe(true);
		if (result.ok) {
			const value = result.value;
			expect(typeof value.changes).toBe("number");
			expect(typeof value.conflicts).toBe("number");
			expect(Array.isArray(value.conflictPaths)).toBe(true);

			// Verify database was updated
			const updated = db
				.query("SELECT * FROM files WHERE path = ?")
				.get("/home/user/initial.txt") as {
				content: string;
			};
			expect(updated.content).toBe("modified content");
		}
	});
});
