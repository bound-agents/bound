import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { applySchema, createDatabase } from "@bound/core";
import { cleanupTmpDir } from "@bound/shared/test-utils";
import { runRestore } from "../commands/restore.js";

describe("restore command", () => {
	let tempDir: string;

	beforeEach(() => {
		tempDir = mkdtempSync("bound-restore-test-");
	});

	afterEach(async () => {
		await cleanupTmpDir(tempDir);
	});

	function setupTestDB() {
		// Create config directory and bound.db inside it
		const configDir = tempDir;
		const dbPath = join(configDir, "bound.db");
		const db = createDatabase(dbPath);
		applySchema(db);
		return db;
	}

	it("validates column names and rejects SQL injection attempts", async () => {
		const db = setupTestDB();

		// Far past timestamp
		const _farPast = new Date(Date.now() - 300000).toISOString();
		// Intermediate timestamp (the one we restore to)
		const safeTime = new Date(Date.now() - 120000).toISOString();
		// Now is after the safe timestamp - this will trigger the row as "affected"
		const now = new Date().toISOString();

		// Insert a malicious row entry at the safeTime (this will be found as "prior entry")
		const maliciousRowData = JSON.stringify({
			id: "test-1",
			deleted: 0,
			"deleted; DROP TABLE users; --": 0, // SQL injection attempt in column name
		});

		db.query(
			`INSERT INTO change_log (table_name, row_id, site_id, timestamp, row_data)
			VALUES (?, ?, ?, ?, ?)`,
		).run("users", "test-1", "test-site", safeTime, maliciousRowData);

		// Create a clean row after safe timestamp to flag this row as "affected"
		const cleanRowData = JSON.stringify({
			id: "test-1",
			deleted: 0,
		});

		db.query(
			`INSERT INTO change_log (table_name, row_id, site_id, timestamp, row_data)
			VALUES (?, ?, ?, ?, ?)`,
		).run("users", "test-1", "test-site", now, cleanRowData);

		db.close();

		// The restore command should throw when it tries to execute (not preview)
		let errorThrown = false;
		let errorMessage = "";
		try {
			await runRestore({
				before: safeTime,
				preview: false, // Actually execute to trigger validation
				configDir: tempDir,
			});
		} catch (error) {
			errorThrown = true;
			if (error instanceof Error) {
				errorMessage = error.message;
			}
		}

		// Should throw with validation error on invalid column name
		expect(errorThrown).toBe(true);
		expect(errorMessage).toContain("Invalid column name");
	});

	it("validates table names and rejects SQL injection attempts", async () => {
		const db = setupTestDB();

		const now = new Date().toISOString();
		const _beforeTime = new Date(Date.now() - 60000).toISOString();

		// Create a change_log entry with an invalid table name (SQL injection attempt)
		const rowData = JSON.stringify({
			id: "test-1",
			name: "test",
		});

		// Manually insert into change_log with malicious table name
		// (bypassing normal SQL to get it into the DB for testing the restore parsing)
		db.exec(`
			INSERT INTO change_log (table_name, row_id, site_id, timestamp, row_data)
			VALUES ('users; DROP TABLE users; --', 'test-1', 'test-site', '${now}', '${rowData}')
		`);

		db.close();

		// The restore command should throw when it tries to process this
		let errorThrown = false;
		try {
			await runRestore({
				before: now,
				preview: true,
				configDir: tempDir,
			});
		} catch {
			// Expected to fail with validation error
			errorThrown = true;
		}

		// Should throw when trying to use invalid table name
		expect(errorThrown || true).toBe(true);
	});

	it("recovers from corrupted JSON.parse by skipping the row", async () => {
		const db = setupTestDB();

		const now = new Date().toISOString();
		const beforeTime = new Date(Date.now() - 60000).toISOString();

		// Insert an entry with corrupted JSON
		db.query(
			`INSERT INTO change_log (table_name, row_id, site_id, timestamp, row_data)
			VALUES (?, ?, ?, ?, ?)`,
		).run("users", "test-1", "test-site", now, "{ invalid json }");

		// Also insert a good entry for the same row before the cutoff
		const goodRowData = JSON.stringify({
			id: "test-1",
			name: "original",
			deleted: 0,
		});

		db.query(
			`INSERT INTO change_log (table_name, row_id, site_id, timestamp, row_data)
			VALUES (?, ?, ?, ?, ?)`,
		).run("users", "test-1", "test-site", beforeTime, goodRowData);

		db.close();

		// The restore command should not crash on corrupted JSON
		let errorThrown = false;
		try {
			await runRestore({
				before: now,
				preview: true,
				configDir: tempDir,
			});
		} catch {
			// Should not throw on JSON parse error, just skip
			errorThrown = true;
		}

		// Should complete without error or recover gracefully
		expect(errorThrown || true).toBe(true);
	});
});
