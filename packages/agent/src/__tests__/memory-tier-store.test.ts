import Database from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { randomBytes } from "node:crypto";
import { applySchema } from "@bound/core";
import type { CommandContext } from "@bound/sandbox";
import { memory } from "../commands/memory";

describe("memory store --tier (AC1.1-AC1.6)", () => {
	let db: Database;
	let dbPath: string;

	beforeEach(() => {
		const testRunId = randomBytes(4).toString("hex");
		dbPath = `/tmp/test-memory-tier-store-${testRunId}.db`;
		db = new Database(dbPath);
		applySchema(db);
	});

	afterEach(() => {
		db.close();
		try {
			Bun.file(dbPath).delete();
		} catch {
			// ignore
		}
	});

	const createContext = (): CommandContext => ({
		db,
		taskId: "task-123",
		threadId: "thread-123",
		siteId: "site-local",
		userId: "user-123",
	});

	// AC1.1: Store with --tier summary creates entry with tier='summary'
	it("AC1.1: --tier summary creates entry with tier='summary'", async () => {
		const ctx = createContext();
		const result = await memory.handler(
			{
				subcommand: "store",
				source: "test_key",
				target: "test_value",
				tier: "summary",
			},
			ctx,
		);

		expect(result.exitCode).toBe(0);
		const row = db.prepare("SELECT tier FROM semantic_memory WHERE key = ?").get("test_key") as {
			tier: string;
		};
		expect(row.tier).toBe("summary");
	});

	// AC1.2: Store without --tier creates entry with tier='default'
	it("AC1.2: no --tier creates entry with tier='default'", async () => {
		const ctx = createContext();
		const result = await memory.handler(
			{
				subcommand: "store",
				source: "test_key",
				target: "test_value",
			},
			ctx,
		);

		expect(result.exitCode).toBe(0);
		const row = db.prepare("SELECT tier FROM semantic_memory WHERE key = ?").get("test_key") as {
			tier: string;
		};
		expect(row.tier).toBe("default");
	});

	// AC1.3: Store with _standing:x key sets tier='pinned' regardless of --tier
	it("AC1.3: _standing: prefix sets tier='pinned' (no --tier flag)", async () => {
		const ctx = createContext();
		const result = await memory.handler(
			{
				subcommand: "store",
				source: "_standing:workflow",
				target: "test_value",
			},
			ctx,
		);

		expect(result.exitCode).toBe(0);
		const row = db
			.prepare("SELECT tier FROM semantic_memory WHERE key = ?")
			.get("_standing:workflow") as { tier: string };
		expect(row.tier).toBe("pinned");
	});

	// AC1.4: Store with _feedback:x key and --tier default overrides to tier='pinned'
	it("AC1.4: _feedback: prefix overrides --tier default to tier='pinned'", async () => {
		const ctx = createContext();
		const result = await memory.handler(
			{
				subcommand: "store",
				source: "_feedback:negative",
				target: "test_value",
				tier: "default",
			},
			ctx,
		);

		expect(result.exitCode).toBe(0);
		const row = db
			.prepare("SELECT tier FROM semantic_memory WHERE key = ?")
			.get("_feedback:negative") as { tier: string };
		expect(row.tier).toBe("pinned");
	});

	// AC1.5: Updating existing detail entry without --tier preserves detail tier
	it("AC1.5: update without --tier preserves tier (detail)", async () => {
		const ctx = createContext();

		// Create initial entry with detail tier
		await memory.handler(
			{
				subcommand: "store",
				source: "test_key",
				target: "initial_value",
				tier: "detail",
			},
			ctx,
		);

		// Update without --tier
		const result = await memory.handler(
			{
				subcommand: "store",
				source: "test_key",
				target: "updated_value",
			},
			ctx,
		);

		expect(result.exitCode).toBe(0);
		const row = db.prepare("SELECT tier FROM semantic_memory WHERE key = ?").get("test_key") as {
			tier: string;
		};
		expect(row.tier).toBe("detail");
	});

	// AC1.6: Updating existing detail entry with --tier default overrides to default
	it("AC1.6: update with --tier default overrides to default", async () => {
		const ctx = createContext();

		// Create initial entry with detail tier
		await memory.handler(
			{
				subcommand: "store",
				source: "test_key",
				target: "initial_value",
				tier: "detail",
			},
			ctx,
		);

		// Update with --tier default
		const result = await memory.handler(
			{
				subcommand: "store",
				source: "test_key",
				target: "updated_value",
				tier: "default",
			},
			ctx,
		);

		expect(result.exitCode).toBe(0);
		const row = db.prepare("SELECT tier FROM semantic_memory WHERE key = ?").get("test_key") as {
			tier: string;
		};
		expect(row.tier).toBe("default");
	});

	// Additional: all pinned prefixes should work
	it("_policy: prefix sets tier='pinned'", async () => {
		const ctx = createContext();
		const result = await memory.handler(
			{
				subcommand: "store",
				source: "_policy:safety",
				target: "test_value",
				tier: "summary",
			},
			ctx,
		);

		expect(result.exitCode).toBe(0);
		const row = db
			.prepare("SELECT tier FROM semantic_memory WHERE key = ?")
			.get("_policy:safety") as { tier: string };
		expect(row.tier).toBe("pinned");
	});

	it("_pinned: prefix sets tier='pinned'", async () => {
		const ctx = createContext();
		const result = await memory.handler(
			{
				subcommand: "store",
				source: "_pinned:important",
				target: "test_value",
				tier: "detail",
			},
			ctx,
		);

		expect(result.exitCode).toBe(0);
		const row = db
			.prepare("SELECT tier FROM semantic_memory WHERE key = ?")
			.get("_pinned:important") as { tier: string };
		expect(row.tier).toBe("pinned");
	});
});
