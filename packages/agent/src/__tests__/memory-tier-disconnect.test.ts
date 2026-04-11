import Database from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { randomBytes } from "node:crypto";
import { applySchema, insertRow } from "@bound/core";
import type { CommandContext } from "@bound/sandbox";
import { BOUND_NAMESPACE, deterministicUUID } from "@bound/shared";
import { memory } from "../commands/memory";
import { upsertEdge } from "../graph-queries";

describe("memory disconnect tier transitions (AC2.6-AC2.7)", () => {
	let db: Database;
	let dbPath: string;

	beforeEach(() => {
		const testRunId = randomBytes(4).toString("hex");
		dbPath = `/tmp/test-memory-tier-disconnect-${testRunId}.db`;
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

	// AC2.6: A→B is the only parent. Disconnect → B promoted from detail to default
	it("AC2.6: disconnect only summarizes parent promotes target from detail to default", async () => {
		const ctx = createContext();

		// Create source summary
		createMemory("summary_A", "summary content", "summary");

		// Create target with detail tier
		createMemory("target_B", "target content", "detail");

		// Create the only summarizes edge
		createSummarizesEdge("summary_A", "target_B");

		// Verify target is detail
		let target = db.prepare("SELECT tier FROM semantic_memory WHERE key = ?").get("target_B") as {
			tier: string;
		};
		expect(target.tier).toBe("detail");

		// Verify edge exists
		let edges = db
			.prepare(
				"SELECT COUNT(*) as cnt FROM memory_edges WHERE target_key = ? AND relation = 'summarizes' AND deleted = 0",
			)
			.get("target_B") as { cnt: number };
		expect(edges.cnt).toBe(1);

		// Disconnect the edge
		const result = await memory.handler(
			{
				subcommand: "disconnect",
				source: "summary_A",
				target: "target_B",
				relation: "summarizes",
			},
			ctx,
		);

		expect(result.exitCode).toBe(0);

		// Verify target promoted to default
		target = db.prepare("SELECT tier FROM semantic_memory WHERE key = ?").get("target_B") as {
			tier: string;
		};
		expect(target.tier).toBe("default");

		// Verify edge is soft-deleted
		edges = db
			.prepare(
				"SELECT COUNT(*) as cnt FROM memory_edges WHERE target_key = ? AND relation = 'summarizes' AND deleted = 0",
			)
			.get("target_B") as { cnt: number };
		expect(edges.cnt).toBe(0);
	});

	// AC2.7: A→B and C→B are both summarizes. Disconnect A→B → B stays detail
	it("AC2.7: disconnect one of multiple summarizes parents keeps target as detail", async () => {
		const ctx = createContext();

		// Create two parent summaries
		createMemory("summary_A", "summary A content", "summary");
		createMemory("summary_C", "summary C content", "summary");

		// Create target with detail tier
		createMemory("target_B", "target content", "detail");

		// Create two summarizes edges
		createSummarizesEdge("summary_A", "target_B");
		createSummarizesEdge("summary_C", "target_B");

		// Verify target is detail
		let target = db.prepare("SELECT tier FROM semantic_memory WHERE key = ?").get("target_B") as {
			tier: string;
		};
		expect(target.tier).toBe("detail");

		// Verify two edges exist
		let edges = db
			.prepare(
				"SELECT COUNT(*) as cnt FROM memory_edges WHERE target_key = ? AND relation = 'summarizes' AND deleted = 0",
			)
			.get("target_B") as { cnt: number };
		expect(edges.cnt).toBe(2);

		// Disconnect A→B (one edge)
		const result = await memory.handler(
			{
				subcommand: "disconnect",
				source: "summary_A",
				target: "target_B",
				relation: "summarizes",
			},
			ctx,
		);

		expect(result.exitCode).toBe(0);

		// Verify target remains detail (not promoted because C→B still exists)
		target = db.prepare("SELECT tier FROM semantic_memory WHERE key = ?").get("target_B") as {
			tier: string;
		};
		expect(target.tier).toBe("detail");

		// Verify one edge remains
		edges = db
			.prepare(
				"SELECT COUNT(*) as cnt FROM memory_edges WHERE target_key = ? AND relation = 'summarizes' AND deleted = 0",
			)
			.get("target_B") as { cnt: number };
		expect(edges.cnt).toBe(1);
	});

	// Additional: Disconnect non-summarizes edge does not promote
	it("disconnect non-summarizes edge does not affect tier", async () => {
		const ctx = createContext();

		// Create source and target
		createMemory("source_A", "source content", "default");
		createMemory("target_B", "target content", "detail");

		// Create related_to edge (not summarizes)
		const _edgeId = upsertEdge(db, "source_A", "target_B", "related_to", 1.0, ctx.siteId);

		// Verify target is detail
		let target = db.prepare("SELECT tier FROM semantic_memory WHERE key = ?").get("target_B") as {
			tier: string;
		};
		expect(target.tier).toBe("detail");

		// Disconnect the non-summarizes edge
		const result = await memory.handler(
			{
				subcommand: "disconnect",
				source: "source_A",
				target: "target_B",
				relation: "related_to",
			},
			ctx,
		);

		expect(result.exitCode).toBe(0);

		// Verify target remains detail (no promotion)
		target = db.prepare("SELECT tier FROM semantic_memory WHERE key = ?").get("target_B") as {
			tier: string;
		};
		expect(target.tier).toBe("detail");
	});

	// Additional: Disconnect with undefined relation (all edges) when one is summarizes
	it("disconnect without relation (all edges) when summarizes exists promotes if no others remain", async () => {
		const ctx = createContext();

		// Create source and target
		createMemory("summary_A", "summary content", "summary");
		createMemory("target_B", "target content", "detail");

		// Create only a summarizes edge
		createSummarizesEdge("summary_A", "target_B");

		// Verify target is detail
		let target = db.prepare("SELECT tier FROM semantic_memory WHERE key = ?").get("target_B") as {
			tier: string;
		};
		expect(target.tier).toBe("detail");

		// Disconnect without specifying relation (removes all edges)
		const result = await memory.handler(
			{
				subcommand: "disconnect",
				source: "summary_A",
				target: "target_B",
				// relation is undefined
			},
			ctx,
		);

		expect(result.exitCode).toBe(0);

		// Verify target promoted to default
		target = db.prepare("SELECT tier FROM semantic_memory WHERE key = ?").get("target_B") as {
			tier: string;
		};
		expect(target.tier).toBe("default");
	});

	// Additional: Disconnect all edges when multiple types exist, including summarizes
	it("disconnect without relation removes all edges and checks for remaining summarizes", async () => {
		const ctx = createContext();

		// Create source and target
		createMemory("summary_A", "summary content", "summary");
		createMemory("target_B", "target content", "detail");

		// Create both a summarizes and a related_to edge
		createSummarizesEdge("summary_A", "target_B");
		upsertEdge(db, "summary_A", "target_B", "related_to", 1.0, ctx.siteId);

		// Verify target is detail
		let target = db.prepare("SELECT tier FROM semantic_memory WHERE key = ?").get("target_B") as {
			tier: string;
		};
		expect(target.tier).toBe("detail");

		// Verify two edges exist
		const edges = db
			.prepare(
				"SELECT COUNT(*) as cnt FROM memory_edges WHERE source_key = ? AND target_key = ? AND deleted = 0",
			)
			.all("summary_A", "target_B") as Array<{ cnt: number }>;
		expect(edges.reduce((sum, e) => sum + e.cnt, 0)).toBe(2);

		// Disconnect without specifying relation (removes ALL edges between these two)
		const result = await memory.handler(
			{
				subcommand: "disconnect",
				source: "summary_A",
				target: "target_B",
				// relation is undefined
			},
			ctx,
		);

		expect(result.exitCode).toBe(0);

		// Verify target promoted to default (since no summarizes remain)
		target = db.prepare("SELECT tier FROM semantic_memory WHERE key = ?").get("target_B") as {
			tier: string;
		};
		expect(target.tier).toBe("default");
	});

	// Additional: Target is already default, should not be affected
	it("disconnect summarizes edge when target is already default leaves it unchanged", async () => {
		const ctx = createContext();

		// Create source summary
		createMemory("summary_A", "summary content", "summary");

		// Create target with default tier
		createMemory("target_B", "target content", "default");

		// Create summarizes edge
		createSummarizesEdge("summary_A", "target_B");

		// Verify target is default
		let target = db.prepare("SELECT tier FROM semantic_memory WHERE key = ?").get("target_B") as {
			tier: string;
		};
		expect(target.tier).toBe("default");

		// Disconnect the edge
		const result = await memory.handler(
			{
				subcommand: "disconnect",
				source: "summary_A",
				target: "target_B",
				relation: "summarizes",
			},
			ctx,
		);

		expect(result.exitCode).toBe(0);

		// Verify target remains default
		target = db.prepare("SELECT tier FROM semantic_memory WHERE key = ?").get("target_B") as {
			tier: string;
		};
		expect(target.tier).toBe("default");
	});

	// Additional: Target is pinned, should not be demoted
	it("disconnect summarizes edge when target is pinned leaves it pinned", async () => {
		const ctx = createContext();

		// Create source summary
		createMemory("summary_A", "summary content", "summary");

		// Create target with pinned tier
		createMemory("target_B", "target content", "pinned");

		// Create summarizes edge
		createSummarizesEdge("summary_A", "target_B");

		// Verify target is pinned
		let target = db.prepare("SELECT tier FROM semantic_memory WHERE key = ?").get("target_B") as {
			tier: string;
		};
		expect(target.tier).toBe("pinned");

		// Disconnect the edge
		const result = await memory.handler(
			{
				subcommand: "disconnect",
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
});
