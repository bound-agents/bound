import Database from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { randomBytes } from "node:crypto";
import { applySchema, insertRow } from "@bound/core";
import type { CommandContext } from "@bound/sandbox";
import { BOUND_NAMESPACE, deterministicUUID } from "@bound/shared";
import { memory } from "../commands/memory";

describe("memory connect tier transitions (AC2.3-AC2.5, AC2.8)", () => {
	let db: Database;
	let dbPath: string;

	beforeEach(() => {
		const testRunId = randomBytes(4).toString("hex");
		dbPath = `/tmp/test-memory-tier-connect-${testRunId}.db`;
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

	const createMemory = (
		key: string,
		value: string,
		tier: "pinned" | "summary" | "default" | "detail" = "default",
	): string => {
		const ctx = createContext();
		const id = deterministicUUID(BOUND_NAMESPACE, key);
		const now = new Date().toISOString();
		insertRow(
			db,
			"semantic_memory",
			{
				id,
				key,
				value,
				source: "test",
				created_at: now,
				modified_at: now,
				last_accessed_at: now,
				deleted: 0,
				tier,
			},
			ctx.siteId,
		);
		return id;
	};

	// AC2.3: Connect A→B with summarizes, B is default → B becomes detail
	it("AC2.3: connect summarizes with default target demotes to detail", async () => {
		const ctx = createContext();

		// Create source summary
		createMemory("summary_A", "summary content", "summary");

		// Create target with default tier
		createMemory("target_B", "target content", "default");

		// Verify target starts as default
		let target = db.prepare("SELECT tier FROM semantic_memory WHERE key = ?").get("target_B") as {
			tier: string;
		};
		expect(target.tier).toBe("default");

		// Connect with summarizes relation
		const result = await memory.handler(
			{
				subcommand: "connect",
				source: "summary_A",
				target: "target_B",
				relation: "summarizes",
			},
			ctx,
		);

		expect(result.exitCode).toBe(0);

		// Verify target demoted to detail
		target = db.prepare("SELECT tier FROM semantic_memory WHERE key = ?").get("target_B") as {
			tier: string;
		};
		expect(target.tier).toBe("detail");
	});

	// AC2.4: Connect A→B with summarizes, B is pinned → B stays pinned
	it("AC2.4: connect summarizes with pinned target preserves pinned", async () => {
		const ctx = createContext();

		// Create source summary
		createMemory("summary_A", "summary content", "summary");

		// Create target with pinned tier
		createMemory("target_B", "target content", "pinned");

		// Verify target starts as pinned
		let target = db.prepare("SELECT tier FROM semantic_memory WHERE key = ?").get("target_B") as {
			tier: string;
		};
		expect(target.tier).toBe("pinned");

		// Connect with summarizes relation
		const result = await memory.handler(
			{
				subcommand: "connect",
				source: "summary_A",
				target: "target_B",
				relation: "summarizes",
			},
			ctx,
		);

		expect(result.exitCode).toBe(0);

		// Verify target remains pinned
		target = db.prepare("SELECT tier FROM semantic_memory WHERE key = ?").get("target_B") as {
			tier: string;
		};
		expect(target.tier).toBe("pinned");
	});

	// AC2.5: Connect A→B with summarizes, B is summary → B stays summary
	it("AC2.5: connect summarizes with summary target preserves summary", async () => {
		const ctx = createContext();

		// Create source summary
		createMemory("summary_A", "summary content", "summary");

		// Create target with summary tier
		createMemory("target_B", "target summary", "summary");

		// Verify target starts as summary
		let target = db.prepare("SELECT tier FROM semantic_memory WHERE key = ?").get("target_B") as {
			tier: string;
		};
		expect(target.tier).toBe("summary");

		// Connect with summarizes relation
		const result = await memory.handler(
			{
				subcommand: "connect",
				source: "summary_A",
				target: "target_B",
				relation: "summarizes",
			},
			ctx,
		);

		expect(result.exitCode).toBe(0);

		// Verify target remains summary
		target = db.prepare("SELECT tier FROM semantic_memory WHERE key = ?").get("target_B") as {
			tier: string;
		};
		expect(target.tier).toBe("summary");
	});

	// AC2.8: Connect A→B with related_to → B's tier unchanged
	it("AC2.8: connect with related_to relation does not change tier", async () => {
		const ctx = createContext();

		// Create source
		createMemory("source_A", "source content", "default");

		// Create target with default tier
		createMemory("target_B", "target content", "default");

		// Verify target starts as default
		let target = db.prepare("SELECT tier FROM semantic_memory WHERE key = ?").get("target_B") as {
			tier: string;
		};
		expect(target.tier).toBe("default");

		// Connect with related_to relation (not summarizes)
		const result = await memory.handler(
			{
				subcommand: "connect",
				source: "source_A",
				target: "target_B",
				relation: "related_to",
			},
			ctx,
		);

		expect(result.exitCode).toBe(0);

		// Verify target remains default (no tier change)
		target = db.prepare("SELECT tier FROM semantic_memory WHERE key = ?").get("target_B") as {
			tier: string;
		};
		expect(target.tier).toBe("default");
	});

	// Additional: Connect A→B with related_to, B is detail → B stays detail
	it("AC2.8 additional: related_to with detail target preserves detail", async () => {
		const ctx = createContext();

		// Create source
		createMemory("source_A", "source content", "summary");

		// Create target with detail tier
		createMemory("target_B", "target content", "detail");

		// Verify target starts as detail
		let target = db.prepare("SELECT tier FROM semantic_memory WHERE key = ?").get("target_B") as {
			tier: string;
		};
		expect(target.tier).toBe("detail");

		// Connect with related_to relation (not summarizes)
		const result = await memory.handler(
			{
				subcommand: "connect",
				source: "source_A",
				target: "target_B",
				relation: "related_to",
			},
			ctx,
		);

		expect(result.exitCode).toBe(0);

		// Verify target remains detail (no tier change)
		target = db.prepare("SELECT tier FROM semantic_memory WHERE key = ?").get("target_B") as {
			tier: string;
		};
		expect(target.tier).toBe("detail");
	});

	// Additional: Connect with summarizes, target already detail → stays detail
	it("connect summarizes with detail target leaves detail unchanged", async () => {
		const ctx = createContext();

		// Create source summary
		createMemory("summary_A", "summary content", "summary");

		// Create target with detail tier
		createMemory("target_B", "target content", "detail");

		// Verify target starts as detail
		let target = db.prepare("SELECT tier FROM semantic_memory WHERE key = ?").get("target_B") as {
			tier: string;
		};
		expect(target.tier).toBe("detail");

		// Connect with summarizes relation
		const result = await memory.handler(
			{
				subcommand: "connect",
				source: "summary_A",
				target: "target_B",
				relation: "summarizes",
			},
			ctx,
		);

		expect(result.exitCode).toBe(0);

		// Verify target remains detail
		target = db.prepare("SELECT tier FROM semantic_memory WHERE key = ?").get("target_B") as {
			tier: string;
		};
		expect(target.tier).toBe("detail");
	});
});
