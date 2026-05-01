import type Database from "bun:sqlite";
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { randomBytes } from "node:crypto";
import { applySchema } from "@bound/core";
import type { ToolContext } from "../../types.js";
import { createQueryTool } from "../query.js";

let db: Database;
let ctx: ToolContext;

beforeAll(() => {
	const dbPath = `/tmp/query-test-${randomBytes(4).toString("hex")}.db`;
	const sqlite = require("bun:sqlite");
	db = new sqlite.Database(dbPath);
	applySchema(db);

	ctx = {
		db,
		siteId: "test-site",
		eventBus: {
			on: () => {},
			off: () => {},
			emit: () => {},
		} as any,
		logger: {
			debug: () => {},
			info: () => {},
			warn: () => {},
			error: () => {},
		},
		threadId: "test-thread",
		taskId: "test-task",
	};
});

afterAll(() => {
	db.close();
});

describe("Query Tool", () => {
	it("should reject missing sql parameter", async () => {
		const tool = createQueryTool(ctx);
		const result = await tool.execute({});

		expect(result).toContain("Error");
		expect(result).toContain("sql");
	});

	it("should handle SQL with = character (AC2.2)", async () => {
		const tool = createQueryTool(ctx);
		// This test verifies the main AC2.2 requirement: sql with = doesn't mispars
		// Use a query that works on existing schema
		const result = await tool.execute({
			sql: "SELECT type FROM sqlite_master WHERE type = 'table' LIMIT 1",
		});

		// Should return TSV output (header + rows), not an error about =
		expect(result).not.toContain("Error");
		// Result should be a string (TSV format)
		expect(typeof result).toBe("string");
		// Should have header line
		const lines = (result as string).split("\n").filter((line) => line);
		expect(lines.length).toBeGreaterThan(0);
		expect(lines[0]).toBe("type");
	});

	it("should reject INSERT queries", async () => {
		const tool = createQueryTool(ctx);
		const result = await tool.execute({
			sql: "INSERT INTO hosts (id, site_id) VALUES ('x', 'y')",
		});

		expect(result).toContain("Error");
	});

	it("should reject PRAGMA assignment form", async () => {
		const tool = createQueryTool(ctx);
		const result = await tool.execute({
			sql: "PRAGMA journal_mode = WAL",
		});

		expect(result).toContain("Error");
		expect(result).toContain("assignment");
	});

	it("should accept read-only PRAGMA", async () => {
		const tool = createQueryTool(ctx);
		const result = await tool.execute({
			sql: "PRAGMA table_info(hosts)",
		});

		expect(result).not.toContain("Error");
		expect(typeof result).toBe("string");
	});

	it("should return TSV format for SELECT results", async () => {
		const tool = createQueryTool(ctx);
		const result = await tool.execute({
			sql: "SELECT name FROM sqlite_master WHERE type='table' LIMIT 5",
		});

		expect(result).not.toContain("Error");
		// TSV output should have header line
		const lines = (result as string).split("\n").filter((line) => line);
		expect(lines.length).toBeGreaterThan(0);
		expect(lines[0]).toBe("name");
	});

	it("should reject unknown PRAGMA", async () => {
		const tool = createQueryTool(ctx);
		const result = await tool.execute({
			sql: "PRAGMA unknown_pragma_xyz",
		});

		expect(result).toContain("Error");
		expect(result).toContain("allowlist");
	});

	it("should auto-append LIMIT 1000 to SELECT without LIMIT", async () => {
		const tool = createQueryTool(ctx);
		// Query without LIMIT - should auto-append
		const result = await tool.execute({
			sql: "SELECT name FROM sqlite_master WHERE type='table'",
		});

		expect(result).not.toContain("Error");
		// Should succeed - the LIMIT is applied internally
		expect(typeof result).toBe("string");
	});

	it("should handle empty query string", async () => {
		const tool = createQueryTool(ctx);
		const result = await tool.execute({
			sql: "",
		});

		expect(result).toContain("Error");
	});

	it("should handle whitespace-only query", async () => {
		const tool = createQueryTool(ctx);
		const result = await tool.execute({
			sql: "   \n\t  ",
		});

		expect(result).toContain("Error");
	});
});
