import Database from "bun:sqlite";
import { beforeEach, describe, expect, test } from "bun:test";
import { applySchema } from "@bound/core";
import { TypedEventEmitter } from "@bound/shared";
import {
	createClusterFs,
	createDefineCommands,
	createSandbox,
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

	test("hydrates workspace from database", async () => {
		// Seed files in database
		const now = new Date().toISOString();
		db.run(
			"INSERT INTO files (id, path, content, deleted, created_at, modified_at, size_bytes) VALUES (?, ?, ?, 0, ?, ?, ?)",
			["/home/user/test.txt", "/home/user/test.txt", "Hello, world!", now, now, 13],
		);

		// Create and hydrate ClusterFs
		const config = {
			hostName: "localhost",
			syncEnabled: true,
		};
		const fs = createClusterFs(config);
		await hydrateWorkspace(fs, db);

		// Verify hydration occurred by reading file
		const content = await fs.readFile("/home/user/test.txt");
		expect(content).toBe("Hello, world!");
	});

	test("snapshots workspace before and after changes", async () => {
		const config = {
			hostName: "localhost",
			syncEnabled: true,
		};
		const fs = createClusterFs(config);

		// Create initial snapshot
		const before = await snapshotWorkspace(fs);
		expect(before).toBeDefined();
		expect(before instanceof Map).toBe(true);

		// Write a file and snapshot again
		await fs.writeFile("/home/user/test.txt", "content");
		const after = await snapshotWorkspace(fs);

		expect(after.size).toBeGreaterThan(before.size);
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

	test("registers defineCommands with context", async () => {
		const mockLogger = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };
		const mockEventBus = new TypedEventEmitter();

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

		const context = {
			db,
			siteId,
			eventBus: mockEventBus,
			logger: mockLogger,
		};

		const commands = createDefineCommands(definitions, context);
		expect(commands).toBeDefined();
		expect(Array.isArray(commands)).toBe(true);
		expect(commands.length).toBe(1);

		// Actually execute the command
		const result = await commands[0].handler(["hello"]);
		expect(result.stdout).toBe("hello");
	});

	test("creates sandbox with factory and executes commands", async () => {
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
		expect(sandbox.bash).toBeDefined();

		// Execute a command
		const result = await sandbox.bash.exec("echo 'hello from sandbox'");
		expect(result.stdout).toContain("hello from sandbox");
		expect(result.exitCode).toBe(0);
	});

	test("persists workspace changes to database", async () => {
		const eventBus = new TypedEventEmitter();
		const fs = createClusterFs({ hostName: "localhost", syncEnabled: true });

		// Write file and get snapshots
		await fs.writeFile("/home/user/document.txt", "content");
		const before = new Map<string, string>();
		const after = await snapshotWorkspace(fs);

		// Persist changes
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
			expect(result.value.changes).toBeGreaterThan(0);
		}

		// Verify file is in database
		const files = db
			.query("SELECT * FROM files WHERE path = ?")
			.all("/home/user/document.txt") as Array<{
			content: string;
		}>;
		expect(files.length).toBeGreaterThan(0);
		expect(files[0].content).toBe("content");
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
