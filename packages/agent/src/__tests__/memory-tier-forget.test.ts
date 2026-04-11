import Database from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { randomBytes } from "node:crypto";
import { applySchema, insertRow } from "@bound/core";
import type { CommandContext } from "@bound/sandbox";
import { BOUND_NAMESPACE, deterministicUUID } from "@bound/shared";
import { memory } from "../commands/memory";
import { upsertEdge } from "../graph-queries";

describe("memory forget tier transitions (AC2.1-AC2.2)", () => {
	let db: Database;
	let dbPath: string;

	beforeEach(() => {
		const testRunId = randomBytes(4).toString("hex");
		dbPath = `/tmp/test-memory-tier-forget-${testRunId}.db`;
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

	const createSummarizesEdge = (sourceKey: string, targetKey: string): string => {
		const ctx = createContext();
		return upsertEdge(db, sourceKey, targetKey, "summarizes", 1.0, ctx.siteId);
	};

	// AC2.1: Forgetting a summary entry promotes children from detail to default
	it("AC2.1: forget summary promotes children from detail to default", async () => {
		const ctx = createContext();

		// Create summary entry
		createMemory("summary_entry", "a summary", "summary");

		// Create two detail children
		createMemory("child1", "detail content 1", "detail");
		createMemory("child2", "detail content 2", "detail");

		// Create summarizes edges
		createSummarizesEdge("summary_entry", "child1");
		createSummarizesEdge("summary_entry", "child2");

		// Verify children start as detail
		let child1 = db.prepare("SELECT tier FROM semantic_memory WHERE key = ?").get("child1") as {
			tier: string;
		};
		expect(child1.tier).toBe("detail");

		let child2 = db.prepare("SELECT tier FROM semantic_memory WHERE key = ?").get("child2") as {
			tier: string;
		};
		expect(child2.tier).toBe("detail");

		// Forget the summary
		const result = await memory.handler(
			{
				subcommand: "forget",
				source: "summary_entry",
			},
			ctx,
		);

		expect(result.exitCode).toBe(0);

		// Verify children promoted to default
		child1 = db.prepare("SELECT tier FROM semantic_memory WHERE key = ?").get("child1") as {
			tier: string;
		};
		expect(child1.tier).toBe("default");

		child2 = db.prepare("SELECT tier FROM semantic_memory WHERE key = ?").get("child2") as {
			tier: string;
		};
		expect(child2.tier).toBe("default");
	});

	// AC2.2: Forgetting a summary entry tombstones all outgoing summarizes edges
	it("AC2.2: forget summary tombstones all outgoing summarizes edges", async () => {
		const ctx = createContext();

		// Create summary entry
		createMemory("summary_entry", "a summary", "summary");

		// Create two detail children
		createMemory("child1", "detail content 1", "detail");
		createMemory("child2", "detail content 2", "detail");

		// Create summarizes edges
		createSummarizesEdge("summary_entry", "child1");
		createSummarizesEdge("summary_entry", "child2");

		// Verify edges exist
		let edges = db
			.prepare(
				"SELECT COUNT(*) as cnt FROM memory_edges WHERE source_key = ? AND relation = 'summarizes' AND deleted = 0",
			)
			.get("summary_entry") as { cnt: number };
		expect(edges.cnt).toBe(2);

		// Forget the summary
		const result = await memory.handler(
			{
				subcommand: "forget",
				source: "summary_entry",
			},
			ctx,
		);

		expect(result.exitCode).toBe(0);

		// Verify all outgoing summarizes edges are tombstoned
		edges = db
			.prepare(
				"SELECT COUNT(*) as cnt FROM memory_edges WHERE source_key = ? AND relation = 'summarizes' AND deleted = 0",
			)
			.get("summary_entry") as { cnt: number };
		expect(edges.cnt).toBe(0);

		// Verify edges are soft-deleted (count all including deleted)
		const allEdges = db
			.prepare(
				"SELECT COUNT(*) as cnt FROM memory_edges WHERE source_key = ? AND relation = 'summarizes'",
			)
			.get("summary_entry") as { cnt: number };
		expect(allEdges.cnt).toBe(2);
	});

	// Additional: Forgetting a default entry should not promote anything
	it("forgetting default entry does not promote children", async () => {
		const ctx = createContext();

		// Create default entry (not a summary)
		createMemory("default_entry", "a default entry", "default");

		// Create two detail children (even though they wouldn't be summarized by default)
		createMemory("child1", "detail content 1", "detail");
		createMemory("child2", "detail content 2", "detail");

		// Create summarizes edges from children to default (unusual but allowed)
		createSummarizesEdge("child1", "default_entry");
		createSummarizesEdge("child2", "default_entry");

		// Forget the default entry
		const result = await memory.handler(
			{
				subcommand: "forget",
				source: "default_entry",
			},
			ctx,
		);

		expect(result.exitCode).toBe(0);

		// Verify children remain detail (not promoted because default is not a summary)
		const child1 = db.prepare("SELECT tier FROM semantic_memory WHERE key = ?").get("child1") as {
			tier: string;
		};
		expect(child1.tier).toBe("detail");

		const child2 = db.prepare("SELECT tier FROM semantic_memory WHERE key = ?").get("child2") as {
			tier: string;
		};
		expect(child2.tier).toBe("detail");
	});

	// Additional: Forgetting a summary entry with no children should still work
	it("forgetting summary with no children succeeds", async () => {
		const ctx = createContext();

		// Create summary entry with no children
		createMemory("summary_entry", "a summary with no children", "summary");

		// Forget the summary
		const result = await memory.handler(
			{
				subcommand: "forget",
				source: "summary_entry",
			},
			ctx,
		);

		expect(result.exitCode).toBe(0);

		// Verify the summary is soft-deleted
		const row = db
			.prepare("SELECT deleted FROM semantic_memory WHERE key = ?")
			.get("summary_entry") as { deleted: number };
		expect(row.deleted).toBe(1);
	});

	// Additional: Forgetting a summary with mixed-tier children (detail + pinned)
	it("AC2.1 partial: summary promotes detail children but not pinned", async () => {
		const ctx = createContext();

		// Create summary entry
		createMemory("summary_entry", "a summary", "summary");

		// Create detail child and pinned child
		createMemory("detail_child", "detail content", "detail");
		createMemory("pinned_child", "pinned content", "pinned");

		// Create summarizes edges
		createSummarizesEdge("summary_entry", "detail_child");
		createSummarizesEdge("summary_entry", "pinned_child");

		// Forget the summary
		const result = await memory.handler(
			{
				subcommand: "forget",
				source: "summary_entry",
			},
			ctx,
		);

		expect(result.exitCode).toBe(0);

		// Detail child should be promoted to default
		let child = db
			.prepare("SELECT tier FROM semantic_memory WHERE key = ?")
			.get("detail_child") as { tier: string };
		expect(child.tier).toBe("default");

		// Pinned child should remain pinned (not promoted)
		child = db.prepare("SELECT tier FROM semantic_memory WHERE key = ?").get("pinned_child") as {
			tier: string;
		};
		expect(child.tier).toBe("pinned");
	});
});
