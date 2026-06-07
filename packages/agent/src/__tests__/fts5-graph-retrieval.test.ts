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
	dbPath = join(tmpdir(), `bound-fts5-graph-${randomBytes(4).toString("hex")}.db`);
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

describe("FTS5-based graph-seeded retrieval", () => {
	describe("seed finding via FTS5 MATCH", () => {
		it("finds seeds using porter stemming (scheduled matches scheduler)", () => {
			insertRow(
				db,
				"semantic_memory",
				{
					id: randomBytes(8).toString("hex"),
					key: "task_scheduler",
					value: "The scheduler processes cron jobs for recurring execution",
					source: null,
					created_at: "2026-02-01T00:00:00.000Z",
					modified_at: "2026-03-15T12:00:00.000Z",
					deleted: 0,
					tier: "default",
				},
				siteId,
			);

			// "scheduled" should stem-match "scheduler"
			const results = graphSeededRetrieval(db, ["scheduled"], 10);
			expect(results.length).toBeGreaterThan(0);
			expect(results[0].key).toBe("task_scheduler");
		});

		it("finds seeds with short keywords like AI", () => {
			insertRow(
				db,
				"semantic_memory",
				{
					id: randomBytes(8).toString("hex"),
					key: "ai_routing",
					value: "AI model routing supports Bedrock and Ollama",
					source: null,
					created_at: "2026-02-01T00:00:00.000Z",
					modified_at: "2026-03-15T12:00:00.000Z",
					deleted: 0,
					tier: "default",
				},
				siteId,
			);

			// "AI" was previously dropped by the length >= 3 filter
			const results = graphSeededRetrieval(db, ["ai"], 10);
			expect(results.length).toBeGreaterThan(0);
			expect(results[0].key).toBe("ai_routing");
		});

		it("preserves existing graph traversal from FTS5-found seeds", () => {
			const memA = {
				id: randomBytes(8).toString("hex"),
				key: "sync_design",
				value: "The synchronization protocol uses Ed25519 signatures",
				source: null,
				created_at: "2026-02-01T00:00:00.000Z",
				modified_at: "2026-03-15T12:00:00.000Z",
				deleted: 0,
				tier: "default",
			};

			const memB = {
				id: randomBytes(8).toString("hex"),
				key: "crypto_keys",
				value: "Ed25519 keypair generation for host identity",
				source: null,
				created_at: "2026-02-01T00:00:00.000Z",
				modified_at: "2026-03-10T12:00:00.000Z",
				deleted: 0,
				tier: "default",
			};

			insertRow(db, "semantic_memory", memA, siteId);
			insertRow(db, "semantic_memory", memB, siteId);
			upsertEdge(db, memA.key, memB.key, "informs", 0.8, siteId);

			// "synchronizing" should stem-match "synchronization" in memA via FTS5
			const results = graphSeededRetrieval(db, ["synchronizing"], 10);

			expect(results.length).toBe(2);
			const keys = results.map((r) => r.key);
			expect(keys).toContain("sync_design");
			expect(keys).toContain("crypto_keys");
			// Verify traversal metadata
			const traversed = results.find((r) => r.key === "crypto_keys");
			expect(traversed?.retrievalMethod).toBe("graph");
			expect(traversed?.depth).toBe(1);
		});

		it("respects excludeKeys for L2 stage filtering", () => {
			insertRow(
				db,
				"semantic_memory",
				{
					id: randomBytes(8).toString("hex"),
					key: "pinned_entry",
					value: "This is a pinned instruction about networking",
					source: null,
					created_at: "2026-02-01T00:00:00.000Z",
					modified_at: "2026-03-15T12:00:00.000Z",
					deleted: 0,
					tier: "pinned",
				},
				siteId,
			);

			insertRow(
				db,
				"semantic_memory",
				{
					id: randomBytes(8).toString("hex"),
					key: "default_networking",
					value: "Networking configuration for WebSocket sync",
					source: null,
					created_at: "2026-02-01T00:00:00.000Z",
					modified_at: "2026-03-15T12:00:00.000Z",
					deleted: 0,
					tier: "default",
				},
				siteId,
			);

			// With excludeKeys (L2 mode), pinned entries should be excluded
			const excludeKeys = new Set(["pinned_entry"]);
			const results = graphSeededRetrieval(db, ["networking"], 10, 2, excludeKeys);

			const keys = results.map((r) => r.key);
			expect(keys).not.toContain("pinned_entry");
			expect(keys).toContain("default_networking");
		});

		it("surfaces a keyword-relevant non-orphan detail per-turn (R-VC27)", () => {
			// A summary parent that is already rendered in the stable prefix
			// (so its key rides in excludeKeys), and a detail child reachable
			// from it via a `summarizes` edge. The detail directly matches the
			// turn's keyword. Before R-VC27 the L2 tier clamp dropped this
			// detail (non-orphan: it has a summarizes parent), so the most
			// keyword-relevant entry in the cluster never surfaced per-turn.
			insertRow(
				db,
				"semantic_memory",
				{
					id: randomBytes(8).toString("hex"),
					key: "graphite_summary",
					value: "Summary of graphite rendering pipeline work",
					source: null,
					created_at: "2026-02-01T00:00:00.000Z",
					modified_at: "2026-03-15T12:00:00.000Z",
					deleted: 0,
					tier: "summary",
				},
				siteId,
			);

			insertRow(
				db,
				"semantic_memory",
				{
					id: randomBytes(8).toString("hex"),
					key: "graphite_detail",
					value: "Detailed graphite tessellation algorithm and edge cases",
					source: null,
					created_at: "2026-02-01T00:00:00.000Z",
					modified_at: "2026-03-15T12:00:00.000Z",
					deleted: 0,
					tier: "detail",
				},
				siteId,
			);

			// summarizes: parent summary -> child detail (makes the detail non-orphan)
			upsertEdge(db, "graphite_summary", "graphite_detail", "summarizes", 1.0, siteId);

			// The summary is in the stable prefix already, so it rides in excludeKeys.
			const excludeKeys = new Set(["graphite_summary"]);
			const results = graphSeededRetrieval(db, ["tessellation"], 10, 2, excludeKeys);

			const keys = results.map((r) => r.key);
			// The detail must surface — it is the most keyword-relevant entry and
			// is NOT itself in the stable prefix.
			expect(keys).toContain("graphite_detail");
			// The summary stays deduped against the stable prefix via excludeKeys.
			expect(keys).not.toContain("graphite_summary");
		});

		it("excludes _internal. prefix entries from seeds", () => {
			insertRow(
				db,
				"semantic_memory",
				{
					id: randomBytes(8).toString("hex"),
					key: "_internal.cache_hit_count",
					value: "cache metrics and statistics",
					source: null,
					created_at: "2026-02-01T00:00:00.000Z",
					modified_at: "2026-03-15T12:00:00.000Z",
					deleted: 0,
					tier: "default",
				},
				siteId,
			);

			insertRow(
				db,
				"semantic_memory",
				{
					id: randomBytes(8).toString("hex"),
					key: "cache_strategy",
					value: "Cache invalidation strategy for prompt caching",
					source: null,
					created_at: "2026-02-01T00:00:00.000Z",
					modified_at: "2026-03-15T12:00:00.000Z",
					deleted: 0,
					tier: "default",
				},
				siteId,
			);

			const results = graphSeededRetrieval(db, ["cache"], 10);
			const keys = results.map((r) => r.key);
			expect(keys).not.toContain("_internal.cache_hit_count");
			expect(keys).toContain("cache_strategy");
		});

		it("handles empty keywords gracefully", () => {
			const results = graphSeededRetrieval(db, [], 10);
			expect(results).toEqual([]);
		});

		it("handles large keyword lists without crashing", () => {
			insertRow(
				db,
				"semantic_memory",
				{
					id: randomBytes(8).toString("hex"),
					key: "keyword42_entry",
					value: "entry matching keyword42 specifically",
					source: null,
					created_at: "2026-02-01T00:00:00.000Z",
					modified_at: "2026-03-15T12:00:00.000Z",
					deleted: 0,
					tier: "default",
				},
				siteId,
			);

			// Generate 1000 keywords (old approach hit SQLite expression depth limit)
			const keywords = Array.from({ length: 1000 }, (_, i) => `keyword${i}`);
			const results = graphSeededRetrieval(db, keywords, 10);
			// Should not throw — FTS5 handles this natively without OR-chaining
			expect(results).toBeDefined();
			expect(Array.isArray(results)).toBe(true);
		});
	});

	describe("buildVolatileEnrichment with FTS5", () => {
		it("surfaces memories via stemmed keywords from user message", () => {
			insertRow(
				db,
				"semantic_memory",
				{
					id: randomBytes(8).toString("hex"),
					key: "deployment_process",
					value: "Deploying requires building the binary and copying to hosts",
					source: null,
					created_at: "2026-02-01T00:00:00.000Z",
					modified_at: "2026-03-15T12:00:00.000Z",
					deleted: 0,
					tier: "default",
				},
				siteId,
			);

			// "deployed" should stem-match "deploying"/"deployment" via FTS5
			const enrichment = buildVolatileEnrichment(
				db,
				baseline,
				10,
				5,
				"I just deployed the new version",
			);

			const memoryText = enrichment.memoryDeltaLines.join("\n");
			expect(memoryText).toContain("deployment_process");
		});

		it("surfaces memories with short keywords that old approach missed", () => {
			insertRow(
				db,
				"semantic_memory",
				{
					id: randomBytes(8).toString("hex"),
					key: "go_project",
					value: "Go project uses standard library for HTTP server",
					source: null,
					created_at: "2026-02-01T00:00:00.000Z",
					modified_at: "2026-03-15T12:00:00.000Z",
					deleted: 0,
					tier: "default",
				},
				siteId,
			);

			// "Go" is 2 chars — was previously dropped by length >= 3 filter
			const enrichment = buildVolatileEnrichment(
				db,
				baseline,
				10,
				5,
				"How do I set up the Go project?",
			);

			const memoryText = enrichment.memoryDeltaLines.join("\n");
			expect(memoryText).toContain("go_project");
		});
	});
});
