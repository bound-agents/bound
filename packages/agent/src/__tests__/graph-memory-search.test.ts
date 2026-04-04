import type { Database } from "bun:sqlite";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applySchema, createDatabase } from "@bound/core";
import type { CommandContext } from "@bound/sandbox";
import { memory } from "../commands/memory";

describe("memory search command", () => {
	let tmpDir: string;
	let dbPath: string;
	let db: Database;
	let ctx: CommandContext;

	beforeAll(() => {
		tmpDir = mkdtempSync(join(tmpdir(), "graph-memory-search-test-"));
		dbPath = join(tmpDir, "test.db");

		db = createDatabase(dbPath);
		applySchema(db);

		ctx = {
			db,
			siteId: randomUUID(),
			taskId: randomUUID(),
			threadId: randomUUID(),
		} as unknown as CommandContext;
	});

	afterAll(() => {
		db.close();
		rmSync(tmpDir, { recursive: true, force: true });
	});

	beforeEach(() => {
		// Clear semantic_memory table before each test
		db.prepare("DELETE FROM semantic_memory").run();
	});

	it("should return entries matching keywords in key field", async () => {
		// Seed a memory with a specific key
		await memory.handler(
			{ subcommand: "store", source: "scheduler_v3", target: "task runner" },
			ctx,
		);

		// Search for the keyword that's in the key
		const result = await memory.handler({ subcommand: "search", source: "scheduler" }, ctx);

		expect(result.exitCode).toBe(0);
		expect(result.stdout).toContain("scheduler_v3");
		expect(result.stdout).toContain("Found 1 memories");
	});

	it("should return entries matching keywords in value field", async () => {
		// Seed a memory with a specific value
		await memory.handler(
			{ subcommand: "store", source: "timing_config", target: "interval math" },
			ctx,
		);

		// Search for the keyword that's in the value
		const result = await memory.handler({ subcommand: "search", source: "interval" }, ctx);

		expect(result.exitCode).toBe(0);
		expect(result.stdout).toContain("timing_config");
		expect(result.stdout).toContain("Found 1 memories");
	});

	it("should return union of matches with multiple keywords", async () => {
		// Seed multiple memories
		await memory.handler({ subcommand: "store", source: "key_one", target: "apple fruit" }, ctx);
		await memory.handler({ subcommand: "store", source: "key_two", target: "banana fruit" }, ctx);

		// Search with multiple keywords
		const result = await memory.handler({ subcommand: "search", source: "apple banana" }, ctx);

		expect(result.exitCode).toBe(0);
		expect(result.stdout).toContain("key_one");
		expect(result.stdout).toContain("key_two");
		expect(result.stdout).toContain("Found 2 memories");
	});

	it("should filter keywords shorter than 3 characters", async () => {
		// Seed a memory
		await memory.handler({ subcommand: "store", source: "test_key", target: "test value" }, ctx);

		// Search with only short keywords
		const result = await memory.handler({ subcommand: "search", source: "ab cd ef" }, ctx);

		expect(result.exitCode).toBe(0);
		expect(result.stdout).toContain("No searchable keywords found");
	});

	it("should filter stop words from query", async () => {
		// Search with only stop words
		const result = await memory.handler({ subcommand: "search", source: "the a an is are" }, ctx);

		expect(result.exitCode).toBe(0);
		expect(result.stdout).toContain("No searchable keywords found");
	});

	it("should return no memories message when nothing matches", async () => {
		// Seed a memory
		await memory.handler(
			{ subcommand: "store", source: "existing_key", target: "existing value" },
			ctx,
		);

		// Search for something that doesn't exist
		const result = await memory.handler(
			{ subcommand: "search", source: "nonexistent_keyword_xyz_abc_def" },
			ctx,
		);

		expect(result.exitCode).toBe(0);
		expect(result.stdout).toContain("No memories matched");
	});

	it("should order results by modified_at DESC", async () => {
		// Seed memories with slight delays to ensure different timestamps
		await memory.handler(
			{ subcommand: "store", source: "first_item", target: "search_keyword" },
			ctx,
		);

		// Wait a small amount of time
		await new Promise((resolve) => setTimeout(resolve, 10));

		await memory.handler(
			{ subcommand: "store", source: "second_item", target: "search_keyword" },
			ctx,
		);

		const result = await memory.handler({ subcommand: "search", source: "search_keyword" }, ctx);

		expect(result.exitCode).toBe(0);
		// The output should have second_item before first_item (reverse chronological)
		const secondIdx = result.stdout.indexOf("second_item");
		const firstIdx = result.stdout.indexOf("first_item");
		expect(secondIdx).toBeLessThan(firstIdx);
	});

	it("should cap results at 20 entries", async () => {
		// Seed more than 20 memories
		for (let i = 0; i < 25; i++) {
			await memory.handler(
				{
					subcommand: "store",
					source: `key_${i.toString().padStart(2, "0")}`,
					target: "search_target",
				},
				ctx,
			);
		}

		const result = await memory.handler({ subcommand: "search", source: "search_target" }, ctx);

		expect(result.exitCode).toBe(0);
		expect(result.stdout).toContain("Found 20 memories");
	});

	it("should exclude soft-deleted entries", async () => {
		// Create a memory
		await memory.handler(
			{ subcommand: "store", source: "soft_deleted_key", target: "search_term" },
			ctx,
		);

		// Soft-delete it
		await memory.handler({ subcommand: "forget", source: "soft_deleted_key" }, ctx);

		// Search for it
		const result = await memory.handler({ subcommand: "search", source: "search_term" }, ctx);

		expect(result.exitCode).toBe(0);
		expect(result.stdout).toContain("No memories matched");
	});

	it("should truncate long values in results", async () => {
		const longValue = "a".repeat(150);

		await memory.handler(
			{
				subcommand: "store",
				source: "long_value_key",
				target: longValue,
			},
			ctx,
		);

		const result = await memory.handler({ subcommand: "search", source: "long_value_key" }, ctx);

		expect(result.exitCode).toBe(0);
		// Result should truncate at 100 chars and add "..."
		expect(result.stdout).toContain("...");
		expect(result.stdout).not.toContain(longValue);
	});

	it("should include source tag in results", async () => {
		await memory.handler(
			{
				subcommand: "store",
				source: "sourced_key",
				target: "value",
				source_tag: "custom_source",
			},
			ctx,
		);

		const result = await memory.handler({ subcommand: "search", source: "sourced_key" }, ctx);

		expect(result.exitCode).toBe(0);
		expect(result.stdout).toContain("custom_source");
	});

	it("should handle case-insensitive search", async () => {
		await memory.handler(
			{
				subcommand: "store",
				source: "CaseTestKey",
				target: "CaseTestValue",
			},
			ctx,
		);

		// Search with different case
		const result = await memory.handler({ subcommand: "search", source: "casetestkey" }, ctx);

		expect(result.exitCode).toBe(0);
		expect(result.stdout).toContain("CaseTestKey");
	});
});
