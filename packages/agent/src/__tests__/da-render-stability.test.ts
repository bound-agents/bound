/**
 * Discoverable Archive render stability (volatile-prefix churn + token fix).
 *
 * Root cause established by attribution over live `turns` data: `last_accessed_at`
 * leaked into the rendered stable bytes TWO ways —
 *   1. the per-line `(accessed YYYY-MM-DD)` suffix, and
 *   2. the within-cluster line ORDER (rendered last_accessed_at DESC).
 * `bumpRenderedDetailEntries` rewrites `last_accessed_at` on every cold assembly
 * (debounced 1h/entry), so a partial bump both flips the date and reorders lines,
 * changing the cached `systemPrompt` bytes for no information change.
 *
 * The fix renders the DA as a pure function of {keys, cluster structure, tier}:
 * lines are key-sorted and carry no date. `last_accessed_at` survives ONLY as the
 * Tier-3 selection key (which M entries per cluster). These tests pin that the
 * rendered output is invariant to `last_accessed_at` for a fixed key set + tier.
 */

import { describe, expect, it } from "bun:test";
import {
	type DetailEntry,
	type DiscoverableArchiveInput,
	renderDiscoverableArchive,
} from "../summary-extraction";

function da(entries: DetailEntry[], extra?: Partial<DiscoverableArchiveInput>): string {
	return renderDiscoverableArchive({
		entries,
		parentSummaryByKey: new Map(),
		staleChildKeysInWorkingKnowledge: new Set(),
		budgetPressure: false,
		tunables: { n: 1000, m: 20 },
		...extra,
	}).section.lines.join("\n");
}

describe("Discoverable Archive — render stability under last_accessed_at churn", () => {
	it("renders detail lines as bare `- <key>` with no date suffix", () => {
		const out = da([{ key: "adapter:foo", last_accessed_at: "2026-05-30T10:00:00Z" }]);
		const detailLines = out.split("\n").filter((l) => l.startsWith("- "));
		expect(detailLines).toEqual(["- adapter:foo"]);
		// The rendered entry line carries no access date (the footer's prose
		// "accessed via memory search" is unrelated; assert on the line itself).
		expect(detailLines[0]).not.toContain("accessed");
		expect(detailLines[0]).not.toContain("2026-05-30");
	});

	it("Tier 1 output is identical regardless of last_accessed_at values (no date, no reorder)", () => {
		const keys = ["charlie:z", "alpha:a", "bravo:m"];
		// Two wildly different access-time assignments, same key set.
		const v1 = da(
			keys.map((k, i) => ({ key: k, last_accessed_at: `2026-05-${10 + i}T00:00:00Z` })),
		);
		const v2 = da(
			keys.map((k, i) => ({ key: k, last_accessed_at: `2026-01-${28 - i}T00:00:00Z` })),
		);
		const v3 = da(keys.map((k) => ({ key: k, last_accessed_at: null })));
		expect(v1).toBe(v2);
		expect(v1).toBe(v3);
	});

	it("Tier 1 lines are key-sorted (ASC), not access-time-sorted", () => {
		const out = da([
			{ key: "zebra", last_accessed_at: "2026-05-30T10:00:00Z" }, // newest
			{ key: "apple", last_accessed_at: "2026-01-01T00:00:00Z" }, // oldest
			{ key: "mango", last_accessed_at: "2026-03-15T00:00:00Z" },
		]);
		const lines = out.split("\n").filter((l) => l.startsWith("- "));
		expect(lines).toEqual(["- apple", "- mango", "- zebra"]);
	});

	it("Tier 2 within-cluster lines are key-sorted and access-time-invariant", () => {
		const entries: DetailEntry[] = [];
		const parent = new Map<string, string>();
		for (let i = 0; i < 250; i++) {
			const key = `k${String(i).padStart(3, "0")}`;
			entries.push({ key, last_accessed_at: `2026-05-${10 + (i % 20)}T00:00:00Z` });
			parent.set(key, "_summary:topic");
		}
		const v1 = da(entries, { parentSummaryByKey: parent });
		// Shuffle the access times completely; key set + cluster unchanged.
		const reshuffled = entries.map((e, i) => ({
			...e,
			last_accessed_at: `2026-02-${1 + (i % 27)}T00:00:00Z`,
		}));
		const v2 = da(reshuffled, { parentSummaryByKey: parent });
		expect(v1).toBe(v2);
	});

	it("Tier 3 SELECTS M most-recent by last_accessed_at, then renders them key-sorted", () => {
		// Tier 3 requires total > tunables.n AND total > the 200 Tier-1 threshold.
		// One cluster of 250 entries, n=200, M=5: the 5 most-recently-accessed are
		// kept; the rendered order of those 5 must be key ASC.
		// The renderer SELECTS by arrival-order front (slice(0, m)); loadDetailEntries
		// supplies that as last_accessed_at DESC. Mirror that contract: build the
		// list newest-first. item-249 newest ... item-000 oldest.
		const parent = new Map<string, string>();
		const entries: DetailEntry[] = [];
		for (let i = 249; i >= 0; i--) {
			const key = `item-${String(i).padStart(3, "0")}`;
			const mm = String(Math.floor(i / 60)).padStart(2, "0");
			const ss = String(i % 60).padStart(2, "0");
			entries.push({ key, last_accessed_at: `2026-05-30T${mm}:${ss}:00Z` });
			parent.set(key, "_summary:cluster");
		}
		const out = da(entries, { parentSummaryByKey: parent, tunables: { n: 200, m: 5 } });
		const lines = out.split("\n").filter((l) => l.startsWith("- "));
		// Selected = the 5 newest (item-245..item-249); rendered key ASC.
		expect(lines).toEqual(["- item-245", "- item-246", "- item-247", "- item-248", "- item-249"]);
	});

	it("budget-pressure output equals normal output (date already gone, so no divergence)", () => {
		const entries: DetailEntry[] = [
			{ key: "b", last_accessed_at: "2026-05-30T10:00:00Z" },
			{ key: "a", last_accessed_at: "2026-05-29T10:00:00Z" },
		];
		expect(da(entries, { budgetPressure: true })).toBe(da(entries, { budgetPressure: false }));
	});
});
