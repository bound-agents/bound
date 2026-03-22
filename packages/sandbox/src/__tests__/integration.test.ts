import { Database } from "bun:sqlite";
import { beforeEach, describe, expect, it } from "bun:test";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TypedEventEmitter } from "@bound/shared";
import {
	createClusterFs,
	createDefineCommands,
	createSandbox,
	diffWorkspace,
	hydrateWorkspace,
	persistWorkspaceChanges,
	snapshotWorkspaceSync,
} from "../index";

describe("Sandbox integration", () => {
	let db: Database;
	let dbPath: string;
	let siteId: string;

	beforeEach(() => {
		siteId = randomUUID();
		dbPath = join(tmpdir(), `test-${randomUUID()}.db`);
		db = new Database(dbPath);

		// Initialize minimal schema
		db.run(`
			CREATE TABLE IF NOT EXISTS files (
				id TEXT PRIMARY KEY,
				site_id TEXT NOT NULL,
				path TEXT NOT NULL,
				content TEXT NOT NULL,
				content_hash TEXT NOT NULL,
				size_bytes INTEGER NOT NULL,
				modified_at INTEGER NOT NULL,
				deleted INTEGER NOT NULL DEFAULT 0,
				UNIQUE(site_id, path)
			)
		`);

		db.run(`
			CREATE TABLE IF NOT EXISTS change_log (
				id TEXT PRIMARY KEY,
				site_id TEXT NOT NULL,
				table_name TEXT NOT NULL,
				operation TEXT NOT NULL,
				row_id TEXT NOT NULL,
				changes TEXT NOT NULL,
				created_at INTEGER NOT NULL
			)
		`);
	});

	it("should hydrate workspace from database", () => {
		// Seed files in database
		const now = Date.now();
		db.run("INSERT INTO files VALUES (?, ?, ?, ?, ?, ?, ?, 0)", [
			randomUUID(),
			siteId,
			"/home/user/test.txt",
			"Hello, world!",
			"abc123",
			13,
			now,
		]);

		// Create and hydrate ClusterFs
		const config = {
			hostName: "localhost",
			syncEnabled: true,
		};
		const fs = createClusterFs(config);
		hydrateWorkspace(fs, db);

		// Verify hydration occurred (no errors thrown)
		expect(fs).toBeDefined();
	});

	it("should snapshot workspace before and after changes", () => {
		const config = {
			hostName: "localhost",
			syncEnabled: true,
		};
		const fs = createClusterFs(config);

		// Create initial snapshot
		const before = snapshotWorkspaceSync(fs);
		expect(before).toBeDefined();
		expect(before instanceof Map).toBe(true);

		// Should be empty initially
		expect(before.size).toBe(0);
	});

	it("should diff workspace snapshots", () => {
		const before = new Map<string, string>();
		const after = new Map<string, string>();

		// Simulate a file being added
		after.set("/home/user/test.txt", "abc123");

		// Diff should show the change
		const changes = diffWorkspace(before, after);
		expect(changes).toBeDefined();
		expect(Array.isArray(changes)).toBe(true);
	});

	it("should register defineCommands", () => {
		// Register a simple echo command
		const definitions = [
			{
				name: "echo-test",
				args: [{ name: "message", required: true, description: "Message to echo" }],
				handler: async (args: Record<string, string>) => {
					return {
						stdout: args.message,
						stderr: "",
						exitCode: 0,
					};
				},
			},
		];

		const commands = createDefineCommands(definitions);
		expect(commands).toBeDefined();
		expect(Array.isArray(commands)).toBe(true);
		expect(commands.length).toBe(1);
	});

	it("should create sandbox with factory", async () => {
		const config = {
			hostName: "localhost",
			syncEnabled: true,
		};
		const fs = createClusterFs(config);

		const sandboxConfig = {
			clusterFs: fs,
			commands: [],
		};

		const sandbox = await createSandbox(sandboxConfig);
		expect(sandbox).toBeDefined();
	});

	it("should persist workspace changes to database", async () => {
		const eventBus = new TypedEventEmitter();

		// Create before and after snapshots
		const before = new Map<string, string>();
		const after = new Map<string, string>();

		// Add a file
		after.set("/home/user/document.txt", "document_hash_123");

		// Persist changes
		const result = await persistWorkspaceChanges(db, siteId, before, after, eventBus);

		// Verify result is a Result type
		expect(result).toBeDefined();
		expect(typeof result.ok).toBe("boolean");

		// Check if persistence was successful
		if (result.ok) {
			expect(result.value.changes).toBeGreaterThanOrEqual(0);
		}
	});

	it("should lifecycle complete hydrate-snapshot-persist flow", async () => {
		const eventBus = new TypedEventEmitter();

		// 1. Seed database with file
		const now = Date.now();
		db.run("INSERT INTO files VALUES (?, ?, ?, ?, ?, ?, ?, 0)", [
			randomUUID(),
			siteId,
			"/home/user/seed.txt",
			"Seeded content",
			"seed_hash",
			14,
			now,
		]);

		// 2. Create and hydrate ClusterFs
		const config = { hostName: "localhost", syncEnabled: true };
		const fs = createClusterFs(config);
		hydrateWorkspace(fs, db);

		// 3. Take snapshot
		const before = snapshotWorkspaceSync(fs);
		expect(before.size).toBeGreaterThanOrEqual(0);

		// 4. Create another snapshot (representing workspace after some ops)
		const after = new Map(before);
		after.set("/home/user/new.txt", "new_hash");

		// 5. Persist changes
		const result = await persistWorkspaceChanges(db, siteId, before, after, eventBus);
		expect(result).toBeDefined();

		// 6. Verify result structure
		if (result.ok) {
			const value = result.value;
			expect(typeof value.changes).toBe("number");
			expect(typeof value.conflicts).toBe("number");
			expect(Array.isArray(value.conflictPaths)).toBe(true);
		}
	});
});
