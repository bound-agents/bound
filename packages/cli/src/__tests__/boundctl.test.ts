import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { runConfigReload } from "../commands/config-reload.js";
import { runDrain } from "../commands/drain.js";
import { runSyncStatus } from "../commands/sync-status.js";

describe("boundctl commands", () => {
	let tempDir: string;
	let dbPath: string;

	beforeEach(() => {
		tempDir = mkdtempSync("boundctl-test-");
		const dataDir = join(tempDir, "data");
		mkdirSync(dataDir);
		dbPath = join(dataDir, "bound.db");

		// Initialize a test database
		const db = new Database(dbPath);

		// Create required tables
		db.exec(`
			CREATE TABLE IF NOT EXISTS host_meta (
				key TEXT PRIMARY KEY,
				value TEXT NOT NULL
			);

			CREATE TABLE IF NOT EXISTS cluster_config (
				key TEXT PRIMARY KEY,
				value TEXT NOT NULL,
				modified_at TEXT NOT NULL
			);

			CREATE TABLE IF NOT EXISTS change_log (
				seq INTEGER PRIMARY KEY AUTOINCREMENT,
				table_name TEXT NOT NULL,
				row_id TEXT NOT NULL,
				site_id TEXT NOT NULL,
				timestamp TEXT NOT NULL,
				row_data TEXT NOT NULL
			);

			CREATE TABLE IF NOT EXISTS sync_state (
				peer_site_id TEXT PRIMARY KEY,
				last_sync_at TEXT,
				last_sent INTEGER,
				last_received INTEGER,
				sync_errors INTEGER DEFAULT 0
			);

			CREATE TABLE IF NOT EXISTS hosts (
				site_id TEXT PRIMARY KEY,
				host_name TEXT NOT NULL,
				online_at TEXT,
				deleted INTEGER DEFAULT 0
			);

			CREATE TABLE IF NOT EXISTS tasks (
				id TEXT PRIMARY KEY,
				status TEXT NOT NULL,
				deleted INTEGER DEFAULT 0
			);
		`);

		// Insert site_id
		db.query("INSERT INTO host_meta (key, value) VALUES (?, ?)").run(
			"site_id",
			"test-site-id-12345678",
		);

		db.close();
	});

	afterEach(() => {
		rmSync(tempDir, { recursive: true, force: true });
	});

	describe("config reload", () => {
		it("reloads mcp configuration successfully", async () => {
			const configDir = join(tempDir, "config");
			mkdirSync(configDir);

			// Create valid mcp.json
			const mcpConfig = {
				servers: [
					{
						name: "test-server",
						transport: "stdio",
						command: "node",
						args: ["server.js"],
					},
				],
			};
			writeFileSync(join(configDir, "mcp.json"), JSON.stringify(mcpConfig, null, 2));

			await runConfigReload({
				target: "mcp",
				configDir,
			});

			// Verify change_log entry was created (open a fresh connection)
			const db = new Database(dbPath);
			const entry = db
				.query("SELECT * FROM cluster_config WHERE key = 'config_reload_requested'")
				.get() as { key: string; value: string; modified_at: string } | null;

			expect(entry).not.toBeNull();
			expect(entry?.key).toBe("config_reload_requested");

			// Check change_log also has the entry
			const changeLogCount = db
				.query(
					"SELECT COUNT(*) as count FROM change_log WHERE table_name = 'cluster_config' AND row_id = 'config_reload_requested'",
				)
				.get() as { count: number };

			expect(changeLogCount.count).toBeGreaterThan(0);

			db.close();
		});

		it("reloads mcp configuration with HTTP transport", async () => {
			const configDir = join(tempDir, "config");
			mkdirSync(configDir);

			// Create valid mcp.json with HTTP transport
			const mcpConfig = {
				servers: [
					{
						name: "http-server",
						transport: "http",
						url: "http://localhost:3001/mcp",
					},
				],
			};
			writeFileSync(join(configDir, "mcp.json"), JSON.stringify(mcpConfig, null, 2));

			await runConfigReload({
				target: "mcp",
				configDir,
			});

			// Verify change_log entry was created
			const db = new Database(dbPath);
			const entry = db
				.query("SELECT * FROM cluster_config WHERE key = 'config_reload_requested'")
				.get() as { key: string; value: string; modified_at: string } | null;

			expect(entry).not.toBeNull();
			db.close();
		});
	});

	describe("sync-status", () => {
		it("displays sync status successfully", async () => {
			const dataDir = join(tempDir, "data");

			// Add some test data
			const db = new Database(dbPath);

			db.query(
				"INSERT INTO change_log (table_name, row_id, site_id, timestamp, row_data) VALUES (?, ?, ?, ?, ?)",
			).run("test_table", "row1", "test-site-id", new Date().toISOString(), "{}");

			db.query(
				"INSERT INTO hosts (site_id, host_name, online_at, deleted) VALUES (?, ?, ?, ?)",
			).run("peer-site-1", "peer-host-1", new Date().toISOString(), 0);

			db.query(
				"INSERT INTO sync_state (peer_site_id, last_sync_at, last_sent, last_received, sync_errors) VALUES (?, ?, ?, ?, ?)",
			).run("peer-site-1", new Date().toISOString(), 0, 0, 0);

			db.close();

			// Should not throw
			await runSyncStatus({
				configDir: dataDir,
			});
		});

		it("handles empty sync state gracefully", async () => {
			const dataDir = join(tempDir, "data");

			// Should not throw even with no data
			await runSyncStatus({
				configDir: dataDir,
			});
		});
	});

	describe("drain", () => {
		it("drains and switches hub successfully", async () => {
			const dataDir = join(tempDir, "data");

			// Add a running task
			const db = new Database(dbPath);
			db.query("INSERT INTO tasks (id, status, deleted) VALUES (?, ?, ?)").run(
				"task-1",
				"completed",
				0,
			);
			db.close();

			await runDrain({
				newHub: "new-hub-host",
				timeout: 5,
				configDir: dataDir,
			});

			// Verify hub was set
			const db2 = new Database(dbPath);
			const hubEntry = db2
				.query("SELECT * FROM cluster_config WHERE key = 'cluster_hub'")
				.get() as { key: string; value: string } | null;

			expect(hubEntry).not.toBeNull();
			expect(hubEntry?.value).toBe("new-hub-host");

			// Verify emergency_stop was cleared
			const stopEntry = db2
				.query("SELECT * FROM cluster_config WHERE key = 'emergency_stop'")
				.get();

			expect(stopEntry).toBeNull();

			db2.close();
		});

		it("handles timeout when tasks are running", async () => {
			const dataDir = join(tempDir, "data");

			// Add a running task that won't complete
			const db = new Database(dbPath);
			db.query("INSERT INTO tasks (id, status, deleted) VALUES (?, ?, ?)").run(
				"task-1",
				"running",
				0,
			);
			db.close();

			// Use very short timeout
			await runDrain({
				newHub: "new-hub-host",
				timeout: 1,
				configDir: dataDir,
			});

			// Should still complete and set hub despite timeout
			const db2 = new Database(dbPath);
			const hubEntry = db2
				.query("SELECT * FROM cluster_config WHERE key = 'cluster_hub'")
				.get() as { key: string; value: string } | null;

			expect(hubEntry).not.toBeNull();
			expect(hubEntry?.value).toBe("new-hub-host");

			db2.close();
		});
	});
});
