import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyMetricsSchema, applySchema, createDatabase } from "@bound/core";
import { cleanupTmpDir } from "@bound/shared/test-utils";
import { runDrain } from "../commands/drain.js";
import { runSetHub } from "../commands/set-hub.js";
import { runSetPersona } from "../commands/set-persona.js";

describe("boundctl commands", () => {
	let tempDir: string;
	let dbPath: string;

	beforeEach(() => {
		// Use the OS temp dir so test directories don't litter the repo root.
		tempDir = mkdtempSync(join(tmpdir(), `boundctl-test-${randomBytes(4).toString("hex")}-`));
		const dataDir = join(tempDir, "data");
		mkdirSync(dataDir);
		dbPath = join(dataDir, "bound.db");

		// Apply the full production schema so commands like sync-status, which query
		// all current command tables are present.
		const db = createDatabase(dbPath);
		applySchema(db);
		applyMetricsSchema(db);

		// Insert site_id so getSiteId() returns a real value during command execution.
		db.query("INSERT INTO host_meta (key, value) VALUES (?, ?)").run(
			"site_id",
			"test-site-id-12345678",
		);

		db.close();
	});

	afterEach(async () => {
		await cleanupTmpDir(tempDir);
	});

	describe("set-persona", () => {
		it("seeds the persona row and a change_log entry from a file", async () => {
			const configDir = join(tempDir, "config");
			mkdirSync(configDir);
			const personaPath = join(configDir, "persona.md");
			writeFileSync(personaPath, "You are a careful systems engineer.");

			await runSetPersona({ file: personaPath, configDir });

			const db = new Database(dbPath);
			const row = db.query("SELECT value FROM cluster_config WHERE key = 'persona'").get() as {
				value: string;
			} | null;
			expect(row?.value).toBe("You are a careful systems engineer.");

			const changeLogCount = db
				.query(
					"SELECT COUNT(*) as count FROM change_log WHERE table_name = 'cluster_config' AND row_id = 'persona'",
				)
				.get() as { count: number };
			expect(changeLogCount.count).toBeGreaterThan(0);
			db.close();
		});

		it("overwrites an existing persona row (single global LWW value)", async () => {
			const configDir = join(tempDir, "config");
			mkdirSync(configDir);
			const first = join(configDir, "first.md");
			const second = join(configDir, "second.md");
			writeFileSync(first, "Original voice.");
			writeFileSync(second, "Replacement voice.");

			await runSetPersona({ file: first, configDir });
			await runSetPersona({ file: second, configDir });

			const db = new Database(dbPath);
			const row = db.query("SELECT value FROM cluster_config WHERE key = 'persona'").get() as {
				value: string;
			};
			expect(row.value).toBe("Replacement voice.");
			const count = db
				.query("SELECT COUNT(*) as count FROM cluster_config WHERE key = 'persona'")
				.get() as { count: number };
			expect(count.count).toBe(1);
			db.close();
		});

		it("rejects a persona over the 64 KB cap and writes nothing", async () => {
			const configDir = join(tempDir, "config");
			mkdirSync(configDir);
			const personaPath = join(configDir, "big.md");
			writeFileSync(personaPath, "x".repeat(64 * 1024 + 1));

			await expect(runSetPersona({ file: personaPath, configDir })).rejects.toThrow(/cap/);

			const db = new Database(dbPath);
			const row = db.query("SELECT value FROM cluster_config WHERE key = 'persona'").get();
			expect(row).toBeNull();
			db.close();
		});

		it("rejects an empty persona file", async () => {
			const configDir = join(tempDir, "config");
			mkdirSync(configDir);
			const personaPath = join(configDir, "empty.md");
			writeFileSync(personaPath, "");

			await expect(runSetPersona({ file: personaPath, configDir })).rejects.toThrow(/empty/);
		});
	});

	describe("drain", () => {
		it("drains and switches hub successfully", async () => {
			const dataDir = join(tempDir, "data");

			// Add a completed task so the drain loop sees zero running tasks immediately.
			const db = new Database(dbPath);
			const nowIso = new Date().toISOString();
			db.query(
				"INSERT INTO tasks (id, type, status, trigger_spec, created_at, modified_at, deleted) VALUES (?, ?, ?, ?, ?, ?, ?)",
			).run("task-1", "deferred", "completed", "manual", nowIso, nowIso, 0);
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

			// Verify emergency_stop was cleared. cluster_config now soft-deletes
			// (invariant #2): the row persists with deleted=1 so the cleared state
			// replicates, and live reads (filtered deleted=0) see nothing.
			const stopRow = db2
				.query("SELECT deleted FROM cluster_config WHERE key = 'emergency_stop'")
				.get() as { deleted: number } | null;
			expect(stopRow).not.toBeNull();
			expect(stopRow?.deleted).toBe(1);

			const liveStop = db2
				.query("SELECT * FROM cluster_config WHERE key = 'emergency_stop' AND deleted = 0")
				.get();
			expect(liveStop).toBeNull();

			db2.close();
		});

		it("handles timeout when tasks are running", async () => {
			const dataDir = join(tempDir, "data");

			// Add a running task that won't complete during the drain window.
			const db = new Database(dbPath);
			const nowIso = new Date().toISOString();
			db.query(
				"INSERT INTO tasks (id, type, status, trigger_spec, created_at, modified_at, deleted) VALUES (?, ?, ?, ?, ?, ?, ?)",
			).run("task-1", "deferred", "running", "manual", nowIso, nowIso, 0);
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

	describe("set-hub", () => {
		it("sets the hub without legacy relay-table drain machinery", async () => {
			const dataDir = join(tempDir, "data");
			await runSetHub({ hostName: "new-hub-host", configDir: dataDir });
			const db = new Database(dbPath);
			expect(db.query("SELECT value FROM cluster_config WHERE key = 'cluster_hub'").get()).toEqual({
				value: "new-hub-host",
			});
			expect(
				db
					.query(
						"SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('relay_outbox', 'relay_inbox')",
					)
					.all(),
			).toEqual([]);
			db.close();
		});
	});
});
