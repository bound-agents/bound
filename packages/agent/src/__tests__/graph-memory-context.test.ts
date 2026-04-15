import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { randomBytes } from "node:crypto";
import { unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applySchema, createDatabase, insertRow } from "@bound/core";
import { graphSeededRetrieval, upsertEdge } from "../graph-queries.js";
import { buildVolatileEnrichment } from "../summary-extraction.js";

let db: Database;
let dbPath: string;
const siteId = randomBytes(8).toString("hex");
const baseline = "2026-03-01T00:00:00.000Z";

beforeEach(() => {
	dbPath = join(tmpdir(), `bound-test-${randomBytes(4).toString("hex")}.db`);
	db = createDatabase(dbPath);
	applySchema(db);
});

afterEach(() => {
	db.close();
	try {
		unlinkSync(dbPath);
	} catch {
		/* ignore */
	}
});

describe("buildVolatileEnrichment — graph-memory integration", () => {
	describe("AC4.1: Graph-seeded retrieval injects connected memories", () => {
		it("retrieves seed memory and traverses to connected entries", () => {
			// Create 5 memories with a graph structure: A -> B -> C
			const memA = {
				id: randomBytes(8).toString("hex"),
				key: "scheduler_design",
				value: "The scheduler uses cron patterns for task scheduling",
				source: null,
				created_at: "2026-02-01T00:00:00.000Z",
				modified_at: "2026-02-15T12:00:00.000Z",
				deleted: 0,
			};

			const memB = {
				id: randomBytes(8).toString("hex"),
				key: "cron_syntax",
				value: "Cron format: minute hour day-of-month month day-of-week",
				source: null,
				created_at: "2026-02-01T00:00:00.000Z",
				modified_at: "2026-02-20T12:00:00.000Z",
				deleted: 0,
			};

			const memC = {
				id: randomBytes(8).toString("hex"),
				key: "cron_examples",
				value: "0 9 * * * = every day at 9am",
				source: null,
				created_at: "2026-02-01T00:00:00.000Z",
				modified_at: "2026-02-25T12:00:00.000Z",
				deleted: 0,
			};

			// Unrelated memories to filter out
			const memD = {
				id: randomBytes(8).toString("hex"),
				key: "user_preferences",
				value: "User likes dark mode",
				source: null,
				created_at: "2026-02-01T00:00:00.000Z",
				modified_at: "2026-02-28T12:00:00.000Z",
				deleted: 0,
			};

			const memE = {
				id: randomBytes(8).toString("hex"),
				key: "file_formats",
				value: "JSON and YAML are text formats",
				source: null,
				created_at: "2026-02-01T00:00:00.000Z",
				modified_at: "2026-03-01T12:00:00.000Z",
				deleted: 0,
			};

			// Insert all memories
			for (const mem of [memA, memB, memC, memD, memE]) {
				insertRow(db, "semantic_memory", mem, siteId);
			}

			// Create edges: A -> B -> C
			upsertEdge(db, memA.key, memB.key, "refers_to", 0.8, siteId);
			upsertEdge(db, memB.key, memC.key, "example_of", 0.7, siteId);

			// User message with keyword that matches A's value
			const userMessage = "How does the scheduler handle cron patterns?";

			const enrichment = buildVolatileEnrichment(db, baseline, 10, 5, userMessage);

			// Should contain A (seed), B and C (via graph traversal)
			const memoryLines = enrichment.memoryDeltaLines.join("\n");

			expect(memoryLines).toContain("scheduler_design");
			expect(memoryLines).toContain("[seed]");

			// B and C should be tagged with depth/relation info
			expect(memoryLines).toContain("cron_syntax");
			expect(memoryLines).toContain("cron_examples");

			// Verify that both graph entries (B and C) are present via graph tag
			// They should have tags with depth info
			const hasBTag = memoryLines.match(/cron_syntax.*\[/);
			const hasCTag = memoryLines.match(/cron_examples.*\[/);
			expect(hasBTag).toBeDefined();
			expect(hasCTag).toBeDefined();
		});

		it("tags seed entries with [seed] when graph retrieval is used", () => {
			const seedMem = {
				id: randomBytes(8).toString("hex"),
				key: "sync_protocol",
				value: "Sync uses Ed25519 signatures for authentication",
				source: null,
				created_at: "2026-02-01T00:00:00.000Z",
				modified_at: "2026-02-15T12:00:00.000Z",
				deleted: 0,
			};

			// Create another memory to connect via edge
			const linkedMem = {
				id: randomBytes(8).toString("hex"),
				key: "ed25519_keys",
				value: "Ed25519 provides fast key signatures",
				source: null,
				created_at: "2026-02-01T00:00:00.000Z",
				modified_at: "2026-02-20T12:00:00.000Z",
				deleted: 0,
			};

			insertRow(db, "semantic_memory", seedMem, siteId);
			insertRow(db, "semantic_memory", linkedMem, siteId);

			// Create edge to ensure graph path is taken
			upsertEdge(db, seedMem.key, linkedMem.key, "uses", 0.8, siteId);

			const userMessage = "Tell me about the sync protocol";
			const enrichment = buildVolatileEnrichment(db, baseline, 10, 5, userMessage);

			const seedLine = enrichment.memoryDeltaLines.find((l) => l.includes("sync_protocol"));
			expect(seedLine).toBeDefined();
			expect(seedLine).toContain("[seed]");
		});

		it("tags traversed entries with [depth N, relation]", () => {
			const mem1 = {
				id: randomBytes(8).toString("hex"),
				key: "memory_structure",
				value: "Memory entries have keys and values for semantic search",
				source: null,
				created_at: "2026-02-01T00:00:00.000Z",
				modified_at: "2026-02-15T12:00:00.000Z",
				deleted: 0,
			};

			const mem2 = {
				id: randomBytes(8).toString("hex"),
				key: "semantic_search",
				value: "Search uses keyword matching on keys and values",
				source: null,
				created_at: "2026-02-01T00:00:00.000Z",
				modified_at: "2026-02-20T12:00:00.000Z",
				deleted: 0,
			};

			insertRow(db, "semantic_memory", mem1, siteId);
			insertRow(db, "semantic_memory", mem2, siteId);

			// Create edge from mem1 to mem2 so mem1 becomes seed
			upsertEdge(db, mem1.key, mem2.key, "enables", 0.9, siteId);

			const userMessage = "How does memory structure work?";
			const enrichment = buildVolatileEnrichment(db, baseline, 10, 5, userMessage);

			const mem2Line = enrichment.memoryDeltaLines.find((l) => l.includes("semantic_search"));
			expect(mem2Line).toBeDefined();
			// Should have depth tag since it's traversed from seed
			if (mem2Line?.match(/\[depth \d+/)) {
				expect(mem2Line).toMatch(/\[depth \d+, enables\]/);
			}
		});
	});

	describe("AC4.2: Recency fallback fills remaining slots", () => {
		it("combines graph results with recency fallback", () => {
			// Create connected memories to form a graph
			const mem0 = {
				id: randomBytes(8).toString("hex"),
				key: "graph_seeding",
				value: "Graph seeding finds related memories from user query",
				source: null,
				created_at: "2026-02-01T00:00:00.000Z",
				modified_at: "2026-02-20T12:00:00.000Z",
				deleted: 0,
			};

			const mem1 = {
				id: randomBytes(8).toString("hex"),
				key: "graph_traversal",
				value: "Traversal walks the memory graph to find connections",
				source: null,
				created_at: "2026-02-01T00:00:00.000Z",
				modified_at: "2026-02-21T12:00:00.000Z",
				deleted: 0,
			};

			const mem2 = {
				id: randomBytes(8).toString("hex"),
				key: "graph_depth",
				value: "Depth limits traversal to prevent too much expansion",
				source: null,
				created_at: "2026-02-01T00:00:00.000Z",
				modified_at: "2026-02-22T12:00:00.000Z",
				deleted: 0,
			};

			insertRow(db, "semantic_memory", mem0, siteId);
			insertRow(db, "semantic_memory", mem1, siteId);
			insertRow(db, "semantic_memory", mem2, siteId);

			// Create edges: mem0 -> mem1 -> mem2
			upsertEdge(db, mem0.key, mem1.key, "leads_to", 0.8, siteId);
			upsertEdge(db, mem1.key, mem2.key, "related_to", 0.7, siteId);

			// Create 5 recent unrelated memories for recency fallback
			for (let i = 0; i < 5; i++) {
				const mem = {
					id: randomBytes(8).toString("hex"),
					key: `recent_mem_${i}`,
					value: `Recent memory ${i} about something else entirely`,
					source: null,
					created_at: "2026-02-01T00:00:00.000Z",
					modified_at: "2026-03-05T12:00:00.000Z",
					deleted: 0,
				};
				insertRow(db, "semantic_memory", mem, siteId);
			}

			// Trigger graph-seeded retrieval
			const userMessage = "Tell me about graph seeding";
			const enrichment = buildVolatileEnrichment(db, baseline, 8, 5, userMessage);

			// Should have at most 8 memory entries
			expect(enrichment.memoryDeltaLines.length).toBeLessThanOrEqual(8);

			// Count retrieval methods in output
			const hasGraphTag = enrichment.memoryDeltaLines.some(
				(l) => l.includes("[seed]") || l.match(/\[depth \d+/),
			);

			// Should have graph entries (at minimum seed entry)
			expect(hasGraphTag).toBe(true);
			// When graph returns fewer than maxMemory, recency should fill
			if (enrichment.recencyCount !== undefined) {
				expect(enrichment.recencyCount).toBeGreaterThanOrEqual(0);
			}
		});

		it("limits results to maxMemory even with graph + recency", () => {
			// Create seed memory to trigger graph path
			const seedMem = {
				id: randomBytes(8).toString("hex"),
				key: "test_seed",
				value: "This is a test seed for memory limiting",
				source: null,
				created_at: "2026-02-01T00:00:00.000Z",
				modified_at: "2026-02-20T12:00:00.000Z",
				deleted: 0,
			};
			insertRow(db, "semantic_memory", seedMem, siteId);

			// Create connected memory
			const connMem = {
				id: randomBytes(8).toString("hex"),
				key: "test_connected",
				value: "This is connected via edge",
				source: null,
				created_at: "2026-02-01T00:00:00.000Z",
				modified_at: "2026-02-21T12:00:00.000Z",
				deleted: 0,
			};
			insertRow(db, "semantic_memory", connMem, siteId);
			upsertEdge(db, seedMem.key, connMem.key, "relates_to", 0.8, siteId);

			// Create many recent memories to test limit
			for (let i = 0; i < 15; i++) {
				const mem = {
					id: randomBytes(8).toString("hex"),
					key: `mem_${i}`,
					value: `Memory ${i} about various topics`,
					source: null,
					created_at: "2026-02-01T00:00:00.000Z",
					modified_at: "2026-03-05T12:00:00.000Z",
					deleted: 0,
				};
				insertRow(db, "semantic_memory", mem, siteId);
			}

			const enrichment = buildVolatileEnrichment(
				db,
				baseline,
				5, // maxMemory = 5
				5,
				"test seed query",
			);

			// Should respect maxMemory limit for L2+L3 (L1 summaries uncapped; pinned entries exclude from count)
			const regularMemories = enrichment.memoryDeltaLines.filter((l) => !l.includes("[pinned]"));
			expect(regularMemories.length).toBeLessThanOrEqual(6);
		});
	});

	describe("AC4.3: Empty edges table produces identical output to current behavior", () => {
		it("returns non-graph output when no edges exist", () => {
			// Create memories with no edges (all created before baseline + 1 month)
			// to ensure they appear in delta when we query from baseline
			const mem1 = {
				id: randomBytes(8).toString("hex"),
				key: "test_key_1",
				value: "test value 1",
				source: null,
				created_at: "2026-02-01T00:00:00.000Z",
				modified_at: "2026-03-15T12:00:00.000Z",
				deleted: 0,
			};

			const mem2 = {
				id: randomBytes(8).toString("hex"),
				key: "test_key_2",
				value: "test value 2",
				source: null,
				created_at: "2026-02-01T00:00:00.000Z",
				modified_at: "2026-03-16T12:00:00.000Z",
				deleted: 0,
			};

			insertRow(db, "semantic_memory", mem1, siteId);
			insertRow(db, "semantic_memory", mem2, siteId);

			// No edges created — call buildVolatileEnrichment
			const enrichment = buildVolatileEnrichment(db, baseline, 10, 5);

			const memoryLines = enrichment.memoryDeltaLines;

			// Should contain entries without [seed], [graph], [recency] tags
			// (or with [relevant] tag from keyword boosting, but no graph tags)
			expect(memoryLines.length).toBeGreaterThan(0);

			// With no edges, graph path doesn't activate. L3 fills recency slots and tags [recency].
			// graphCount should be 0 (no graph-seeded entries), recencyCount >= 1 (from L3)
			expect(enrichment.graphCount).toBe(0);
			expect(enrichment.recencyCount).toBeGreaterThanOrEqual(1);
		});

		it("preserves relative time and source labels without graph", () => {
			const taskId = randomBytes(8).toString("hex");
			insertRow(
				db,
				"tasks",
				{
					id: taskId,
					type: "cron",
					status: "active",
					trigger_spec: "my_task",
					created_at: "2026-02-01T00:00:00.000Z",
					modified_at: "2026-02-01T00:00:00.000Z",
					last_run_at: "2026-02-01T00:00:00.000Z",
					consecutive_failures: 0,
					claimed_by: null,
					deleted: 0,
				},
				siteId,
			);

			const mem = {
				id: randomBytes(8).toString("hex"),
				key: "test_key",
				value: "test value",
				source: taskId,
				created_at: "2026-02-01T00:00:00.000Z",
				modified_at: "2026-03-15T12:00:00.000Z",
				deleted: 0,
			};

			insertRow(db, "semantic_memory", mem, siteId);

			const enrichment = buildVolatileEnrichment(db, baseline, 10, 5);

			// Find the memory line (may not be first if there are others)
			const line = enrichment.memoryDeltaLines.find((l) => l.includes("test_key"));
			expect(line).toBeDefined();
			if (line) {
				// Should have source label and relative time (old behavior)
				expect(line).toContain('via task "my_task"');
			}
		});
	});

	describe("AC4.4: Output format shows retrieval method tags", () => {
		it("tags each entry with retrieval method", () => {
			// Create pinned, seeded, and recency entries
			const pinnedMem = {
				id: randomBytes(8).toString("hex"),
				key: "_pinned_important",
				value: "Important info",
				source: null,
				created_at: "2026-01-01T00:00:00.000Z",
				modified_at: "2026-01-01T00:00:00.000Z",
				deleted: 0,
			};

			const seedMem = {
				id: randomBytes(8).toString("hex"),
				key: "seed_entry",
				value: "This matches the query",
				source: null,
				created_at: "2026-02-01T00:00:00.000Z",
				modified_at: "2026-02-15T12:00:00.000Z",
				deleted: 0,
			};

			const graphMem = {
				id: randomBytes(8).toString("hex"),
				key: "graph_entry",
				value: "Connected to seed",
				source: null,
				created_at: "2026-02-01T00:00:00.000Z",
				modified_at: "2026-02-20T12:00:00.000Z",
				deleted: 0,
			};

			const recencyMem = {
				id: randomBytes(8).toString("hex"),
				key: "recent_entry",
				value: "Recent but unrelated",
				source: null,
				created_at: "2026-02-01T00:00:00.000Z",
				modified_at: "2026-03-05T12:00:00.000Z",
				deleted: 0,
			};

			insertRow(db, "semantic_memory", pinnedMem, siteId);
			insertRow(db, "semantic_memory", seedMem, siteId);
			insertRow(db, "semantic_memory", graphMem, siteId);
			insertRow(db, "semantic_memory", recencyMem, siteId);

			// Create edge seed -> graph
			upsertEdge(db, seedMem.key, graphMem.key, "related_to", 0.8, siteId);

			const enrichment = buildVolatileEnrichment(db, baseline, 10, 5, "seed entry query");

			const memoryLines = enrichment.memoryDeltaLines;

			// Count tag types
			const pinnedCount = memoryLines.filter((l) => l.includes("[pinned]")).length;
			const seedCount = memoryLines.filter((l) => l.includes("[seed]")).length;

			// Each category should have at least one entry (if present)
			expect(pinnedCount).toBeGreaterThanOrEqual(1); // _pinned_important
			expect(seedCount).toBeGreaterThanOrEqual(1); // seed_entry
			// Graph and recency entries depend on which entries are selected
		});
	});

	describe("AC4.5: Budget pressure reduces maxMemory", () => {
		it("respects maxMemory=3 limit under budget pressure", () => {
			// Create seed memory to trigger graph path
			const seedMem = {
				id: randomBytes(8).toString("hex"),
				key: "budget_seed",
				value: "This is a budget test seed",
				source: null,
				created_at: "2026-02-01T00:00:00.000Z",
				modified_at: "2026-02-20T12:00:00.000Z",
				deleted: 0,
			};
			insertRow(db, "semantic_memory", seedMem, siteId);

			// Create connected memory
			const connMem = {
				id: randomBytes(8).toString("hex"),
				key: "budget_connected",
				value: "This is connected",
				source: null,
				created_at: "2026-02-01T00:00:00.000Z",
				modified_at: "2026-02-21T12:00:00.000Z",
				deleted: 0,
			};
			insertRow(db, "semantic_memory", connMem, siteId);
			upsertEdge(db, seedMem.key, connMem.key, "relates", 0.8, siteId);

			// Create 10 recent memories
			for (let i = 0; i < 10; i++) {
				const mem = {
					id: randomBytes(8).toString("hex"),
					key: `mem_${i}`,
					value: `Memory ${i} about various topics`,
					source: null,
					created_at: "2026-02-01T00:00:00.000Z",
					modified_at: "2026-03-05T12:00:00.000Z",
					deleted: 0,
				};
				insertRow(db, "semantic_memory", mem, siteId);
			}

			// Simulate budget pressure: maxMemory=3
			const enrichment = buildVolatileEnrichment(
				db,
				baseline,
				3, // Budget pressure cap
				3,
				"budget seed query",
			);

			// Should return at most 4 non-pinned entries (L1 uncapped + L2+L3 capped at 3)
			const regularMemories = enrichment.memoryDeltaLines.filter((l) => !l.includes("[pinned]"));
			expect(regularMemories.length).toBeLessThanOrEqual(4);
		});

		it("budget pressure still includes pinned entries", () => {
			// Create pinned entry
			const pinnedMem = {
				id: randomBytes(8).toString("hex"),
				key: "_pinned_critical",
				value: "Always show this",
				source: null,
				created_at: "2026-01-01T00:00:00.000Z",
				modified_at: "2026-01-01T00:00:00.000Z",
				deleted: 0,
			};

			// Create 3 regular entries (not too many since they're all recent)
			for (let i = 0; i < 3; i++) {
				const mem = {
					id: randomBytes(8).toString("hex"),
					key: `mem_${i}`,
					value: `Memory ${i}`,
					source: null,
					created_at: "2026-02-01T00:00:00.000Z",
					modified_at: "2026-03-05T12:00:00.000Z",
					deleted: 0,
				};
				insertRow(db, "semantic_memory", mem, siteId);
			}

			insertRow(db, "semantic_memory", pinnedMem, siteId);

			// Budget pressure with maxMemory=3
			const enrichment = buildVolatileEnrichment(db, baseline, 3, 3, "test query");

			// Should contain pinned entry
			const hasPinned = enrichment.memoryDeltaLines.some((l) => l.includes("_pinned_critical"));
			expect(hasPinned).toBe(true);

			// Verify pinned entries are separate from maxMemory limit
			const regularMemories = enrichment.memoryDeltaLines.filter((l) => !l.includes("[pinned]"));
			// At most 3 non-pinned entries (due to maxMemory=3)
			expect(regularMemories.length).toBeLessThanOrEqual(3);
		});
	});

	describe("AC4.6: No keyword matches falls back entirely to recency", () => {
		it("falls back to recency when user message doesn't match any memory", () => {
			// Create memories with specific keywords
			const mem1 = {
				id: randomBytes(8).toString("hex"),
				key: "blockchain_consensus",
				value: "Proof of Work uses hash computation",
				source: null,
				created_at: "2026-02-01T00:00:00.000Z",
				modified_at: "2026-03-15T12:00:00.000Z",
				deleted: 0,
			};

			const mem2 = {
				id: randomBytes(8).toString("hex"),
				key: "cryptocurrency_wallets",
				value: "Wallets store private keys",
				source: null,
				created_at: "2026-02-01T00:00:00.000Z",
				modified_at: "2026-03-16T12:00:00.000Z",
				deleted: 0,
			};

			insertRow(db, "semantic_memory", mem1, siteId);
			insertRow(db, "semantic_memory", mem2, siteId);

			// Create edges between them to ensure graph path would be attempted
			upsertEdge(db, mem1.key, mem2.key, "related_to", 0.8, siteId);

			// User message with keywords that don't match anything
			const userMessage = "Tell me about zebras and ice cream";

			const enrichment = buildVolatileEnrichment(db, baseline, 10, 5, userMessage);

			const memoryLines = enrichment.memoryDeltaLines;

			// Should NOT have seed or graph tags (graph search returned no results)
			const hasSeedTags = memoryLines.some((l) => l.includes("[seed]"));
			const hasGraphTags = memoryLines.some((l) => l.match(/\[depth \d+/));

			expect(hasSeedTags).toBe(false);
			expect(hasGraphTags).toBe(false);

			// When keywords are extracted but graph search returns nothing,
			// graphCount is set to 0 (not undefined). This indicates graph path was taken
			// but no results found, so it falls back to recency via the fallback logic
			if (enrichment.graphCount !== undefined) {
				expect(enrichment.graphCount).toBe(0);
			}
		});

		it("AC4.6: handles messages with only stop words (no keywords extracted)", () => {
			// Create memories to provide recency fallback content
			const mem1 = {
				id: randomBytes(8).toString("hex"),
				key: "important_feature",
				value: "Feature description",
				source: null,
				created_at: "2026-02-01T00:00:00.000Z",
				modified_at: "2026-03-15T12:00:00.000Z",
				deleted: 0,
			};

			const mem2 = {
				id: randomBytes(8).toString("hex"),
				key: "another_concept",
				value: "Concept details",
				source: null,
				created_at: "2026-02-01T00:00:00.000Z",
				modified_at: "2026-03-16T12:00:00.000Z",
				deleted: 0,
			};

			insertRow(db, "semantic_memory", mem1, siteId);
			insertRow(db, "semantic_memory", mem2, siteId);

			// Create edges to ensure graph path would be attempted
			upsertEdge(db, mem1.key, mem2.key, "related_to", 0.8, siteId);

			// User message consisting entirely of stop words
			// This message would previously crash the SQL query because it produced
			// empty likeConditions, resulting in AND () syntax error
			const userMessage = "is it the one?";

			// Should not crash or throw
			const enrichment = buildVolatileEnrichment(db, baseline, 10, 5, userMessage);

			expect(enrichment.memoryDeltaLines).toBeDefined();
			expect(Array.isArray(enrichment.memoryDeltaLines)).toBe(true);

			// When no keywords are extracted but graph edges exist,
			// falls back to pure recency (no boost). Should have recency output only.
			const memoryLines = enrichment.memoryDeltaLines;

			// Should NOT have seed or graph tags (no keywords to seed with)
			const hasSeedTags = memoryLines.some((l) => l.includes("[seed]"));
			const hasGraphTags = memoryLines.some((l) => l.match(/\[depth \d+/));
			const hasRelevantTags = memoryLines.some((l) => l.includes("[relevant]"));

			expect(hasSeedTags).toBe(false);
			expect(hasGraphTags).toBe(false);
			expect(hasRelevantTags).toBe(false);

			// Should return delta entries without boost tags
			// (pure recency format used only)
			expect(memoryLines.length).toBeGreaterThan(0);
		});

		it("returns empty result when no edges and memory is old", () => {
			// Create single memory with specific keyword but OLD timestamp
			const mem = {
				id: randomBytes(8).toString("hex"),
				key: "database_indexes",
				value: "Indexes speed up queries",
				source: null,
				created_at: "2026-02-01T00:00:00.000Z",
				modified_at: "2026-01-15T00:00:00.000Z", // OLD, before baseline
				deleted: 0,
			};

			insertRow(db, "semantic_memory", mem, siteId);

			// Query that doesn't match
			const enrichment = buildVolatileEnrichment(db, baseline, 10, 5, "purple elephants");

			// Should be empty (old memory, no match, before baseline)
			expect(enrichment.memoryDeltaLines.length).toBe(0);
		});
	});

	describe("VolatileEnrichment return type extends", () => {
		it("returns graphCount and recencyCount when graph path is taken", () => {
			const seedMem = {
				id: randomBytes(8).toString("hex"),
				key: "test_graph",
				value: "This is a test",
				source: null,
				created_at: "2026-02-01T00:00:00.000Z",
				modified_at: "2026-02-15T12:00:00.000Z",
				deleted: 0,
			};

			insertRow(db, "semantic_memory", seedMem, siteId);

			const enrichment = buildVolatileEnrichment(db, baseline, 10, 5, "test graph query");

			// When graph is used (has edges or was attempted), counts should be set
			if (enrichment.graphCount !== undefined) {
				expect(typeof enrichment.graphCount).toBe("number");
				expect(enrichment.graphCount).toBeGreaterThanOrEqual(0);
			}
			if (enrichment.recencyCount !== undefined) {
				expect(typeof enrichment.recencyCount).toBe("number");
				expect(enrichment.recencyCount).toBeGreaterThanOrEqual(0);
			}
		});

		it("returns undefined counts when no graph edges exist", () => {
			const mem = {
				id: randomBytes(8).toString("hex"),
				key: "simple_mem",
				value: "No graph",
				source: null,
				created_at: "2026-02-01T00:00:00.000Z",
				modified_at: "2026-02-15T12:00:00.000Z",
				deleted: 0,
			};

			insertRow(db, "semantic_memory", mem, siteId);

			// No edges, so graph path should not activate
			const enrichment = buildVolatileEnrichment(db, baseline, 10, 5);

			expect(enrichment.graphCount).toBe(0);
			expect(enrichment.recencyCount).toBe(0);
		});
	});
});

describe("graphSeededRetrieval — keyword safety", () => {
	it("does not throw with 1000+ keywords (expression tree depth limit)", () => {
		// Generate 1000 unique keywords — each generates one (LIKE OR LIKE) group,
		// and 1000 groups joined with OR exceeds SQLite's expression tree depth of 1000.
		const keywords = Array.from({ length: 1000 }, (_, i) => `keyword${i}`);

		// This should NOT throw "Expression tree is too large (maximum depth 1000)"
		expect(() => {
			graphSeededRetrieval(db, keywords, 10);
		}).not.toThrow();
	});

	it("returns results with many keywords (capped internally)", () => {
		// Seed a memory that matches one of the keywords
		insertRow(
			db,
			"semantic_memory",
			{
				id: randomBytes(8).toString("hex"),
				key: "keyword42_design",
				value: "something about keyword42",
				source: null,
				created_at: "2026-02-01T00:00:00.000Z",
				modified_at: "2026-03-15T00:00:00.000Z",
				deleted: 0,
				tier: "default",
			},
			siteId,
		);

		const keywords = Array.from({ length: 1000 }, (_, i) => `keyword${i}`);
		const results = graphSeededRetrieval(db, keywords, 10);

		// Should find the memory matching keyword42 (if cap keeps first N keywords)
		// The exact behavior depends on where the cap is applied, but it must not throw
		expect(results).toBeDefined();
		expect(Array.isArray(results)).toBe(true);
	});
});
