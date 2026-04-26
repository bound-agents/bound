import type { Database } from "bun:sqlite";
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyMetricsSchema, applySchema, createDatabase } from "@bound/core";
import type { CommandContext } from "@bound/sandbox";
import { TypedEventEmitter } from "@bound/shared";
import { cleanupTmpDir } from "@bound/shared/test-utils";
import { query } from "../commands/query";

describe("query command — read-only PRAGMA support", () => {
	let tmpDir: string;
	let dbPath: string;
	let db: Database;
	let ctx: CommandContext;

	beforeAll(() => {
		tmpDir = mkdtempSync(join(tmpdir(), "query-pragma-test-"));
		dbPath = join(tmpDir, "test.db");

		db = createDatabase(dbPath);
		applySchema(db);
		applyMetricsSchema(db);

		ctx = {
			db,
			siteId: randomUUID(),
			eventBus: new TypedEventEmitter(),
			logger: {
				debug: () => {},
				info: () => {},
				warn: () => {},
				error: () => {},
			},
			threadId: randomUUID(),
			taskId: randomUUID(),
		};
	});

	afterAll(async () => {
		db.close();
		if (tmpDir) {
			await cleanupTmpDir(tmpDir);
		}
	});

	it("allows PRAGMA table_info(users) and returns column rows", async () => {
		const result = await query.handler({ query: "PRAGMA table_info(users)" }, ctx);
		expect(result.exitCode).toBe(0);
		// Every table produced by applySchema has at least an "id" column
		expect(result.stdout).toContain("id");
		expect(result.stderr).toBe("");
	});

	it("allows bare PRAGMA compile_options (no argument)", async () => {
		const result = await query.handler({ query: "PRAGMA compile_options" }, ctx);
		expect(result.exitCode).toBe(0);
		expect(result.stderr).toBe("");
	});

	it("allows bare PRAGMA journal_mode (returns current value, no mutation)", async () => {
		const result = await query.handler({ query: "PRAGMA journal_mode" }, ctx);
		expect(result.exitCode).toBe(0);
		// createDatabase sets WAL mode
		expect(result.stdout.toLowerCase()).toContain("wal");
	});

	it("rejects PRAGMA assignment form (PRAGMA x = y)", async () => {
		const result = await query.handler({ query: "PRAGMA journal_mode = DELETE" }, ctx);
		expect(result.exitCode).toBe(1);
		expect(result.stderr).toContain("PRAGMA");
		expect(result.stderr.toLowerCase()).toContain("assignment");
	});

	it("rejects PRAGMA writable_schema = 1 even though it's a PRAGMA", async () => {
		const result = await query.handler({ query: "PRAGMA writable_schema = 1" }, ctx);
		expect(result.exitCode).toBe(1);
	});

	it("rejects PRAGMA names not in the allowlist", async () => {
		const result = await query.handler({ query: "PRAGMA secure_delete" }, ctx);
		expect(result.exitCode).toBe(1);
		expect(result.stderr.toLowerCase()).toContain("allowlist");
	});

	it("still rejects INSERT / UPDATE / DELETE", async () => {
		const insertResult = await query.handler({ query: "INSERT INTO users (id) VALUES ('x')" }, ctx);
		expect(insertResult.exitCode).toBe(1);

		const updateResult = await query.handler({ query: "UPDATE users SET id = 'x'" }, ctx);
		expect(updateResult.exitCode).toBe(1);

		const deleteResult = await query.handler({ query: "DELETE FROM users" }, ctx);
		expect(deleteResult.exitCode).toBe(1);
	});

	it("still allows plain SELECT queries", async () => {
		const result = await query.handler({ query: "SELECT id FROM users LIMIT 1" }, ctx);
		expect(result.exitCode).toBe(0);
	});

	it("handles leading whitespace and mixed case in PRAGMA", async () => {
		const result = await query.handler({ query: "  pragma Table_Info(threads)  " }, ctx);
		expect(result.exitCode).toBe(0);
	});
});
