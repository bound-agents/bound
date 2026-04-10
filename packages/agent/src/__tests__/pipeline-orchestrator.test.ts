import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { randomBytes } from "node:crypto";
import { unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applySchema, createDatabase, insertRow } from "@bound/core";
import { buildVolatileEnrichment, loadPinnedEntries, loadSummaryEntries, loadGraphEntries, loadRecencyEntries } from "../summary-extraction.js";

let db: Database;
let dbPath: string;
let siteId: string;

beforeEach(() => {
	dbPath = join(tmpdir(), `bound-test-${randomBytes(4).toString("hex")}.db`);
	db = createDatabase(dbPath);
	applySchema(db);
	siteId = randomBytes(8).toString("hex");
});

afterEach(() => {
	db.close();
	try {
		unlinkSync(dbPath);
	} catch {
		/* ignore */
	}
});

describe("buildVolatileEnrichment pipeline orchestration", () => {
	/**
	 * AC4.1: Zero summaries produces identical output to current system
	 * When there are no summary-tier entries, the function should behave exactly
	 * like before: L0 (pinned) + L2 (graph-seeded) + L3 (recency) with no L1.
	 */
	it("AC4.1: Zero summaries produces identical output", () => {
		const baseline = "2026-03-15T00:00:00.000Z";

		// Create 3 pinned entries
		for (let i = 1; i <= 3; i++) {
			insertRow(
				db,
				"semantic_memory",
				{
					id: randomBytes(8).toString("hex"),
					key: `_pinned_rule${i}`,
					value: `Policy rule ${i}`,
					source: null,
					created_at: "2026-03-20T12:00:00.000Z",
					modified_at: "2026-03-20T12:00:00.000Z",
					deleted: 0,
					tier: "pinned",
				},
				siteId
			);
		}

		// Create 5 default entries (no summaries, no special tier)
		for (let i = 1; i <= 5; i++) {
			insertRow(
				db,
				"semantic_memory",
				{
					id: randomBytes(8).toString("hex"),
					key: `entry_${i}`,
					value: `Content ${i}`,
					source: null,
					created_at: `2026-03-${20 + i}T12:00:00.000Z`,
					modified_at: `2026-03-${20 + i}T12:00:00.000Z`,
					deleted: 0,
					tier: "default",
				},
				siteId
			);
		}

		// Build enrichment
		const result = buildVolatileEnrichment(db, baseline, 5, 5);

		// Verify tiers object exists
		expect(result.tiers).toBeDefined();
		expect(result.tiers?.L0).toBeDefined();
		expect(result.tiers?.L1).toBeDefined();
		expect(result.tiers?.L2).toBeDefined();
		expect(result.tiers?.L3).toBeDefined();

		// Verify L0 has pinned entries
		expect(result.tiers?.L0.length).toBe(3);
		expect(result.tiers?.L0[0].tag).toBe("[pinned]");

		// Verify L1 is empty (no summaries)
		expect(result.tiers?.L1.length).toBe(0);

		// Verify memoryDeltaLines starts with pinned entries
		expect(result.memoryDeltaLines[0]).toMatch(/\[pinned\]/);
		expect(result.memoryDeltaLines[1]).toMatch(/\[pinned\]/);
		expect(result.memoryDeltaLines[2]).toMatch(/\[pinned\]/);
	});

	/**
	 * AC4.2: Summaries with clean children exclude children from L2/L3
	 * Create a summary with 2 child entries (both non-stale).
	 * Children should appear in L1 (via summary edges) but NOT in L2/L3 (excluded).
	 */
	it("AC4.2: Summaries with clean children exclude children from L2/L3", () => {
		const baseline = "2026-03-15T00:00:00.000Z";
		const summaryKey = "summary_main";
		const childKey1 = "child_entry_1";
		const childKey2 = "child_entry_2";

		// Create a summary entry
		insertRow(
			db,
			"semantic_memory",
			{
				id: randomBytes(8).toString("hex"),
				key: summaryKey,
				value: "Summary of important context",
				source: null,
				created_at: "2026-03-20T12:00:00.000Z",
				modified_at: "2026-03-20T12:00:00.000Z",
				deleted: 0,
				tier: "summary",
			},
			siteId
		);

		// Create 2 child entries (non-stale: modified_at <= summary modified_at)
		insertRow(
			db,
			"semantic_memory",
			{
				id: randomBytes(8).toString("hex"),
				key: childKey1,
				value: "Child entry 1",
				source: null,
				created_at: "2026-03-19T12:00:00.000Z",
				modified_at: "2026-03-19T12:00:00.000Z", // before summary
				deleted: 0,
				tier: "detail",
			},
			siteId
		);

		insertRow(
			db,
			"semantic_memory",
			{
				id: randomBytes(8).toString("hex"),
				key: childKey2,
				value: "Child entry 2",
				source: null,
				created_at: "2026-03-20T10:00:00.000Z",
				modified_at: "2026-03-20T10:00:00.000Z", // before summary
				deleted: 0,
				tier: "detail",
			},
			siteId
		);

		// Create summarizes edges
		insertRow(
			db,
			"memory_edges",
			{
				id: randomBytes(8).toString("hex"),
				source_key: summaryKey,
				target_key: childKey1,
				relation: "summarizes",
				created_at: "2026-03-20T12:00:00.000Z",
				modified_at: "2026-03-20T12:00:00.000Z",
				deleted: 0,
			},
			siteId
		);

		insertRow(
			db,
			"memory_edges",
			{
				id: randomBytes(8).toString("hex"),
				source_key: summaryKey,
				target_key: childKey2,
				relation: "summarizes",
				created_at: "2026-03-20T12:00:00.000Z",
				modified_at: "2026-03-20T12:00:00.000Z",
				deleted: 0,
			},
			siteId
		);

		const result = buildVolatileEnrichment(db, baseline, 25, 5);

		// Verify L1 has the summary (no L0 in this test)
		expect(result.tiers?.L1.length).toBeGreaterThan(0);
		const summaryEntry = result.tiers?.L1.find((e) => e.key === summaryKey);
		expect(summaryEntry).toBeDefined();

		// Verify L1 has the children with [stale-detail] tag (they are non-stale so should NOT be in L1)
		// Actually, non-stale children should NOT appear in L1 output (only stale ones do)
		const child1L1 = result.tiers?.L1.find((e) => e.key === childKey1);
		const child2L1 = result.tiers?.L1.find((e) => e.key === childKey2);
		expect(child1L1).toBeUndefined();
		expect(child2L1).toBeUndefined();

		// Verify children are NOT in L2 or L3 (they're excluded after L1)
		const child1L2 = result.tiers?.L2.find((e) => e.key === childKey1);
		const child2L2 = result.tiers?.L2.find((e) => e.key === childKey2);
		const child1L3 = result.tiers?.L3.find((e) => e.key === childKey1);
		const child2L3 = result.tiers?.L3.find((e) => e.key === childKey2);

		expect(child1L2).toBeUndefined();
		expect(child2L2).toBeUndefined();
		expect(child1L3).toBeUndefined();
		expect(child2L3).toBeUndefined();
	});

	/**
	 * AC4.3: Summaries with stale children: annotated summary + stale children in L1
	 * Create a summary with a stale child (modified after the summary).
	 * Output should include summary + stale child in L1 with [stale-detail] tag.
	 */
	it("AC4.3: Summaries with stale children: annotated summary + stale children in L1", () => {
		const baseline = "2026-03-15T00:00:00.000Z";
		const summaryKey = "summary_main";
		const staleChildKey = "stale_child";

		// Create a summary entry at T1
		insertRow(
			db,
			"semantic_memory",
			{
				id: randomBytes(8).toString("hex"),
				key: summaryKey,
				value: "Summary of important context",
				source: null,
				created_at: "2026-03-20T12:00:00.000Z",
				modified_at: "2026-03-20T12:00:00.000Z",
				deleted: 0,
				tier: "summary",
			},
			siteId
		);

		// Create a stale child entry (modified after the summary at T2)
		insertRow(
			db,
			"semantic_memory",
			{
				id: randomBytes(8).toString("hex"),
				key: staleChildKey,
				value: "Stale detail entry",
				source: null,
				created_at: "2026-03-20T12:00:00.000Z",
				modified_at: "2026-03-20T13:00:00.000Z", // AFTER summary
				deleted: 0,
				tier: "detail",
			},
			siteId
		);

		// Create summarizes edge
		insertRow(
			db,
			"memory_edges",
			{
				id: randomBytes(8).toString("hex"),
				source_key: summaryKey,
				target_key: staleChildKey,
				relation: "summarizes",
				created_at: "2026-03-20T12:00:00.000Z",
				modified_at: "2026-03-20T12:00:00.000Z",
				deleted: 0,
			},
			siteId
		);

		const result = buildVolatileEnrichment(db, baseline, 25, 5);

		// Verify L1 contains the summary
		expect(result.tiers?.L1.length).toBeGreaterThan(0);
		const summaryEntry = result.tiers?.L1.find((e) => e.key === summaryKey);
		expect(summaryEntry).toBeDefined();
		expect(summaryEntry?.tag).toBe("[summary]");

		// Verify L1 contains the stale child with [stale-detail] tag
		const staleChild = result.tiers?.L1.find((e) => e.key === staleChildKey);
		expect(staleChild).toBeDefined();
		expect(staleChild?.tag).toBe("[stale-detail]");

		// Verify stale child is NOT in L2 or L3 (excluded after L1)
		const staleChildL2 = result.tiers?.L2.find((e) => e.key === staleChildKey);
		const staleChildL3 = result.tiers?.L3.find((e) => e.key === staleChildKey);
		expect(staleChildL2).toBeUndefined();
		expect(staleChildL3).toBeUndefined();

		// Verify memoryDeltaLines contains summary before stale child
		const lines = result.memoryDeltaLines;
		const summaryLineIdx = lines.findIndex((l) => l.includes(summaryKey));
		const staleLineIdx = lines.findIndex((l) => l.includes(staleChildKey));
		expect(summaryLineIdx).toBeGreaterThanOrEqual(0);
		expect(staleLineIdx).toBeGreaterThanOrEqual(0);
		expect(summaryLineIdx).toBeLessThan(staleLineIdx);
		expect(lines[staleLineIdx]).toMatch(/\[stale-detail\]/);
	});

	/**
	 * AC4.4: Exclusion cascade prevents same entry appearing in multiple stages
	 * Create a pinned entry. It should only appear in L0, never in L1/L2/L3.
	 */
	it("AC4.4: Exclusion cascade prevents same entry in multiple stages", () => {
		const baseline = "2026-03-15T00:00:00.000Z";
		const pinnedKey = "_pinned_rule";

		// Create a pinned entry (via tier and prefix)
		insertRow(
			db,
			"semantic_memory",
			{
				id: randomBytes(8).toString("hex"),
				key: pinnedKey,
				value: "Critical policy",
				source: null,
				created_at: "2026-03-20T12:00:00.000Z",
				modified_at: "2026-03-20T12:00:00.000Z",
				deleted: 0,
				tier: "pinned",
			},
			siteId
		);

		const result = buildVolatileEnrichment(db, baseline, 25, 5);

		// Verify it's in L0
		const l0Entry = result.tiers?.L0.find((e) => e.key === pinnedKey);
		expect(l0Entry).toBeDefined();

		// Verify it's NOT in L1, L2, L3
		const l1Entry = result.tiers?.L1.find((e) => e.key === pinnedKey);
		const l2Entry = result.tiers?.L2.find((e) => e.key === pinnedKey);
		const l3Entry = result.tiers?.L3.find((e) => e.key === pinnedKey);

		expect(l1Entry).toBeUndefined();
		expect(l2Entry).toBeUndefined();
		expect(l3Entry).toBeUndefined();

		// Verify it appears exactly once in memoryDeltaLines
		const matchCount = result.memoryDeltaLines.filter((l) => l.includes(pinnedKey)).length;
		expect(matchCount).toBe(1);
	});

	/**
	 * AC4.5: maxMemory applies to L2+L3 combined; L0+L1 uncapped
	 * Create 2 pinned entries + 1 summary + 10 default entries.
	 * Set maxMemory=3. L0 should have 2, L1 should have 1 (uncapped).
	 * L2+L3 combined should have at most 3 entries total.
	 */
	it("AC4.5: maxMemory applies to L2+L3 combined, L0+L1 uncapped", () => {
		const baseline = "2026-03-15T00:00:00.000Z";

		// Create 2 pinned entries
		insertRow(
			db,
			"semantic_memory",
			{
				id: randomBytes(8).toString("hex"),
				key: "_pinned_1",
				value: "Pinned 1",
				source: null,
				created_at: "2026-03-20T12:00:00.000Z",
				modified_at: "2026-03-20T12:00:00.000Z",
				deleted: 0,
				tier: "pinned",
			},
			siteId
		);
		insertRow(
			db,
			"semantic_memory",
			{
				id: randomBytes(8).toString("hex"),
				key: "_pinned_2",
				value: "Pinned 2",
				source: null,
				created_at: "2026-03-20T12:00:00.000Z",
				modified_at: "2026-03-20T12:00:00.000Z",
				deleted: 0,
				tier: "pinned",
			},
			siteId
		);

		// Create 1 summary
		insertRow(
			db,
			"semantic_memory",
			{
				id: randomBytes(8).toString("hex"),
				key: "summary_1",
				value: "Summary",
				source: null,
				created_at: "2026-03-20T12:00:00.000Z",
				modified_at: "2026-03-20T12:00:00.000Z",
				deleted: 0,
				tier: "summary",
			},
			siteId
		);

		// Create 10 default entries with recent timestamps
		for (let i = 1; i <= 10; i++) {
			insertRow(
				db,
				"semantic_memory",
				{
					id: randomBytes(8).toString("hex"),
					key: `entry_${i}`,
					value: `Content ${i}`,
					source: null,
					created_at: `2026-03-${20 + i}T12:00:00.000Z`,
					modified_at: `2026-03-${20 + i}T12:00:00.000Z`,
					deleted: 0,
					tier: "default",
				},
				siteId
			);
		}

		// Set maxMemory = 3
		const result = buildVolatileEnrichment(db, baseline, 3, 5);

		// Verify L0 has 2 entries (uncapped)
		expect(result.tiers?.L0.length).toBe(2);

		// Verify L1 has 1 entry (uncapped)
		expect(result.tiers?.L1.length).toBe(1);

		// Verify L2+L3 combined have at most 3 entries
		const l2Count = result.tiers?.L2.length ?? 0;
		const l3Count = result.tiers?.L3.length ?? 0;
		const totalL23 = l2Count + l3Count;
		expect(totalL23).toBeLessThanOrEqual(3);
	});

	/**
	 * AC4.6: Entries appear in L0→L1→L2→L3 order in output
	 * Create entries in each tier and verify memoryDeltaLines has them in order.
	 */
	it("AC4.6: Entries appear in L0→L1→L2→L3 order in output", () => {
		const baseline = "2026-03-15T00:00:00.000Z";

		// Create L0: pinned
		insertRow(
			db,
			"semantic_memory",
			{
				id: randomBytes(8).toString("hex"),
				key: "_pinned_order_test",
				value: "L0 pinned",
				source: null,
				created_at: "2026-03-20T12:00:00.000Z",
				modified_at: "2026-03-20T12:00:00.000Z",
				deleted: 0,
				tier: "pinned",
			},
			siteId
		);

		// Create L1: summary
		insertRow(
			db,
			"semantic_memory",
			{
				id: randomBytes(8).toString("hex"),
				key: "summary_order_test",
				value: "L1 summary",
				source: null,
				created_at: "2026-03-20T12:00:00.000Z",
				modified_at: "2026-03-20T12:00:00.000Z",
				deleted: 0,
				tier: "summary",
			},
			siteId
		);

		// Create L2: default entry (will be retrieved via recency since no graph)
		insertRow(
			db,
			"semantic_memory",
			{
				id: randomBytes(8).toString("hex"),
				key: "entry_order_test",
				value: "L2/L3 default",
				source: null,
				created_at: "2026-03-21T12:00:00.000Z",
				modified_at: `2026-03-21T12:00:00.000Z`,
				deleted: 0,
				tier: "default",
			},
			siteId
		);

		const result = buildVolatileEnrichment(db, baseline, 25, 5);

		// Find indices in memoryDeltaLines
		const l0LineIdx = result.memoryDeltaLines.findIndex((l) => l.includes("_pinned_order_test"));
		const l1LineIdx = result.memoryDeltaLines.findIndex((l) => l.includes("summary_order_test"));
		const l23LineIdx = result.memoryDeltaLines.findIndex((l) => l.includes("entry_order_test"));

		// All should be present
		expect(l0LineIdx).toBeGreaterThanOrEqual(0);
		expect(l1LineIdx).toBeGreaterThanOrEqual(0);
		expect(l23LineIdx).toBeGreaterThanOrEqual(0);

		// Verify order: L0 < L1 < L2/L3
		expect(l0LineIdx).toBeLessThan(l1LineIdx);
		expect(l1LineIdx).toBeLessThan(l23LineIdx);
	});

	/**
	 * Additional: Verify that tiers field contains correct tier annotations
	 */
	it("Should populate tiers field with correct tier values", () => {
		const baseline = "2026-03-15T00:00:00.000Z";

		insertRow(
			db,
			"semantic_memory",
			{
				id: randomBytes(8).toString("hex"),
				key: "_pinned_test",
				value: "Pinned",
				source: null,
				created_at: "2026-03-20T12:00:00.000Z",
				modified_at: "2026-03-20T12:00:00.000Z",
				deleted: 0,
				tier: "pinned",
			},
			siteId
		);

		const result = buildVolatileEnrichment(db, baseline, 25, 5);

		// Verify tiers is defined
		expect(result.tiers).toBeDefined();

		// Verify L0 has tier annotation
		if (result.tiers?.L0.length ?? 0 > 0) {
			expect(result.tiers?.L0[0].tier).toBe("pinned");
		}
	});

	/**
	 * Backward compatibility: Ensure memoryDeltaLines format unchanged
	 */
	it("Should maintain backward-compatible memoryDeltaLines format", () => {
		const baseline = "2026-03-15T00:00:00.000Z";

		insertRow(
			db,
			"semantic_memory",
			{
				id: randomBytes(8).toString("hex"),
				key: "_pinned_format_test",
				value: "Test value",
				source: null,
				created_at: "2026-03-20T12:00:00.000Z",
				modified_at: "2026-03-20T12:00:00.000Z",
				deleted: 0,
				tier: "pinned",
			},
			siteId
		);

		const result = buildVolatileEnrichment(db, baseline, 25, 5);

		// Verify format: "- key: value [tag]"
		expect(result.memoryDeltaLines[0]).toMatch(/^- /);
		expect(result.memoryDeltaLines[0]).toMatch(/: /);
		expect(result.memoryDeltaLines[0]).toMatch(/\[pinned\]/);
	});
});
