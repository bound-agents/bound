import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Database } from "bun:sqlite";
import { createDatabase } from "../database";
import { applySchema } from "../schema";

describe("R-W3: Database lock timeout returns error (no deadlock)", () => {
	let dbPath: string;
	let db1: Database;
	let db2: Database;

	beforeEach(() => {
		dbPath = join(tmpdir(), `bound-test-${randomBytes(4).toString("hex")}.db`);
		db1 = createDatabase(dbPath);
		applySchema(db1);

		// Set up site_id in host_meta for insertRow operations
		db1.run("INSERT INTO host_meta (key, value) VALUES (?, ?)", ["site_id", "test-site-123"]);
	});

	afterEach(() => {
		try {
			db1.close();
		} catch {
			// ignore
		}
		try {
			db2?.close();
		} catch {
			// ignore
		}
		try {
			require("node:fs").unlinkSync(dbPath);
		} catch {
			// ignore
		}
	});

	it("concurrent writes handle lock gracefully within busy_timeout", () => {
		// Open the same database a second time with a shorter busy_timeout for testing
		db2 = new (require("bun:sqlite").Database)(dbPath);
		db2.run("PRAGMA busy_timeout = 100"); // 100ms timeout for faster test

		// Start a transaction on connection 1
		db1.exec("BEGIN IMMEDIATE");

		// Insert some data in the transaction
		db1.run("INSERT INTO host_meta (key, value) VALUES (?, ?)", ["test_key_1", "test_value_1"]);

		const startTime = Date.now();

		// Try to write on connection 2 - should get a lock error after busy_timeout
		let caughtError: Error | null = null;
		try {
			// Use BEGIN IMMEDIATE which will wait for busy_timeout then fail
			db2.exec("BEGIN IMMEDIATE");
			db2.run("INSERT INTO host_meta (key, value) VALUES (?, ?)", ["test_key_2", "test_value_2"]);
			db2.exec("COMMIT");
		} catch (error) {
			caughtError = error as Error;
		}

		const elapsed = Date.now() - startTime;

		// Verify we got a "database is locked" error
		expect(caughtError).not.toBeNull();
		expect(caughtError?.message.toLowerCase()).toContain("lock");

		// Verify it happened within a reasonable time (should be ~100ms + some overhead)
		expect(elapsed).toBeGreaterThanOrEqual(50); // At least tried to wait
		expect(elapsed).toBeLessThan(1000); // But didn't hang forever

		// Clean up - commit the first transaction
		db1.exec("COMMIT");
	});

	it("lock is released after transaction commit", () => {
		db2 = createDatabase(dbPath);

		// Start and complete a transaction on connection 1
		db1.exec("BEGIN IMMEDIATE");
		db1.run("INSERT INTO host_meta (key, value) VALUES (?, ?)", ["key1", "value1"]);
		db1.exec("COMMIT");

		// Now connection 2 should be able to write without error
		expect(() => {
			db2.run("INSERT INTO host_meta (key, value) VALUES (?, ?)", ["key2", "value2"]);
		}).not.toThrow();

		// Verify both writes succeeded
		const rows = db2.query("SELECT key, value FROM host_meta WHERE key LIKE 'key%'").all() as Array<{
			key: string;
			value: string;
		}>;

		expect(rows.length).toBe(2);
		expect(rows.some((r) => r.key === "key1" && r.value === "value1")).toBe(true);
		expect(rows.some((r) => r.key === "key2" && r.value === "value2")).toBe(true);
	});

	it("lock is released after transaction rollback", () => {
		db2 = createDatabase(dbPath);

		// Start a transaction on connection 1 and rollback
		db1.exec("BEGIN IMMEDIATE");
		db1.run("INSERT INTO host_meta (key, value) VALUES (?, ?)", ["rollback_key", "rollback_value"]);
		db1.exec("ROLLBACK");

		// Connection 2 should be able to write
		expect(() => {
			db2.run("INSERT INTO host_meta (key, value) VALUES (?, ?)", ["after_rollback", "value"]);
		}).not.toThrow();

		// Verify the rolled back write did not persist
		const rollbackRow = db2.query("SELECT * FROM host_meta WHERE key = 'rollback_key'").get();
		expect(rollbackRow).toBeNull();

		// Verify the second write did persist
		const afterRollbackRow = db2
			.query("SELECT * FROM host_meta WHERE key = 'after_rollback'")
			.get() as { key: string; value: string } | null;
		expect(afterRollbackRow).not.toBeNull();
		expect(afterRollbackRow?.value).toBe("value");
	});

	it("read operations can proceed during write transaction", () => {
		db2 = createDatabase(dbPath);

		// Insert initial data
		db1.run("INSERT INTO host_meta (key, value) VALUES (?, ?)", ["read_key", "read_value"]);

		// Start a write transaction on connection 1
		db1.exec("BEGIN IMMEDIATE");
		db1.run("INSERT INTO host_meta (key, value) VALUES (?, ?)", ["write_key", "write_value"]);

		// Connection 2 should be able to read existing data
		const row = db2.query("SELECT * FROM host_meta WHERE key = 'read_key'").get() as {
			key: string;
			value: string;
		} | null;

		expect(row).not.toBeNull();
		expect(row?.key).toBe("read_key");
		expect(row?.value).toBe("read_value");

		// Clean up
		db1.exec("COMMIT");
	});

	it("busy_timeout is set to 5000ms", () => {
		// PRAGMA busy_timeout returns a single column that might have different naming
		const result = db1.query("PRAGMA busy_timeout").get();

		// The result should be a number or an object with a numeric property
		let timeoutValue: number;
		if (typeof result === "number") {
			timeoutValue = result;
		} else if (result && typeof result === "object") {
			// Try common column name variations
			const obj = result as Record<string, unknown>;
			timeoutValue = (obj.busy_timeout || obj.timeout || Object.values(obj)[0]) as number;
		} else {
			throw new Error("Unexpected busy_timeout result format");
		}

		expect(timeoutValue).toBe(5000);
	});
});
