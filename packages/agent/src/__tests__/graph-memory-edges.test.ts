import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { randomUUID } from "node:crypto";
import { randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applySchema, createDatabase, insertRow } from "@bound/core";
import type { CommandContext } from "@bound/sandbox";
import { BOUND_NAMESPACE, TypedEventEmitter, deterministicUUID } from "@bound/shared";
import { memory } from "../commands/memory";
import { edgeId, removeEdges, upsertEdge } from "../graph-queries";

describe("Graph Memory Edges - CRUD Operations", () => {
	let dbPath: string;
	let db: Database;
	let ctx: CommandContext;
	const siteId = "test-site-123";

	beforeEach(() => {
		dbPath = join(tmpdir(), `graph-memory-test-${randomBytes(4).toString("hex")}.db`);
		db = createDatabase(dbPath);
		applySchema(db);

		const eventBus = new TypedEventEmitter();

		ctx = {
			db,
			siteId,
			eventBus,
			logger: {
				debug: () => {},
				info: () => {},
				warn: () => {},
				error: () => {},
			},
			threadId: randomUUID(),
			taskId: randomUUID(),
		};

		// Seed two semantic_memory entries for testing
		const sourceKey = "scheduler_v3";
		const targetKey = "cron_rescheduling";
		const now = new Date().toISOString();

		insertRow(
			db,
			"semantic_memory",
			{
				id: deterministicUUID(BOUND_NAMESPACE, sourceKey),
				key: sourceKey,
				value: "Scheduler component v3",
				source: ctx.taskId || "test",
				created_at: now,
				modified_at: now,
				deleted: 0,
			},
			siteId,
		);

		insertRow(
			db,
			"semantic_memory",
			{
				id: deterministicUUID(BOUND_NAMESPACE, targetKey),
				key: targetKey,
				value: "Cron rescheduling logic",
				source: ctx.taskId || "test",
				created_at: now,
				modified_at: now,
				deleted: 0,
			},
			siteId,
		);
	});

	afterEach(() => {
		try {
			db.close();
		} catch {
			// ignore
		}
		try {
			require("node:fs").unlinkSync(dbPath);
		} catch {
			// ignore
		}
	});

	describe("AC1.1: Deterministic edge ID and creation", () => {
		it("should create edge with correct deterministic UUID", () => {
			const sourceKey = "scheduler_v3";
			const targetKey = "cron_rescheduling";
			const relation = "related_to";

			const edgeIdResult = edgeId(sourceKey, targetKey, relation);
			const expectedId = deterministicUUID(
				BOUND_NAMESPACE,
				`${sourceKey}|${targetKey}|${relation}`,
			);

			expect(edgeIdResult).toBe(expectedId);

			// Create edge
			const returnedId = upsertEdge(db, sourceKey, targetKey, relation, 1.0, siteId);
			expect(returnedId).toBe(expectedId);

			// Verify edge row in database
			const edge = db
				.prepare(
					"SELECT id, source_key, target_key, relation, weight, created_at, modified_at, deleted FROM memory_edges WHERE id = ?",
				)
				.get(edgeIdResult) as Record<string, unknown>;

			expect(edge).toBeDefined();
			expect(edge.source_key).toBe(sourceKey);
			expect(edge.target_key).toBe(targetKey);
			expect(edge.relation).toBe(relation);
			expect(edge.weight).toBe(1.0);
			expect(edge.deleted).toBe(0);
			expect(edge.created_at).toBeDefined();
			expect(edge.modified_at).toBeDefined();
			expect(typeof edge.created_at).toBe("string");
			expect(typeof edge.modified_at).toBe("string");
		});
	});

	describe("AC1.2: Non-default weight", () => {
		it("should set non-default weight when specified", () => {
			const sourceKey = "scheduler_v3";
			const targetKey = "cron_rescheduling";
			const relation = "informs";
			const customWeight = 0.5;

			const edgeIdResult = upsertEdge(db, sourceKey, targetKey, relation, customWeight, siteId);

			const edge = db.prepare("SELECT weight FROM memory_edges WHERE id = ?").get(edgeIdResult) as {
				weight: number;
			};

			expect(edge.weight).toBe(customWeight);
		});

		it("should handle weight via command handler", async () => {
			const result = await memory.handler(
				{
					subcommand: "connect",
					source: "scheduler_v3",
					target: "cron_rescheduling",
					relation: "informs",
					weight: "0.75",
				},
				ctx,
			);

			expect(result.exitCode).toBe(0);

			const edge = db
				.prepare(
					"SELECT weight FROM memory_edges WHERE source_key = ? AND target_key = ? AND relation = ?",
				)
				.get("scheduler_v3", "cron_rescheduling", "informs") as { weight: number };

			expect(edge.weight).toBe(0.75);
		});
	});

	describe("AC1.3: Reconnecting existing edge updates weight and modified_at", () => {
		it("should update weight and modified_at on reconnection", () => {
			const sourceKey = "scheduler_v3";
			const targetKey = "cron_rescheduling";
			const relation = "related_to";

			// Create initial edge
			const edgeIdResult = upsertEdge(db, sourceKey, targetKey, relation, 1.0, siteId);

			const edge1 = db
				.prepare("SELECT weight, modified_at FROM memory_edges WHERE id = ?")
				.get(edgeIdResult) as { weight: number; modified_at: string };

			expect(edge1.weight).toBe(1.0);
			const modifiedAt1 = edge1.modified_at;

			// Brief delay to ensure different timestamp
			const start = Date.now();
			while (Date.now() - start < 2) {
				// Busy wait 2ms
			}

			// Update same edge with different weight
			upsertEdge(db, sourceKey, targetKey, relation, 2.0, siteId);

			const edge2 = db
				.prepare("SELECT id, weight, modified_at FROM memory_edges WHERE id = ?")
				.get(edgeIdResult) as { id: string; weight: number; modified_at: string };

			// Verify same ID (no duplicate row)
			expect(edge2.id).toBe(edgeIdResult);

			// Verify weight updated
			expect(edge2.weight).toBe(2.0);

			// Verify modified_at changed
			expect(edge2.modified_at).not.toBe(modifiedAt1);
			expect(new Date(edge2.modified_at).getTime()).toBeGreaterThan(
				new Date(modifiedAt1).getTime(),
			);
		});
	});

	describe("AC1.4: Soft-delete specific edge by relation", () => {
		it("should soft-delete specific edge when relation is provided", () => {
			const sourceKey = "scheduler_v3";
			const targetKey = "cron_rescheduling";

			// Create two edges with different relations
			upsertEdge(db, sourceKey, targetKey, "related_to", 1.0, siteId);
			upsertEdge(db, sourceKey, targetKey, "informs", 1.0, siteId);

			// Verify both edges exist
			const edges1 = db
				.prepare(
					"SELECT id, relation, deleted FROM memory_edges WHERE source_key = ? AND target_key = ?",
				)
				.all(sourceKey, targetKey) as Array<{
				id: string;
				relation: string;
				deleted: number;
			}>;

			expect(edges1).toHaveLength(2);
			expect(edges1.every((e) => e.deleted === 0)).toBe(true);

			// Delete specific relation
			const count = removeEdges(db, sourceKey, targetKey, "related_to", siteId);
			expect(count).toBe(1);

			// Verify specific edge is soft-deleted
			const deletedEdge = db
				.prepare(
					"SELECT deleted FROM memory_edges WHERE relation = ? AND source_key = ? AND target_key = ?",
				)
				.get("related_to", sourceKey, targetKey) as { deleted: number };

			expect(deletedEdge.deleted).toBe(1);

			// Verify other edge is not deleted
			const activeEdge = db
				.prepare(
					"SELECT deleted FROM memory_edges WHERE relation = ? AND source_key = ? AND target_key = ?",
				)
				.get("informs", sourceKey, targetKey) as { deleted: number };

			expect(activeEdge.deleted).toBe(0);
		});

		it("should return error via command handler when edge not found", async () => {
			const result = await memory.handler(
				{
					subcommand: "disconnect",
					source: "scheduler_v3",
					target: "cron_rescheduling",
					relation: "nonexistent_relation",
				},
				ctx,
			);

			expect(result.exitCode).toBe(1);
			expect(result.stderr).toContain("no edges found");
		});
	});

	describe("AC1.5: Soft-delete all edges between keys (no relation filter)", () => {
		it("should soft-delete all edges between two keys when relation is omitted", () => {
			const sourceKey = "scheduler_v3";
			const targetKey = "cron_rescheduling";

			// Create three edges with different relations
			upsertEdge(db, sourceKey, targetKey, "related_to", 1.0, siteId);
			upsertEdge(db, sourceKey, targetKey, "informs", 1.0, siteId);
			upsertEdge(db, sourceKey, targetKey, "supports", 1.0, siteId);

			// Verify all edges exist and are active
			const edges1 = db
				.prepare(
					"SELECT id, deleted FROM memory_edges WHERE source_key = ? AND target_key = ? AND deleted = 0",
				)
				.all(sourceKey, targetKey) as Array<{ id: string; deleted: number }>;

			expect(edges1).toHaveLength(3);

			// Delete all edges (no relation parameter)
			const count = removeEdges(db, sourceKey, targetKey, undefined, siteId);
			expect(count).toBe(3);

			// Verify all edges are soft-deleted
			const deletedEdges = db
				.prepare(
					"SELECT id, deleted FROM memory_edges WHERE source_key = ? AND target_key = ? AND deleted = 0",
				)
				.all(sourceKey, targetKey) as Array<{ id: string; deleted: number }>;

			expect(deletedEdges).toHaveLength(0);

			// Verify they're marked as deleted, not physically removed
			const allEdges = db
				.prepare("SELECT id, deleted FROM memory_edges WHERE source_key = ? AND target_key = ?")
				.all(sourceKey, targetKey) as Array<{ id: string; deleted: number }>;

			expect(allEdges).toHaveLength(3);
			expect(allEdges.every((e) => e.deleted === 1)).toBe(true);
		});

		it("should disconnect via command handler", async () => {
			// Create multiple edges
			await memory.handler(
				{
					subcommand: "connect",
					source: "scheduler_v3",
					target: "cron_rescheduling",
					relation: "related_to",
				},
				ctx,
			);

			await memory.handler(
				{
					subcommand: "connect",
					source: "scheduler_v3",
					target: "cron_rescheduling",
					relation: "informs",
				},
				ctx,
			);

			// Disconnect without specifying relation
			const result = await memory.handler(
				{
					subcommand: "disconnect",
					source: "scheduler_v3",
					target: "cron_rescheduling",
				},
				ctx,
			);

			expect(result.exitCode).toBe(0);
			expect(result.stdout).toContain("Removed 2 edge(s)");
		});
	});

	describe("AC1.6: Error handling for nonexistent keys", () => {
		it("should return error when source key does not exist", async () => {
			const result = await memory.handler(
				{
					subcommand: "connect",
					source: "nonexistent_source",
					target: "cron_rescheduling",
					relation: "related_to",
				},
				ctx,
			);

			expect(result.exitCode).toBe(1);
			expect(result.stderr).toContain("source memory not found");
		});

		it("should return error when target key does not exist", async () => {
			const result = await memory.handler(
				{
					subcommand: "connect",
					source: "scheduler_v3",
					target: "nonexistent_target",
					relation: "related_to",
				},
				ctx,
			);

			expect(result.exitCode).toBe(1);
			expect(result.stderr).toContain("target memory not found");
		});

		it("should validate input via graph-queries layer", () => {
			// Note: graph-queries functions don't validate key existence,
			// but command handlers do. This test verifies the separation.
			const sourceKey = "nonexistent_key1";
			const targetKey = "nonexistent_key2";

			// Graph-queries functions should not throw on missing keys
			const id = edgeId(sourceKey, targetKey, "related_to");
			expect(id).toBeDefined();

			// upsertEdge should create the edge regardless
			// (validation is at command handler level)
			const returnedId = upsertEdge(db, sourceKey, targetKey, "related_to", 1.0, siteId);
			expect(returnedId).toBe(id);

			// Verify edge was created even with nonexistent keys
			const edge = db.prepare("SELECT id FROM memory_edges WHERE id = ?").get(id) as {
				id: string;
			} | null;

			expect(edge).toBeDefined();
		});
	});

	describe("AC1.7: Soft-deleted edge restoration", () => {
		it("should restore soft-deleted edge by reconnecting same triple", () => {
			const sourceKey = "scheduler_v3";
			const targetKey = "cron_rescheduling";
			const relation = "related_to";

			// Create edge
			const edgeIdResult = upsertEdge(db, sourceKey, targetKey, relation, 1.0, siteId);

			// Verify it's active
			let edge = db.prepare("SELECT deleted FROM memory_edges WHERE id = ?").get(edgeIdResult) as {
				deleted: number;
			};

			expect(edge.deleted).toBe(0);

			// Soft-delete it
			removeEdges(db, sourceKey, targetKey, relation, siteId);

			// Verify it's deleted
			edge = db.prepare("SELECT deleted FROM memory_edges WHERE id = ?").get(edgeIdResult) as {
				deleted: number;
			};

			expect(edge.deleted).toBe(1);

			// Restore by reconnecting with new weight
			const newWeight = 2.5;
			upsertEdge(db, sourceKey, targetKey, relation, newWeight, siteId);

			// Verify it's restored
			edge = db
				.prepare("SELECT deleted, weight FROM memory_edges WHERE id = ?")
				.get(edgeIdResult) as { deleted: number; weight: number };

			expect(edge.deleted).toBe(0);
			expect(edge.weight).toBe(newWeight);
		});
	});

	describe("AC1.8: Change-log entries for sync", () => {
		it("should generate change-log entry on edge creation", () => {
			const sourceKey = "scheduler_v3";
			const targetKey = "cron_rescheduling";
			const relation = "related_to";

			const edgeIdResult = upsertEdge(db, sourceKey, targetKey, relation, 1.0, siteId);

			// Query changelog
			const logEntry = db
				.prepare(
					"SELECT table_name, row_id, site_id, row_data FROM change_log WHERE table_name = ? AND row_id = ?",
				)
				.get("memory_edges", edgeIdResult) as Record<string, unknown> | null;

			expect(logEntry).toBeDefined();
			expect(logEntry?.table_name).toBe("memory_edges");
			expect(logEntry?.row_id).toBe(edgeIdResult);
			expect(logEntry?.site_id).toBe(siteId);

			// Parse and verify row_data JSON
			const rowData = JSON.parse(logEntry?.row_data as string) as Record<string, unknown>;
			expect(rowData.id).toBe(edgeIdResult);
			expect(rowData.source_key).toBe(sourceKey);
			expect(rowData.target_key).toBe(targetKey);
			expect(rowData.relation).toBe(relation);
			expect(rowData.weight).toBe(1.0);
			expect(rowData.deleted).toBe(0);
		});

		it("should generate change-log entry on edge update", () => {
			const sourceKey = "scheduler_v3";
			const targetKey = "cron_rescheduling";
			const relation = "related_to";

			const edgeIdResult = upsertEdge(db, sourceKey, targetKey, relation, 1.0, siteId);

			// Clear changelog to track only the update
			db.run("DELETE FROM change_log WHERE table_name = ? AND row_id = ?", [
				"memory_edges",
				edgeIdResult,
			]);

			// Update the edge
			upsertEdge(db, sourceKey, targetKey, relation, 2.5, siteId);

			// Query changelog for the update
			const logEntry = db
				.prepare(
					"SELECT table_name, row_id, row_data FROM change_log WHERE table_name = ? AND row_id = ? ORDER BY timestamp DESC LIMIT 1",
				)
				.get("memory_edges", edgeIdResult) as Record<string, unknown> | null;

			expect(logEntry).toBeDefined();
			expect(logEntry?.table_name).toBe("memory_edges");

			// Verify updated weight in row_data
			const rowData = JSON.parse(logEntry?.row_data as string) as Record<string, unknown>;
			expect(rowData.weight).toBe(2.5);
			expect(rowData.deleted).toBe(0);
		});

		it("should generate change-log entry on edge soft-delete", () => {
			const sourceKey = "scheduler_v3";
			const targetKey = "cron_rescheduling";
			const relation = "related_to";

			const edgeIdResult = upsertEdge(db, sourceKey, targetKey, relation, 1.0, siteId);

			// Clear changelog
			db.run("DELETE FROM change_log WHERE table_name = ? AND row_id = ?", [
				"memory_edges",
				edgeIdResult,
			]);

			// Soft-delete the edge
			removeEdges(db, sourceKey, targetKey, relation, siteId);

			// Query changelog for the delete
			const logEntry = db
				.prepare(
					"SELECT table_name, row_id, row_data FROM change_log WHERE table_name = ? AND row_id = ? ORDER BY timestamp DESC LIMIT 1",
				)
				.get("memory_edges", edgeIdResult) as Record<string, unknown> | null;

			expect(logEntry).toBeDefined();

			// Verify deleted flag in row_data
			const rowData = JSON.parse(logEntry?.row_data as string) as Record<string, unknown>;
			expect(rowData.deleted).toBe(1);
		});
	});

	describe("Edge queries and indexes", () => {
		it("should use idx_edges_triple index for unique constraint", () => {
			const sourceKey = "scheduler_v3";
			const targetKey = "cron_rescheduling";
			const relation = "related_to";

			upsertEdge(db, sourceKey, targetKey, relation, 1.0, siteId);

			// Attempt to create a second active edge with same triple
			// (should fail due to unique index)
			const fn = () => {
				db.run(
					`INSERT INTO memory_edges (id, source_key, target_key, relation, weight, created_at, modified_at, deleted)
					 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
					[
						deterministicUUID(BOUND_NAMESPACE, `${sourceKey}|${targetKey}|${relation}-2`),
						sourceKey,
						targetKey,
						relation,
						2.0,
						new Date().toISOString(),
						new Date().toISOString(),
						0,
					],
				);
			};

			expect(fn).toThrow();
		});

		it("should allow multiple edges with same source but different targets", () => {
			const sourceKey = "scheduler_v3";
			const target1 = "cron_rescheduling";
			const target2 = "another_key";
			const now = new Date().toISOString();

			// Create second target memory entry
			insertRow(
				db,
				"semantic_memory",
				{
					id: deterministicUUID(BOUND_NAMESPACE, target2),
					key: target2,
					value: "Another memory entry",
					source: "test",
					created_at: now,
					modified_at: now,
					deleted: 0,
				},
				siteId,
			);

			upsertEdge(db, sourceKey, target1, "related_to", 1.0, siteId);
			upsertEdge(db, sourceKey, target2, "related_to", 1.0, siteId);

			const edges = db
				.prepare(
					"SELECT source_key, target_key FROM memory_edges WHERE source_key = ? AND deleted = 0",
				)
				.all(sourceKey) as Array<{ source_key: string; target_key: string }>;

			expect(edges).toHaveLength(2);
			expect(edges.map((e) => e.target_key).sort()).toEqual([target1, target2].sort());
		});

		it("should use idx_edges_source for efficient source lookups", () => {
			const sourceKey = "scheduler_v3";
			const targetKey = "cron_rescheduling";

			upsertEdge(db, sourceKey, targetKey, "related_to", 1.0, siteId);
			upsertEdge(db, sourceKey, targetKey, "informs", 1.0, siteId);

			// Lookup by source should be efficient
			const edges = db
				.prepare("SELECT id FROM memory_edges WHERE source_key = ? AND deleted = 0")
				.all(sourceKey) as Array<{ id: string }>;

			expect(edges).toHaveLength(2);
		});

		it("should use idx_edges_target for efficient target lookups", () => {
			const sourceKey = "scheduler_v3";
			const targetKey = "cron_rescheduling";

			upsertEdge(db, sourceKey, targetKey, "related_to", 1.0, siteId);

			// Lookup by target should be efficient
			const edges = db
				.prepare("SELECT id FROM memory_edges WHERE target_key = ? AND deleted = 0")
				.all(targetKey) as Array<{ id: string }>;

			expect(edges).toHaveLength(1);
		});
	});

	describe("Command handler integration", () => {
		it("should execute connect subcommand successfully", async () => {
			const result = await memory.handler(
				{
					subcommand: "connect",
					source: "scheduler_v3",
					target: "cron_rescheduling",
					relation: "related_to",
				},
				ctx,
			);

			expect(result.exitCode).toBe(0);
			expect(result.stdout).toContain("Edge created");
			expect(result.stdout).toContain("scheduler_v3");
			expect(result.stdout).toContain("cron_rescheduling");
		});

		it("should execute disconnect subcommand successfully", async () => {
			// Create edge first
			await memory.handler(
				{
					subcommand: "connect",
					source: "scheduler_v3",
					target: "cron_rescheduling",
					relation: "related_to",
				},
				ctx,
			);

			// Disconnect
			const result = await memory.handler(
				{
					subcommand: "disconnect",
					source: "scheduler_v3",
					target: "cron_rescheduling",
					relation: "related_to",
				},
				ctx,
			);

			expect(result.exitCode).toBe(0);
			expect(result.stdout).toContain("Removed 1 edge(s)");
		});

		it("should reject invalid subcommand", async () => {
			const result = await memory.handler(
				{
					subcommand: "invalid",
				},
				ctx,
			);

			expect(result.exitCode).toBe(1);
			expect(result.stderr).toContain("unknown subcommand");
		});

		it("should reject invalid weight range", async () => {
			const result = await memory.handler(
				{
					subcommand: "connect",
					source: "scheduler_v3",
					target: "cron_rescheduling",
					relation: "related_to",
					weight: "15",
				},
				ctx,
			);

			expect(result.exitCode).toBe(1);
			expect(result.stderr).toContain("weight must be a number between 0 and 10");
		});

		it("should reject non-numeric weight", async () => {
			const result = await memory.handler(
				{
					subcommand: "connect",
					source: "scheduler_v3",
					target: "cron_rescheduling",
					relation: "related_to",
					weight: "invalid",
				},
				ctx,
			);

			expect(result.exitCode).toBe(1);
			expect(result.stderr).toContain("weight must be a number between 0 and 10");
		});
	});
});
