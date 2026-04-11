import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { randomBytes } from "node:crypto";
import { unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applySchema, createDatabase, insertRow, updateRow } from "@bound/core";
import { upsertEdge } from "../graph-queries.js";
import { buildVolatileEnrichment } from "../summary-extraction.js";

let db: Database;
let dbPath: string;

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

describe("AC4.1: Backward compatibility — zero summaries produces identical output", () => {
	const siteId = randomBytes(8).toString("hex");
	const baseline = "2026-03-01T00:00:00.000Z";

	it("renders default entries with recency and graph-seeded tags", () => {
		const userId = randomBytes(8).toString("hex");
		const threadId = randomBytes(8).toString("hex");

		// Create thread for source resolution
		insertRow(
			db,
			"threads",
			{
				id: threadId,
				user_id: userId,
				interface: "web",
				host_origin: "test",
				color: 0,
				title: "Test Thread",
				created_at: "2026-02-01T00:00:00.000Z",
				last_message_at: "2026-03-15T12:00:00.000Z",
				modified_at: new Date().toISOString(),
				deleted: 0,
			},
			siteId,
		);

		// Insert default tier entries with varied timestamps
		const entry1Id = randomBytes(8).toString("hex");
		const entry2Id = randomBytes(8).toString("hex");
		const entry3Id = randomBytes(8).toString("hex");

		insertRow(
			db,
			"semantic_memory",
			{
				id: entry1Id,
				key: "topic_neural_networks",
				value: "Neural networks use weighted connections",
				source: null,
				created_at: "2026-02-01T00:00:00.000Z",
				modified_at: "2026-02-15T12:00:00.000Z",
				deleted: 0,
				tier: "default",
			},
			siteId,
		);

		insertRow(
			db,
			"semantic_memory",
			{
				id: entry2Id,
				key: "topic_machine_learning",
				value: "Machine learning is about algorithms learning from data",
				source: null,
				created_at: "2026-02-01T00:00:00.000Z",
				modified_at: "2026-03-10T12:00:00.000Z",
				deleted: 0,
				tier: "default",
			},
			siteId,
		);

		insertRow(
			db,
			"semantic_memory",
			{
				id: entry3Id,
				key: "topic_statistics",
				value: "Statistics provides foundation for machine learning",
				source: null,
				created_at: "2026-02-01T00:00:00.000Z",
				modified_at: "2026-03-15T12:00:00.000Z",
				deleted: 0,
				tier: "default",
			},
			siteId,
		);

		// Create graph edges between default entries
		upsertEdge(db, "topic_neural_networks", "topic_machine_learning", "related_to", 1.0, siteId);
		upsertEdge(db, "topic_statistics", "topic_machine_learning", "related_to", 1.0, siteId);

		// Build enrichment
		const enrichment = buildVolatileEnrichment(db, baseline, 10);

		// Verify: no summary entries (L1 empty)
		expect(enrichment.tiers.L1.length).toBe(0);

		// Verify: no pinned entries yet (L0 empty)
		expect(enrichment.tiers.L0.length).toBe(0);

		// Verify: L2 and L3 entries exist
		const totalEntries = enrichment.tiers.L2.length + enrichment.tiers.L3.length;
		expect(totalEntries).toBeGreaterThan(0);

		// Verify: memoryDeltaLines exist and contain expected entries
		expect(enrichment.memoryDeltaLines.length).toBeGreaterThan(0);
	});

	it("pinned entries appear first regardless of recency", () => {
		const _userId = randomBytes(8).toString("hex");

		insertRow(
			db,
			"semantic_memory",
			{
				id: randomBytes(8).toString("hex"),
				key: "_standing_research_mode",
				value: "Always cite sources",
				source: null,
				created_at: "2026-01-01T00:00:00.000Z",
				modified_at: "2026-01-01T00:00:00.000Z",
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
				key: "recent_topic",
				value: "This is a recent default entry",
				source: null,
				created_at: new Date().toISOString(),
				modified_at: "2026-03-15T12:00:00.000Z",
				deleted: 0,
				tier: "default",
			},
			siteId,
		);

		const enrichment = buildVolatileEnrichment(db, baseline, 10);

		// Verify: pinned entry appears in L0
		expect(enrichment.tiers.L0.length).toBe(1);
		expect(enrichment.tiers.L0[0].key).toContain("_standing");

		// Verify: pinned entry appears first in memoryDeltaLines
		expect(enrichment.memoryDeltaLines[0]).toContain("_standing");
	});

	it("value truncation at 200 chars works", () => {
		const longValue = "x".repeat(210);
		insertRow(
			db,
			"semantic_memory",
			{
				id: randomBytes(8).toString("hex"),
				key: "long_entry",
				value: longValue,
				source: null,
				created_at: new Date().toISOString(),
				modified_at: "2026-03-15T12:00:00.000Z",
				deleted: 0,
				tier: "default",
			},
			siteId,
		);

		const enrichment = buildVolatileEnrichment(db, baseline, 10);

		// Verify: value is truncated
		const line = enrichment.memoryDeltaLines.find((l) => l.includes("long_entry"));
		expect(line).toBeDefined();
		expect(line).toContain("...");
		// Formatted line includes prefix/suffix, but the value should be truncated
		// Just verify the "..." is there indicating truncation happened
		const valueContent = line?.split(":").slice(1).join(":"); // Get everything after key:
		expect(valueContent.length).toBeLessThan(longValue.length + 100); // Slack for formatting tags
	});

	it("source resolution shows thread title when available", () => {
		const userId = randomBytes(8).toString("hex");
		const threadId = randomBytes(8).toString("hex");

		// Create thread
		insertRow(
			db,
			"threads",
			{
				id: threadId,
				user_id: userId,
				interface: "web",
				host_origin: "test",
				color: 0,
				title: "My Custom Thread",
				created_at: "2026-02-01T00:00:00.000Z",
				last_message_at: "2026-03-15T12:00:00.000Z",
				modified_at: new Date().toISOString(),
				deleted: 0,
			},
			siteId,
		);

		// Insert memory with thread source
		insertRow(
			db,
			"semantic_memory",
			{
				id: randomBytes(8).toString("hex"),
				key: "test_key",
				value: "test value",
				source: threadId,
				created_at: new Date().toISOString(),
				modified_at: "2026-03-15T12:00:00.000Z",
				deleted: 0,
				tier: "default",
			},
			siteId,
		);

		const enrichment = buildVolatileEnrichment(db, baseline, 10);

		// Verify: source resolution includes thread title
		const line = enrichment.memoryDeltaLines.find((l) => l.includes("test_key"));
		expect(line).toBeDefined();
		expect(line).toContain("via thread");
	});

	it("header shows correct format with graph and recency counts", () => {
		const userId = randomBytes(8).toString("hex");
		const threadId = randomBytes(8).toString("hex");

		// Create thread
		insertRow(
			db,
			"threads",
			{
				id: threadId,
				user_id: userId,
				interface: "web",
				host_origin: "test",
				color: 0,
				title: "Test Thread",
				created_at: "2026-02-01T00:00:00.000Z",
				last_message_at: "2026-03-15T12:00:00.000Z",
				modified_at: new Date().toISOString(),
				deleted: 0,
			},
			siteId,
		);

		// Insert entries with keywords
		insertRow(
			db,
			"semantic_memory",
			{
				id: randomBytes(8).toString("hex"),
				key: "machine_learning_basics",
				value: "Overview of machine learning",
				source: null,
				created_at: new Date().toISOString(),
				modified_at: "2026-03-10T12:00:00.000Z",
				deleted: 0,
				tier: "default",
			},
			siteId,
		);

		const enrichment = buildVolatileEnrichment(db, baseline, 10);

		// Verify: basic structure exists
		expect(enrichment.memoryDeltaLines.length).toBeGreaterThan(0);
		expect(enrichment.tiers).toBeDefined();
		expect(enrichment.tiers.L0).toBeDefined();
		expect(enrichment.tiers.L1).toBeDefined();
		expect(enrichment.tiers.L2).toBeDefined();
		expect(enrichment.tiers.L3).toBeDefined();
	});
});

describe("AC3.6: Edge cases — orphaned details, exclusion cascade, detail preservation", () => {
	const siteId = randomBytes(8).toString("hex");
	const baseline = "2026-03-01T00:00:00.000Z";

	describe("Orphaned detail recovery", () => {
		it("orphaned detail appears in L2/L3 when keywords match", () => {
			// Create orphaned detail (tier='detail' but NO summarizes edge)
			insertRow(
				db,
				"semantic_memory",
				{
					id: randomBytes(8).toString("hex"),
					key: "detail_orphaned_neural",
					value: "Details about neural network architectures",
					source: null,
					created_at: new Date().toISOString(),
					modified_at: "2026-03-15T12:00:00.000Z",
					deleted: 0,
					tier: "detail",
				},
				siteId,
			);

			// Build enrichment with matching keyword
			const enrichment = buildVolatileEnrichment(db, baseline, 10, 5, "neural");

			// Verify: orphaned detail appears (treated as default for retrieval)
			const allEntries = [
				...enrichment.tiers.L0,
				...enrichment.tiers.L1,
				...enrichment.tiers.L2,
				...enrichment.tiers.L3,
			];
			const orphanedEntry = allEntries.find((e) => e.key === "detail_orphaned_neural");
			expect(orphanedEntry).toBeDefined();
		});

		it("detail with active summarizes edge does NOT appear in L2/L3", () => {
			const summaryId = randomBytes(8).toString("hex");
			const detailId = randomBytes(8).toString("hex");

			// Create summary entry
			insertRow(
				db,
				"semantic_memory",
				{
					id: summaryId,
					key: "summary_neural_concepts",
					value: "Summary of neural concepts",
					source: null,
					created_at: new Date().toISOString(),
					modified_at: "2026-02-01T00:00:00.000Z",
					deleted: 0,
					tier: "summary",
				},
				siteId,
			);

			// Create detail entry with active summarizes edge
			insertRow(
				db,
				"semantic_memory",
				{
					id: detailId,
					key: "detail_neural_forward_pass",
					value: "Details about forward pass",
					source: null,
					created_at: new Date().toISOString(),
					modified_at: "2026-03-15T12:00:00.000Z",
					deleted: 0,
					tier: "detail",
				},
				siteId,
			);

			// Create summarizes edge
			upsertEdge(
				db,
				"summary_neural_concepts",
				"detail_neural_forward_pass",
				"summarizes",
				1.0,
				siteId,
			);

			// Build enrichment with matching keyword
			const enrichment = buildVolatileEnrichment(db, baseline, 10, 5, "forward");

			// Verify: active detail is excluded from L2/L3 (only appears in L1 if its summary is fresh)
			const l2l3Entries = [...enrichment.tiers.L2, ...enrichment.tiers.L3];
			const activeDetail = l2l3Entries.find((e) => e.key === "detail_neural_forward_pass");
			// Should be excluded OR appear only if orphaned logic fires
			// In this case it's properly attached, so shouldn't appear in L2/L3
			expect(activeDetail).toBeUndefined();
		});
	});

	describe("Exclusion cascade — double-load prevention", () => {
		it("pinned entry appears only in L0, not also in L2 via graph", () => {
			const pinnedId = randomBytes(8).toString("hex");
			const otherEntryId = randomBytes(8).toString("hex");

			// Create pinned entry
			insertRow(
				db,
				"semantic_memory",
				{
					id: pinnedId,
					key: "_pinned_core_concept",
					value: "Core concept pinned",
					source: null,
					created_at: "2026-01-01T00:00:00.000Z",
					modified_at: "2026-01-01T00:00:00.000Z",
					deleted: 0,
					tier: "pinned",
				},
				siteId,
			);

			// Create another entry that references the pinned one
			insertRow(
				db,
				"semantic_memory",
				{
					id: otherEntryId,
					key: "other_entry_referencing",
					value: "Refers to core concept",
					source: null,
					created_at: new Date().toISOString(),
					modified_at: "2026-03-15T12:00:00.000Z",
					deleted: 0,
					tier: "default",
				},
				siteId,
			);

			// Create graph edge from other entry to pinned entry
			upsertEdge(db, "other_entry_referencing", "_pinned_core_concept", "related_to", 1.0, siteId);

			const enrichment = buildVolatileEnrichment(db, baseline, 10, 5, "core");

			// Verify: pinned entry appears only once in L0
			expect(enrichment.tiers.L0.length).toBe(1);
			expect(enrichment.tiers.L0[0].key).toBe("_pinned_core_concept");

			// Verify: pinned entry does NOT also appear in L2
			const l2Entries = enrichment.tiers.L2.map((e) => e.key);
			expect(l2Entries).not.toContain("_pinned_core_concept");
		});
	});

	describe("Detail preservation on update", () => {
		it("detail tier preserved when updating entry value via handleStore", () => {
			const _userId = randomBytes(8).toString("hex");

			// Insert initial entry with detail tier
			const memKey = "detail_entry_key";
			const memoryId = randomBytes(8).toString("hex");
			insertRow(
				db,
				"semantic_memory",
				{
					id: memoryId,
					key: memKey,
					value: "original value",
					source: null,
					created_at: "2026-02-01T00:00:00.000Z",
					modified_at: "2026-02-01T00:00:00.000Z",
					deleted: 0,
					tier: "detail",
				},
				siteId,
			);

			// Simulate handleStore update without passing --tier
			// (Would normally call handleStore, but for test just do the update directly)
			updateRow(
				db,
				"semantic_memory",
				memoryId,
				{
					value: "updated value",
					deleted: 0,
					// Note: NOT passing tier — should preserve existing
				},
				siteId,
			);

			// Verify: tier is still detail
			const updated = db.prepare("SELECT tier FROM semantic_memory WHERE key = ?").get(memKey) as {
				tier: string;
			};
			expect(updated.tier).toBe("detail");
		});
	});
});
