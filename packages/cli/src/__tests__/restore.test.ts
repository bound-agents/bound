import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applySchema, createDatabase } from "@bound/core";
import { cleanupTmpDir } from "@bound/shared/test-utils";
import { runRestore } from "../commands/restore.js";

describe("restore command", () => {
	let tempDir: string;

	beforeEach(() => {
		// Use the OS temp dir so test directories don't litter the repo root.
		tempDir = mkdtempSync(join(tmpdir(), "bound-restore-test-"));
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
		const maliciousRowData = {
			id: "test-1",
			deleted: 0,
			"deleted; DROP TABLE users; --": 0, // SQL injection attempt in column name
		};

		const hlc1 = `${safeTime}_0000_test`;
		db.query(
			`INSERT INTO change_log (hlc, table_name, row_id, site_id, timestamp, row_data)
			VALUES (?, ?, ?, ?, ?, ?)`,
		).run(hlc1, "users", "test-1", "test-site", safeTime, JSON.stringify(maliciousRowData));

		// Create a clean row after safe timestamp to flag this row as "affected"
		const cleanRowData = {
			id: "test-1",
			deleted: 0,
		};

		const hlc2 = `${now}_0000_test`;
		db.query(
			`INSERT INTO change_log (hlc, table_name, row_id, site_id, timestamp, row_data)
			VALUES (?, ?, ?, ?, ?, ?)`,
		).run(hlc2, "users", "test-1", "test-site", now, JSON.stringify(cleanRowData));

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
});
