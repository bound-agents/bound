import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { randomUUID } from "node:crypto";
import { randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applySchema, createDatabase, insertRow, softDelete } from "@bound/core";
import type { CommandContext } from "@bound/sandbox";
import { BOUND_NAMESPACE, TypedEventEmitter, deterministicUUID } from "@bound/shared";
import { cascadeDeleteEdges, upsertEdge } from "../graph-queries";
import { redactThread } from "../redaction";

describe("Graph Memory Lifecycle - Sync and Edge Cascading", () => {
	let dbPath: string;
	let db: Database;
	let ctx: CommandContext;
	const siteId = "test-site-lifecycle";

	beforeEach(() => {
		dbPath = join(tmpdir(), `graph-lifecycle-test-${randomBytes(4).toString("hex")}.db`);
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

	describe("graph-memory.AC5.1: Edges replicate via sync (LWW reducer, change-log outbox)", () => {
		it("should create changelog entry when upsertEdge is called", () => {
			const sourceKey = "memory_a";
			const targetKey = "memory_b";
			const relation = "depends_on";

			// Create edge via upsertEdge
			upsertEdge(db, sourceKey, targetKey, relation, 1.0, siteId);

			// Verify changelog entry exists
			const changelog = db
				.prepare(
					"SELECT * FROM change_log WHERE table_name = ? AND site_id = ? ORDER BY hlc DESC LIMIT 1",
				)
				.get("memory_edges", siteId) as Record<string, unknown> | undefined;

			expect(changelog).toBeDefined();
			expect(changelog?.table_name).toBe("memory_edges");
			expect(changelog?.site_id).toBe(siteId);

			// Parse and verify row_data contains edge details
			const rowData = JSON.parse(changelog?.row_data as string) as Record<string, unknown>;
			expect(rowData.source_key).toBe(sourceKey);
			expect(rowData.target_key).toBe(targetKey);
			expect(rowData.relation).toBe(relation);
		});

		it("should create changelog entry when edge is soft-deleted", () => {
			const sourceKey = "memory_a";
			const targetKey = "memory_b";
			const relation = "depends_on";

			// Create edge
			const edgeId = upsertEdge(db, sourceKey, targetKey, relation, 1.0, siteId);

			// Clear changelog from insert
			db.exec("DELETE FROM change_log");

			// Soft-delete the edge
			softDelete(db, "memory_edges", edgeId, siteId);

			// Verify changelog entry exists for deletion
			const changelog = db
				.prepare(
					"SELECT * FROM change_log WHERE table_name = ? AND site_id = ? ORDER BY hlc DESC LIMIT 1",
				)
				.get("memory_edges", siteId) as Record<string, unknown> | undefined;

			expect(changelog).toBeDefined();
			expect(changelog?.table_name).toBe("memory_edges");

			// Verify row_data shows deleted = 1
			const rowData = JSON.parse(changelog?.row_data as string) as Record<string, unknown>;
			expect(rowData.deleted).toBe(1);
		});
	});

	describe("graph-memory.AC5.2: memory forget cascades to soft-delete all edges referencing the key", () => {
		it("should cascade-delete edges when memory is forgotten (as source)", () => {
			const keyA = "memory_a";
			const keyB = "memory_b";
			const now = new Date().toISOString();

			// Create two memories
			insertRow(
				db,
				"semantic_memory",
				{
					id: deterministicUUID(BOUND_NAMESPACE, keyA),
					key: keyA,
					value: "Memory A",
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
					id: deterministicUUID(BOUND_NAMESPACE, keyB),
					key: keyB,
					value: "Memory B",
					source: ctx.taskId || "test",
					created_at: now,
					modified_at: now,
					deleted: 0,
				},
				siteId,
			);

			// Create edge A -> B
			upsertEdge(db, keyA, keyB, "relates_to", 1.0, siteId);

			// Verify edge exists and is not deleted
			let edge = db
				.prepare("SELECT deleted FROM memory_edges WHERE source_key = ? AND target_key = ?")
				.get(keyA, keyB) as { deleted: number } | undefined;
			expect(edge?.deleted).toBe(0);

			// Forget memory A
			const memoryId = deterministicUUID(BOUND_NAMESPACE, keyA);
			softDelete(db, "semantic_memory", memoryId, siteId);

			// Cascade delete edges
			cascadeDeleteEdges(db, keyA, siteId);

			// Verify memory A is deleted
			let memory = db.prepare("SELECT deleted FROM semantic_memory WHERE key = ?").get(keyA) as
				| { deleted: number }
				| undefined;
			expect(memory?.deleted).toBe(1);

			// Verify edge is now deleted
			edge = db
				.prepare("SELECT deleted FROM memory_edges WHERE source_key = ? AND target_key = ?")
				.get(keyA, keyB) as { deleted: number } | undefined;
			expect(edge?.deleted).toBe(1);

			// Verify memory B is NOT deleted
			memory = db.prepare("SELECT deleted FROM semantic_memory WHERE key = ?").get(keyB) as
				| { deleted: number }
				| undefined;
			expect(memory?.deleted).toBe(0);
		});
	});

	describe("graph-memory.AC5.3: Thread redaction cascades edge deletion for affected memories", () => {
		it("should cascade-delete edges when thread is redacted", () => {
			const threadId = randomUUID();
			const keyA = "task_memory";
			const keyB = "reference_memory";
			const now = new Date().toISOString();

			// Create a message in the thread
			insertRow(
				db,
				"messages",
				{
					id: randomUUID(),
					thread_id: threadId,
					role: "user",
					content: "sensitive content",
					created_at: now,
					modified_at: null,
					host_origin: "test",
				},
				siteId,
			);

			// Create a memory sourced from the thread
			insertRow(
				db,
				"semantic_memory",
				{
					id: deterministicUUID(BOUND_NAMESPACE, keyA),
					key: keyA,
					value: "Memory from thread",
					source: threadId,
					created_at: now,
					modified_at: now,
					deleted: 0,
				},
				siteId,
			);

			// Create another memory not from this thread
			insertRow(
				db,
				"semantic_memory",
				{
					id: deterministicUUID(BOUND_NAMESPACE, keyB),
					key: keyB,
					value: "Other memory",
					source: "other-source",
					created_at: now,
					modified_at: now,
					deleted: 0,
				},
				siteId,
			);

			// Create edge from thread memory to other memory
			upsertEdge(db, keyA, keyB, "references", 1.0, siteId);

			// Verify setup
			let edge = db
				.prepare("SELECT deleted FROM memory_edges WHERE source_key = ? AND target_key = ?")
				.get(keyA, keyB) as { deleted: number } | undefined;
			expect(edge?.deleted).toBe(0);

			// Redact the thread
			const redactionResult = redactThread(db, threadId, siteId);

			// Verify redaction succeeded
			expect(redactionResult.ok).toBe(true);
			expect(redactionResult.value?.messagesRedacted).toBe(1);
			expect(redactionResult.value?.memoriesAffected).toBe(1);
			expect(redactionResult.value?.edgesAffected).toBe(1);

			// Verify message is redacted
			const message = db
				.prepare("SELECT content FROM messages WHERE thread_id = ?")
				.get(threadId) as { content: string } | undefined;
			expect(message?.content).toBe("[redacted]");

			// Verify memory from thread is deleted
			let memory = db.prepare("SELECT deleted FROM semantic_memory WHERE key = ?").get(keyA) as
				| { deleted: number }
				| undefined;
			expect(memory?.deleted).toBe(1);

			// Verify edge is deleted
			edge = db
				.prepare("SELECT deleted FROM memory_edges WHERE source_key = ? AND target_key = ?")
				.get(keyA, keyB) as { deleted: number } | undefined;
			expect(edge?.deleted).toBe(1);

			// Verify other memory is NOT deleted
			memory = db.prepare("SELECT deleted FROM semantic_memory WHERE key = ?").get(keyB) as
				| { deleted: number }
				| undefined;
			expect(memory?.deleted).toBe(0);
		});
	});

	describe("graph-memory.AC5.4: Forgetting a key that is target of edges also cleans up those edges", () => {
		it("should cascade-delete edges when target memory is forgotten", () => {
			const keyA = "memory_a";
			const keyB = "memory_b";
			const keyC = "memory_c";
			const now = new Date().toISOString();

			// Create three memories
			insertRow(
				db,
				"semantic_memory",
				{
					id: deterministicUUID(BOUND_NAMESPACE, keyA),
					key: keyA,
					value: "Memory A",
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
					id: deterministicUUID(BOUND_NAMESPACE, keyB),
					key: keyB,
					value: "Memory B",
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
					id: deterministicUUID(BOUND_NAMESPACE, keyC),
					key: keyC,
					value: "Memory C",
					source: ctx.taskId || "test",
					created_at: now,
					modified_at: now,
					deleted: 0,
				},
				siteId,
			);

			// Create edges A -> B and C -> B (B is target of both)
			upsertEdge(db, keyA, keyB, "depends_on", 1.0, siteId);
			upsertEdge(db, keyC, keyB, "related_to", 1.0, siteId);

			// Verify edges exist
			let edge1 = db
				.prepare("SELECT deleted FROM memory_edges WHERE source_key = ? AND target_key = ?")
				.get(keyA, keyB) as { deleted: number } | undefined;
			let edge2 = db
				.prepare("SELECT deleted FROM memory_edges WHERE source_key = ? AND target_key = ?")
				.get(keyC, keyB) as { deleted: number } | undefined;

			expect(edge1?.deleted).toBe(0);
			expect(edge2?.deleted).toBe(0);

			// Forget memory B (the target)
			const memoryId = deterministicUUID(BOUND_NAMESPACE, keyB);
			softDelete(db, "semantic_memory", memoryId, siteId);
			cascadeDeleteEdges(db, keyB, siteId);

			// Verify both edges are deleted
			edge1 = db
				.prepare("SELECT deleted FROM memory_edges WHERE source_key = ? AND target_key = ?")
				.get(keyA, keyB) as { deleted: number } | undefined;
			edge2 = db
				.prepare("SELECT deleted FROM memory_edges WHERE source_key = ? AND target_key = ?")
				.get(keyC, keyB) as { deleted: number } | undefined;

			expect(edge1?.deleted).toBe(1);
			expect(edge2?.deleted).toBe(1);

			// Verify memories A and C are not deleted
			let memory = db.prepare("SELECT deleted FROM semantic_memory WHERE key = ?").get(keyA) as
				| { deleted: number }
				| undefined;
			expect(memory?.deleted).toBe(0);

			memory = db.prepare("SELECT deleted FROM semantic_memory WHERE key = ?").get(keyC) as
				| { deleted: number }
				| undefined;
			expect(memory?.deleted).toBe(0);
		});
	});

	describe("memory forget with non-deterministic IDs", () => {
		it("deletes entries created with random UUIDs (not deterministicUUID)", async () => {
			const key = "thread_fact_user_preference";
			const randomId = randomUUID(); // simulates thread fact extraction
			const now = new Date().toISOString();

			// Insert with a random UUID — NOT deterministicUUID(BOUND_NAMESPACE, key)
			insertRow(
				db,
				"semantic_memory",
				{
					id: randomId,
					key,
					value: "User prefers dark mode",
					source: "extraction",
					created_at: now,
					modified_at: now,
					deleted: 0,
				},
				siteId,
			);

			// Import and call memory command's forget handler
			const { memory } = await import("../commands/memory");
			const result = await memory.handler({ subcommand: "forget", key }, ctx);

			expect(result.exitCode).toBe(0);
			expect(result.stdout).toContain("Memory deleted");

			// THE BUG: softDelete targets deterministicUUID(BOUND_NAMESPACE, key)
			// which is different from randomId. The row should be deleted but isn't.
			const row = db.prepare("SELECT deleted FROM semantic_memory WHERE key = ?").get(key) as {
				deleted: number;
			} | null;

			expect(row).not.toBeNull();
			expect(row?.deleted).toBe(1);
		});

		it("still deletes entries created with deterministicUUID (regression check)", async () => {
			const key = "user_stored_memory";
			const detId = deterministicUUID(BOUND_NAMESPACE, key);
			const now = new Date().toISOString();

			insertRow(
				db,
				"semantic_memory",
				{
					id: detId,
					key,
					value: "Something the user stored",
					source: "agent",
					created_at: now,
					modified_at: now,
					deleted: 0,
				},
				siteId,
			);

			const { memory } = await import("../commands/memory");
			const result = await memory.handler({ subcommand: "forget", key }, ctx);

			expect(result.exitCode).toBe(0);

			const row = db.prepare("SELECT deleted FROM semantic_memory WHERE key = ?").get(key) as {
				deleted: number;
			} | null;

			expect(row).not.toBeNull();
			expect(row?.deleted).toBe(1);
		});
	});
});
