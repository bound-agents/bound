import Database from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { randomBytes } from "node:crypto";
import { applySchema } from "@bound/core";
import { BOUND_NAMESPACE, deterministicUUID } from "@bound/shared";
import type { TypedEventEmitter } from "@bound/shared";
import type { ToolContext } from "../../types";
import { createMemoryTool } from "../memory";

function createTestDb(): Database {
	const dbPath = `/tmp/test-memory-${randomBytes(4).toString("hex")}.db`;
	const db = new Database(dbPath);
	applySchema(db);
	return db;
}

function getExecute(tool: ReturnType<typeof createMemoryTool>) {
	const execute = tool.execute;
	if (!execute) throw new Error("Tool execute is required");
	return execute;
}

describe("memory tool", () => {
	let db: Database;
	let ctx: ToolContext;
	const siteId = deterministicUUID(BOUND_NAMESPACE, "test-site");
	const testLogger = {
		debug: () => {},
		info: () => {},
		warn: () => {},
		error: () => {},
	};
	const testEventBus = new (require("@bound/shared").TypedEventEmitter)() as TypedEventEmitter;

	beforeEach(() => {
		db = createTestDb();
		ctx = {
			db,
			siteId,
			eventBus: testEventBus,
			logger: testLogger,
			threadId: "test-thread",
			taskId: "test-task",
		};
	});

	afterEach(() => {
		try {
			db.close();
		} catch {
			// ignore
		}
	});

	describe("store action", () => {
		it("should persist a memory entry with key and value", async () => {
			const tool = createMemoryTool(ctx);
			const result = await getExecute(tool)({
				action: "store",
				key: "test_key",
				value: "test_value",
			});

			expect(result).toContain("Memory saved");

			// Verify in database
			const row = db
				.prepare("SELECT key, value, tier, deleted FROM semantic_memory WHERE key = ?")
				.get("test_key") as { key: string; value: string; tier: string; deleted: number } | null;

			expect(row).not.toBeNull();
			expect(row?.key).toBe("test_key");
			expect(row?.value).toBe("test_value");
			expect(row?.tier).toBe("default");
			expect(row?.deleted).toBe(0);
		});

		it("should auto-resolve tier from pinned prefix", async () => {
			const tool = createMemoryTool(ctx);
			await getExecute(tool)({
				action: "store",
				key: "_standing:important",
				value: "critical info",
			});

			const row = db
				.prepare("SELECT tier FROM semantic_memory WHERE key = ?")
				.get("_standing:important") as { tier: string } | null;

			expect(row?.tier).toBe("pinned");
		});

		it("should allow explicit tier override", async () => {
			const tool = createMemoryTool(ctx);
			await getExecute(tool)({
				action: "store",
				key: "detail_mem",
				value: "detailed info",
				tier: "detail",
			});

			const row = db
				.prepare("SELECT tier FROM semantic_memory WHERE key = ?")
				.get("detail_mem") as { tier: string } | null;

			expect(row?.tier).toBe("detail");
		});

		it("should error when key is missing", async () => {
			const tool = createMemoryTool(ctx);
			const result = await getExecute(tool)({
				action: "store",
				value: "test_value",
			});

			expect(result).toContain("Error");
			expect(result).toContain("key");
		});

		it("should error when value is missing", async () => {
			const tool = createMemoryTool(ctx);
			const result = await getExecute(tool)({
				action: "store",
				key: "test_key",
			});

			expect(result).toContain("Error");
		});
	});

	describe("search action", () => {
		beforeEach(async () => {
			const tool = createMemoryTool(ctx);
			await getExecute(tool)({
				action: "store",
				key: "search_test",
				value: "this is searchable content",
			});
			await getExecute(tool)({
				action: "store",
				key: "another_key",
				value: "different content here",
			});
		});

		it("should find memory by keyword search", async () => {
			const tool = createMemoryTool(ctx);
			const result = await getExecute(tool)({
				action: "search",
				key: "searchable",
			});

			expect(result).toContain("Found");
			expect(result).toContain("search_test");
		});

		it("should return no results for missing keywords", async () => {
			const tool = createMemoryTool(ctx);
			const result = await getExecute(tool)({
				action: "search",
				key: "nonexistent_keyword",
			});

			expect(result).toContain("No memories matched");
		});

		it("should error when query is missing", async () => {
			const tool = createMemoryTool(ctx);
			const result = await getExecute(tool)({
				action: "search",
			});

			expect(result).toContain("Error");
		});
	});

	describe("connect action", () => {
		beforeEach(async () => {
			const tool = createMemoryTool(ctx);
			await getExecute(tool)({
				action: "store",
				key: "source_mem",
				value: "source content",
			});
			await getExecute(tool)({
				action: "store",
				key: "target_mem",
				value: "target content",
			});
		});

		it("should create an edge between two memories", async () => {
			const tool = createMemoryTool(ctx);
			const result = await getExecute(tool)({
				action: "connect",
				source_key: "source_mem",
				target_key: "target_mem",
				relation: "related_to",
			});

			expect(result).toContain("Edge created");

			const edge = db
				.prepare(
					"SELECT source_key, target_key, relation, deleted FROM memory_edges WHERE source_key = ? AND target_key = ? AND deleted = 0",
				)
				.get("source_mem", "target_mem") as {
				source_key: string;
				target_key: string;
				relation: string;
				deleted: number;
			} | null;

			expect(edge).not.toBeNull();
			expect(edge?.relation).toBe("related_to");
		});

		it("should error when source or target missing", async () => {
			const tool = createMemoryTool(ctx);
			const result = await getExecute(tool)({
				action: "connect",
				source_key: "source_mem",
				relation: "related_to",
			});

			expect(result).toContain("Error");
		});

		it("should error when source memory does not exist", async () => {
			const tool = createMemoryTool(ctx);
			const result = await getExecute(tool)({
				action: "connect",
				source_key: "nonexistent_source",
				target_key: "target_mem",
				relation: "related_to",
			});

			expect(result).toContain("Error");
			expect(result).toContain("source memory not found");
		});

		it("should error when target memory does not exist", async () => {
			const tool = createMemoryTool(ctx);
			const result = await getExecute(tool)({
				action: "connect",
				source_key: "source_mem",
				target_key: "nonexistent_target",
				relation: "related_to",
			});

			expect(result).toContain("Error");
			expect(result).toContain("target memory not found");
		});
	});

	describe("disconnect action", () => {
		beforeEach(async () => {
			const tool = createMemoryTool(ctx);
			await getExecute(tool)({
				action: "store",
				key: "mem1",
				value: "content1",
			});
			await getExecute(tool)({
				action: "store",
				key: "mem2",
				value: "content2",
			});
			await getExecute(tool)({
				action: "connect",
				source_key: "mem1",
				target_key: "mem2",
				relation: "related_to",
			});
		});

		it("should remove edge between two memories", async () => {
			const tool = createMemoryTool(ctx);
			const result = await getExecute(tool)({
				action: "disconnect",
				source_key: "mem1",
				target_key: "mem2",
			});

			expect(result).toContain("Removed");

			const edge = db
				.prepare("SELECT deleted FROM memory_edges WHERE source_key = ? AND target_key = ?")
				.get("mem1", "mem2") as { deleted: number } | null;

			expect(edge?.deleted).toBe(1);
		});

		it("should error when no edge exists", async () => {
			const tool = createMemoryTool(ctx);
			const result = await getExecute(tool)({
				action: "disconnect",
				source_key: "mem1",
				target_key: "nonexistent",
			});

			expect(result).toContain("Error");
			expect(result).toContain("no edges found");
		});
	});

	describe("forget action", () => {
		beforeEach(async () => {
			const tool = createMemoryTool(ctx);
			await getExecute(tool)({
				action: "store",
				key: "forget_test",
				value: "content to forget",
			});
			await getExecute(tool)({
				action: "store",
				key: "keep_this",
				value: "keep it",
			});
		});

		it("should soft-delete a memory by exact key", async () => {
			const tool = createMemoryTool(ctx);
			const result = await getExecute(tool)({
				action: "forget",
				key: "forget_test",
			});

			expect(result).toContain("Memory deleted");

			const row = db
				.prepare("SELECT deleted FROM semantic_memory WHERE key = ?")
				.get("forget_test") as { deleted: number } | null;

			expect(row?.deleted).toBe(1);
		});

		it("should error when key does not exist", async () => {
			const tool = createMemoryTool(ctx);
			const result = await getExecute(tool)({
				action: "forget",
				key: "nonexistent",
			});

			expect(result).toContain("Error");
			expect(result).toContain("Memory not found");
		});

		it("should cascade delete edges when forgetting a memory", async () => {
			const tool = createMemoryTool(ctx);
			await getExecute(tool)({
				action: "store",
				key: "mem_with_edges",
				value: "has edges",
			});
			await getExecute(tool)({
				action: "connect",
				source_key: "mem_with_edges",
				target_key: "keep_this",
				relation: "related_to",
			});

			const result = await getExecute(tool)({
				action: "forget",
				key: "mem_with_edges",
			});

			expect(result).toContain("edge(s) also removed");

			const edges = db
				.prepare("SELECT COUNT(*) as cnt FROM memory_edges WHERE deleted = 0 AND source_key = ?")
				.get("mem_with_edges") as { cnt: number };

			expect(edges.cnt).toBe(0);
		});
	});

	describe("traverse action", () => {
		beforeEach(async () => {
			const tool = createMemoryTool(ctx);
			await getExecute(tool)({
				action: "store",
				key: "start",
				value: "starting point",
			});
			await getExecute(tool)({
				action: "store",
				key: "level1",
				value: "level 1 content",
			});
			await getExecute(tool)({
				action: "store",
				key: "level2",
				value: "level 2 content",
			});
			await getExecute(tool)({
				action: "connect",
				source_key: "start",
				target_key: "level1",
				relation: "related_to",
			});
			await getExecute(tool)({
				action: "connect",
				source_key: "level1",
				target_key: "level2",
				relation: "related_to",
			});
		});

		it("should traverse graph from starting memory", async () => {
			const tool = createMemoryTool(ctx);
			const result = await getExecute(tool)({
				action: "traverse",
				key: "start",
				depth: 2,
			});

			expect(result).toContain("Graph traversal");
			expect(result).toContain("start");
		});

		it("should error when key is missing", async () => {
			const tool = createMemoryTool(ctx);
			const result = await getExecute(tool)({
				action: "traverse",
			});

			expect(result).toContain("Error");
		});
	});

	describe("neighbors action", () => {
		beforeEach(async () => {
			const tool = createMemoryTool(ctx);
			await getExecute(tool)({
				action: "store",
				key: "center",
				value: "central node",
			});
			await getExecute(tool)({
				action: "store",
				key: "neighbor1",
				value: "neighbor 1",
			});
			await getExecute(tool)({
				action: "store",
				key: "neighbor2",
				value: "neighbor 2",
			});
			await getExecute(tool)({
				action: "connect",
				source_key: "center",
				target_key: "neighbor1",
				relation: "related_to",
			});
			await getExecute(tool)({
				action: "connect",
				source_key: "neighbor2",
				target_key: "center",
				relation: "related_to",
			});
		});

		it("should list neighbors of a memory", async () => {
			const tool = createMemoryTool(ctx);
			const result = await getExecute(tool)({
				action: "neighbors",
				key: "center",
			});

			expect(result).toContain("Neighbors of");
			expect(result).toContain("center");
		});

		it("should error when key is missing", async () => {
			const tool = createMemoryTool(ctx);
			const result = await getExecute(tool)({
				action: "neighbors",
			});

			expect(result).toContain("Error");
		});
	});

	describe("invalid action", () => {
		it("should error on invalid action", async () => {
			const tool = createMemoryTool(ctx);
			const result = await getExecute(tool)({
				action: "invalid_action",
			});

			expect(result).toContain("Error");
			expect(result).toContain("Unknown action");
			expect(result).toContain("store");
			expect(result).toContain("forget");
			expect(result).toContain("search");
			expect(result).toContain("connect");
			expect(result).toContain("disconnect");
			expect(result).toContain("traverse");
			expect(result).toContain("neighbors");
		});

		it("should error when action is missing", async () => {
			const tool = createMemoryTool(ctx);
			const result = await getExecute(tool)({});

			expect(result).toContain("Error");
		});
	});

	describe("edge tier promotion", () => {
		it("should promote target from default to detail tier when creating summarizes edge", async () => {
			const tool = createMemoryTool(ctx);

			// Store summary and default-tier entry
			await getExecute(tool)({
				action: "store",
				key: "summary_mem",
				value: "summary content",
				tier: "summary",
			});
			await getExecute(tool)({
				action: "store",
				key: "default_detail",
				value: "detail to summarize",
				tier: "default",
			});

			// Verify target starts as default
			let row = db
				.prepare("SELECT tier FROM semantic_memory WHERE key = ?")
				.get("default_detail") as { tier: string } | null;
			expect(row?.tier).toBe("default");

			// Create summarizes edge
			const result = await getExecute(tool)({
				action: "connect",
				source_key: "summary_mem",
				target_key: "default_detail",
				relation: "summarizes",
			});

			expect(result).toContain("Edge created");

			// Verify target promoted to detail
			row = db.prepare("SELECT tier FROM semantic_memory WHERE key = ?").get("default_detail") as {
				tier: string;
			} | null;
			expect(row?.tier).toBe("detail");
		});

		it("should not demote pinned target when creating summarizes edge", async () => {
			const tool = createMemoryTool(ctx);

			// Store pinned entry (via prefix)
			await getExecute(tool)({
				action: "store",
				key: "_pinned:important",
				value: "pinned content",
			});
			await getExecute(tool)({
				action: "store",
				key: "summary_source",
				value: "summary",
				tier: "summary",
			});

			// Verify target is pinned
			let row = db
				.prepare("SELECT tier FROM semantic_memory WHERE key = ?")
				.get("_pinned:important") as { tier: string } | null;
			expect(row?.tier).toBe("pinned");

			// Create summarizes edge
			await getExecute(tool)({
				action: "connect",
				source_key: "summary_source",
				target_key: "_pinned:important",
				relation: "summarizes",
			});

			// Verify target remains pinned
			row = db
				.prepare("SELECT tier FROM semantic_memory WHERE key = ?")
				.get("_pinned:important") as { tier: string } | null;
			expect(row?.tier).toBe("pinned");
		});
	});

	describe("forget cascade with tier promotion", () => {
		it("should promote detail children back to default when forgetting summary parent", async () => {
			const tool = createMemoryTool(ctx);

			// Store summary and detail entries
			await getExecute(tool)({
				action: "store",
				key: "summary_node",
				value: "summary",
				tier: "summary",
			});
			await getExecute(tool)({
				action: "store",
				key: "detail_node1",
				value: "detail 1",
				tier: "default",
			});
			await getExecute(tool)({
				action: "store",
				key: "detail_node2",
				value: "detail 2",
				tier: "default",
			});

			// Create summarizes edges to promote them to detail
			await getExecute(tool)({
				action: "connect",
				source_key: "summary_node",
				target_key: "detail_node1",
				relation: "summarizes",
			});
			await getExecute(tool)({
				action: "connect",
				source_key: "summary_node",
				target_key: "detail_node2",
				relation: "summarizes",
			});

			// Verify both are now detail tier
			let row1 = db
				.prepare("SELECT tier FROM semantic_memory WHERE key = ?")
				.get("detail_node1") as { tier: string } | null;
			let row2 = db
				.prepare("SELECT tier FROM semantic_memory WHERE key = ?")
				.get("detail_node2") as { tier: string } | null;
			expect(row1?.tier).toBe("detail");
			expect(row2?.tier).toBe("detail");

			// Forget the summary parent
			const result = await getExecute(tool)({
				action: "forget",
				key: "summary_node",
			});

			expect(result).toContain("Memory deleted");

			// Verify children are promoted back to default
			row1 = db
				.prepare("SELECT tier FROM semantic_memory WHERE key = ? AND deleted = 0")
				.get("detail_node1") as { tier: string } | null;
			row2 = db
				.prepare("SELECT tier FROM semantic_memory WHERE key = ? AND deleted = 0")
				.get("detail_node2") as { tier: string } | null;
			expect(row1?.tier).toBe("default");
			expect(row2?.tier).toBe("default");
		});

		it("should not demote non-detail children when forgetting summary", async () => {
			const tool = createMemoryTool(ctx);

			// Store summary and a pinned child
			await getExecute(tool)({
				action: "store",
				key: "summary_with_pinned",
				value: "summary",
				tier: "summary",
			});
			await getExecute(tool)({
				action: "store",
				key: "_policy:rule",
				value: "policy",
			});

			// Create summarizes edge
			await getExecute(tool)({
				action: "connect",
				source_key: "summary_with_pinned",
				target_key: "_policy:rule",
				relation: "summarizes",
			});

			// Verify child remains pinned
			let row = db
				.prepare("SELECT tier FROM semantic_memory WHERE key = ?")
				.get("_policy:rule") as { tier: string } | null;
			expect(row?.tier).toBe("pinned");

			// Forget summary
			await getExecute(tool)({
				action: "forget",
				key: "summary_with_pinned",
			});

			// Verify pinned child remains pinned
			row = db
				.prepare("SELECT tier FROM semantic_memory WHERE key = ? AND deleted = 0")
				.get("_policy:rule") as { tier: string } | null;
			expect(row?.tier).toBe("pinned");
		});
	});

	describe("disconnect orphan promotion", () => {
		it("should demote target from detail to default when removing last summarizes edge", async () => {
			const tool = createMemoryTool(ctx);

			// Store summary and detail entry
			await getExecute(tool)({
				action: "store",
				key: "only_summary",
				value: "summary",
				tier: "summary",
			});
			await getExecute(tool)({
				action: "store",
				key: "orphan_detail",
				value: "will be orphaned",
				tier: "default",
			});

			// Create summarizes edge (promotes to detail)
			await getExecute(tool)({
				action: "connect",
				source_key: "only_summary",
				target_key: "orphan_detail",
				relation: "summarizes",
			});

			// Verify target is detail
			let row = db
				.prepare("SELECT tier FROM semantic_memory WHERE key = ?")
				.get("orphan_detail") as { tier: string } | null;
			expect(row?.tier).toBe("detail");

			// Disconnect the edge
			const result = await getExecute(tool)({
				action: "disconnect",
				source_key: "only_summary",
				target_key: "orphan_detail",
				relation: "summarizes",
			});

			expect(result).toContain("Removed");

			// Verify target demoted back to default
			row = db.prepare("SELECT tier FROM semantic_memory WHERE key = ?").get("orphan_detail") as {
				tier: string;
			} | null;
			expect(row?.tier).toBe("default");
		});

		it("should keep target as detail when other summarizes edges remain", async () => {
			const tool = createMemoryTool(ctx);

			// Store two summaries and one detail entry
			await getExecute(tool)({
				action: "store",
				key: "summary1",
				value: "first summary",
				tier: "summary",
			});
			await getExecute(tool)({
				action: "store",
				key: "summary2",
				value: "second summary",
				tier: "summary",
			});
			await getExecute(tool)({
				action: "store",
				key: "shared_detail",
				value: "shared detail",
				tier: "default",
			});

			// Create two summarizes edges to same target
			await getExecute(tool)({
				action: "connect",
				source_key: "summary1",
				target_key: "shared_detail",
				relation: "summarizes",
			});
			await getExecute(tool)({
				action: "connect",
				source_key: "summary2",
				target_key: "shared_detail",
				relation: "summarizes",
			});

			// Verify target is detail
			let row = db
				.prepare("SELECT tier FROM semantic_memory WHERE key = ?")
				.get("shared_detail") as { tier: string } | null;
			expect(row?.tier).toBe("detail");

			// Disconnect first edge
			await getExecute(tool)({
				action: "disconnect",
				source_key: "summary1",
				target_key: "shared_detail",
				relation: "summarizes",
			});

			// Verify target still detail (second edge remains)
			row = db.prepare("SELECT tier FROM semantic_memory WHERE key = ?").get("shared_detail") as {
				tier: string;
			} | null;
			expect(row?.tier).toBe("detail");
		});
	});

	describe("search with multiple keyword matching", () => {
		beforeEach(async () => {
			const tool = createMemoryTool(ctx);
			// Store entries with various keyword combinations
			await getExecute(tool)({
				action: "store",
				key: "both_keywords",
				value: "python javascript programming languages",
			});
			await getExecute(tool)({
				action: "store",
				key: "one_keyword",
				value: "only python is here",
			});
			await getExecute(tool)({
				action: "store",
				key: "neither",
				value: "completely different content about cats",
			});
			await getExecute(tool)({
				action: "store",
				key: "javascript_focus",
				value: "javascript is the best web language",
			});
		});

		it("should match entries containing all query keywords", async () => {
			const tool = createMemoryTool(ctx);
			const result = await getExecute(tool)({
				action: "search",
				key: "python javascript",
			});

			expect(result).toContain("Found");
			expect(result).toContain("both_keywords");
		});

		it("should match entries containing any of the query keywords", async () => {
			const tool = createMemoryTool(ctx);
			const result = await getExecute(tool)({
				action: "search",
				key: "python javascript",
			});

			// Should find both_keywords, one_keyword, and javascript_focus
			expect(result).toContain("Found");
			expect(result).toContain("both_keywords");
			expect(result).toContain("one_keyword");
			expect(result).toContain("javascript_focus");
		});

		it("should filter out stop words when matching", async () => {
			const tool = createMemoryTool(ctx);
			const result = await getExecute(tool)({
				action: "search",
				key: "is the a",
			});

			// All stop words, should find nothing searchable
			expect(result).toContain("No searchable keywords found");
		});

		it("should apply case-insensitive matching for keywords", async () => {
			const tool = createMemoryTool(ctx);
			const result = await getExecute(tool)({
				action: "search",
				key: "PYTHON JAVASCRIPT",
			});

			expect(result).toContain("Found");
			expect(result).toContain("both_keywords");
			expect(result).toContain("one_keyword");
			expect(result).toContain("javascript_focus");
		});

		it("should match keywords in both key and value", async () => {
			const tool = createMemoryTool(ctx);

			const result = await getExecute(tool)({
				action: "search",
				key: "python",
			});

			expect(result).toContain("Found");
			// Should match entries with python in key or value
			expect(result).toContain("both_keywords");
			expect(result).toContain("one_keyword");
		});

		it("should filter results excluding _internal prefix", async () => {
			const tool = createMemoryTool(ctx);

			// Store internal entry
			await getExecute(tool)({
				action: "store",
				key: "_internal.python_cache",
				value: "python content",
			});

			const result = await getExecute(tool)({
				action: "search",
				key: "python",
			});

			// Should NOT include _internal prefixed entries
			expect(result).not.toContain("_internal.python_cache");
			// But should include regular python entries
			expect(result).toContain("both_keywords");
			expect(result).toContain("one_keyword");
		});

		it("should respect soft-delete when searching", async () => {
			const tool = createMemoryTool(ctx);

			// Forget one entry
			await getExecute(tool)({
				action: "forget",
				key: "both_keywords",
			});

			const result = await getExecute(tool)({
				action: "search",
				key: "python javascript",
			});

			// Should NOT include forgotten entry
			expect(result).not.toContain("both_keywords");
			// But should find others
			expect(result).toContain("one_keyword");
			expect(result).toContain("javascript_focus");
		});
	});
});
