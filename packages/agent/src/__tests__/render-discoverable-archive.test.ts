import { describe, expect, it } from "bun:test";
import {
	type DiscoverableArchiveInput,
	UNCATEGORIZED_CLUSTER_NAME,
	VC15_TIER1_THRESHOLD,
	renderDiscoverableArchive,
} from "../summary-extraction";
import type { DetailEntry } from "../summary-extraction";

function createTestEntry(
	key: string,
	lastAccessedAt: string | null = null,
	dayOffset = 0,
): DetailEntry {
	const now = new Date("2026-05-23T12:00:00Z");
	const date = new Date(now.getTime() - dayOffset * 24 * 60 * 60 * 1000);
	const iso = lastAccessedAt ?? date.toISOString();
	return { key, last_accessed_at: iso };
}

describe("renderDiscoverableArchive — Tier 1 (flat list)", () => {
	it("test 1: Empty input — no entries, no stale-child overlap", () => {
		const input: DiscoverableArchiveInput = {
			entries: [],
			parentSummaryByKey: new Map(),
			staleChildKeysInWorkingKnowledge: new Set(),
			budgetPressure: false,
			nowMs: new Date("2026-05-23T12:00:00Z").getTime(),
			tunables: { n: 1000, m: 20 },
		};

		const result = renderDiscoverableArchive(input);

		expect(result.section.lines).toEqual([
			"## Discoverable Archive — title-only; bodies via memory search",
			"",
			"",
			"Bodies are accessed via memory search or query against semantic_memory.",
		]);
		expect(result.synthesisBacklogCount).toBe(null);
	});

	it("test 2: Single entry, no budget pressure — relative time fragment present", () => {
		const entry = createTestEntry("my-memory", undefined, 0.0625); // 90 minutes ago
		const input: DiscoverableArchiveInput = {
			entries: [entry],
			parentSummaryByKey: new Map(),
			staleChildKeysInWorkingKnowledge: new Set(),
			budgetPressure: false,
			nowMs: new Date("2026-05-23T12:00:00Z").getTime(),
			tunables: { n: 1000, m: 20 },
		};

		const result = renderDiscoverableArchive(input);

		expect(result.section.lines).toContain("- my-memory (last accessed 1h ago)");
		expect(result.synthesisBacklogCount).toBe(null);
	});

	it("test 3: Single entry with null last_accessed_at — fragment is 'never'", () => {
		const entry: DetailEntry = { key: "forgotten-key", last_accessed_at: null };
		const input: DiscoverableArchiveInput = {
			entries: [entry],
			parentSummaryByKey: new Map(),
			staleChildKeysInWorkingKnowledge: new Set(),
			budgetPressure: false,
			nowMs: new Date("2026-05-23T12:00:00Z").getTime(),
			tunables: { n: 1000, m: 20 },
		};

		const result = renderDiscoverableArchive(input);

		expect(result.section.lines).toContain("- forgotten-key (last accessed never)");
	});

	it("test 4: Sorting preserved — three entries already sorted DESC by last_accessed_at", () => {
		const now = new Date("2026-05-23T12:00:00Z").getTime();
		const entries: DetailEntry[] = [
			{ key: "most-recent", last_accessed_at: new Date(now - 1 * 60_000).toISOString() },
			{ key: "middle", last_accessed_at: new Date(now - 5 * 60_000).toISOString() },
			{ key: "oldest", last_accessed_at: new Date(now - 10 * 60_000).toISOString() },
		];

		const input: DiscoverableArchiveInput = {
			entries,
			parentSummaryByKey: new Map(),
			staleChildKeysInWorkingKnowledge: new Set(),
			budgetPressure: false,
			nowMs: now,
			tunables: { n: 1000, m: 20 },
		};

		const result = renderDiscoverableArchive(input);

		const contentLines = result.section.lines.slice(2, -2); // Skip header/footer blanks
		expect(contentLines[0]).toContain("most-recent");
		expect(contentLines[1]).toContain("middle");
		expect(contentLines[2]).toContain("oldest");
	});

	it("test 5: Budget-pressure mode drops context fragment but preserves title", () => {
		const entry = createTestEntry("my-memory", undefined, 0.0625); // 90 minutes ago
		const input: DiscoverableArchiveInput = {
			entries: [entry],
			parentSummaryByKey: new Map(),
			staleChildKeysInWorkingKnowledge: new Set(),
			budgetPressure: true,
			nowMs: new Date("2026-05-23T12:00:00Z").getTime(),
			tunables: { n: 1000, m: 20 },
		};

		const result = renderDiscoverableArchive(input);

		expect(result.section.lines).toContain("- my-memory");
		// Should NOT contain the parenthetical fragment
		const contentLines = result.section.lines.filter((l) => l.startsWith("- "));
		expect(contentLines[0]).not.toContain("(last accessed");
	});

	it("test 6: Stale-child dedup — one entry in staleChildKeysInWorkingKnowledge is omitted", () => {
		const entries: DetailEntry[] = [
			{ key: "entry-a", last_accessed_at: new Date(0).toISOString() },
			{ key: "entry-b", last_accessed_at: new Date(0).toISOString() },
			{ key: "entry-c", last_accessed_at: new Date(0).toISOString() },
		];

		const input: DiscoverableArchiveInput = {
			entries,
			parentSummaryByKey: new Map(),
			staleChildKeysInWorkingKnowledge: new Set(["entry-b"]),
			budgetPressure: false,
			nowMs: new Date("2026-05-23T12:00:00Z").getTime(),
			tunables: { n: 1000, m: 20 },
		};

		const result = renderDiscoverableArchive(input);

		const contentLines = result.section.lines.slice(2, -2).filter((l) => l.startsWith("- "));
		expect(contentLines).toHaveLength(2);
		expect(contentLines[0]).toContain("entry-a");
		expect(contentLines[1]).toContain("entry-c");
		expect(result.section.lines.join("\n")).not.toContain("entry-b");
	});

	it("test 7: At Tier 1 threshold (200 entries) — renders as Tier 1", () => {
		const entries = Array.from({ length: VC15_TIER1_THRESHOLD }, (_, i) => ({
			key: `entry-${i}`,
			last_accessed_at: new Date(0).toISOString(),
		}));

		const input: DiscoverableArchiveInput = {
			entries,
			parentSummaryByKey: new Map(),
			staleChildKeysInWorkingKnowledge: new Set(),
			budgetPressure: false,
			nowMs: new Date("2026-05-23T12:00:00Z").getTime(),
			tunables: { n: 1000, m: 20 },
		};

		const result = renderDiscoverableArchive(input);

		const contentLines = result.section.lines.slice(2, -2).filter((l) => l.startsWith("- "));
		expect(contentLines).toHaveLength(VC15_TIER1_THRESHOLD);
		// Should be flat (no cluster headings with ###)
		expect(result.section.lines.join("\n")).not.toContain("###");
	});

	it("test 8: R-VC20 — no value bodies in output", () => {
		const entry: DetailEntry = { key: "test-key", last_accessed_at: new Date(0).toISOString() };
		const input: DiscoverableArchiveInput = {
			entries: [entry],
			parentSummaryByKey: new Map(),
			staleChildKeysInWorkingKnowledge: new Set(),
			budgetPressure: false,
			nowMs: new Date("2026-05-23T12:00:00Z").getTime(),
			tunables: { n: 1000, m: 20 },
		};

		const result = renderDiscoverableArchive(input);

		const output = result.section.lines.join("\n");
		// Assert no fictional value substring (DetailEntry has no value field; verify the contract)
		expect(output).not.toContain("[fictional-value-body]");
		// Also ensure we're not leaking any object-like strings
		expect(output).not.toContain("value:");
	});

	it("test 9: synthesisBacklogCount is null in Tier 1", () => {
		const entries = Array.from({ length: VC15_TIER1_THRESHOLD }, (_, i) => ({
			key: `entry-${i}`,
			last_accessed_at: new Date(0).toISOString(),
		}));

		const input: DiscoverableArchiveInput = {
			entries,
			parentSummaryByKey: new Map(),
			staleChildKeysInWorkingKnowledge: new Set(),
			budgetPressure: false,
			nowMs: new Date("2026-05-23T12:00:00Z").getTime(),
			tunables: { n: 1000, m: 20 },
		};

		const result = renderDiscoverableArchive(input);

		expect(result.synthesisBacklogCount).toBe(null);
	});

	it("test 10: Header and footer literals are exact", () => {
		const input: DiscoverableArchiveInput = {
			entries: [],
			parentSummaryByKey: new Map(),
			staleChildKeysInWorkingKnowledge: new Set(),
			budgetPressure: false,
			nowMs: new Date("2026-05-23T12:00:00Z").getTime(),
			tunables: { n: 1000, m: 20 },
		};

		const result = renderDiscoverableArchive(input);

		expect(result.section.lines[0]).toBe(
			"## Discoverable Archive — title-only; bodies via memory search",
		);
		expect(result.section.lines[result.section.lines.length - 1]).toBe(
			"Bodies are accessed via memory search or query against semantic_memory.",
		);
	});
});

describe("renderDiscoverableArchive — Tier 2 (cluster grouping)", () => {
	it("test 11: Just over threshold (201 entries) → Tier 2 with Uncategorized heading", () => {
		const entries = Array.from({ length: 201 }, (_, i) => ({
			key: `entry-${i}`,
			last_accessed_at: new Date(0).toISOString(),
		}));

		const input: DiscoverableArchiveInput = {
			entries,
			parentSummaryByKey: new Map(),
			staleChildKeysInWorkingKnowledge: new Set(),
			budgetPressure: false,
			nowMs: new Date("2026-05-23T12:00:00Z").getTime(),
			tunables: { n: 1000, m: 20 },
		};

		const result = renderDiscoverableArchive(input);

		expect(result.section.lines).toContain(`### ${UNCATEGORIZED_CLUSTER_NAME} (201 entries)`);
		expect(result.synthesisBacklogCount).toBe(null);
	});

	it("test 12: Cluster grouping by topic — entries split by _summary: prefix", () => {
		const entries: DetailEntry[] = Array.from({ length: 125 }, (_, i) => ({
			key: `cooking-${i}`,
			last_accessed_at: new Date(0).toISOString(),
		})).concat(
			Array.from({ length: 125 }, (_, i) => ({
				key: `transit-${i}`,
				last_accessed_at: new Date(0).toISOString(),
			})),
		);

		const parentMap = new Map<string, string>();
		for (let i = 0; i < 125; i++) {
			parentMap.set(`cooking-${i}`, "_summary:cooking");
			parentMap.set(`transit-${i}`, "_summary:transit");
		}

		const input: DiscoverableArchiveInput = {
			entries,
			parentSummaryByKey: parentMap,
			staleChildKeysInWorkingKnowledge: new Set(),
			budgetPressure: false,
			nowMs: new Date("2026-05-23T12:00:00Z").getTime(),
			tunables: { n: 1000, m: 20 },
		};

		const result = renderDiscoverableArchive(input);
		const output = result.section.lines.join("\n");

		expect(output).toContain("### cooking (125 entries)");
		expect(output).toContain("### transit (125 entries)");
		expect(result.synthesisBacklogCount).toBe(null);
	});

	it("test 13: Uncategorized routing — half mapped, half without parent", () => {
		const entries: DetailEntry[] = Array.from({ length: 125 }, (_, i) => ({
			key: `cooking-${i}`,
			last_accessed_at: new Date(0).toISOString(),
		})).concat(
			Array.from({ length: 125 }, (_, i) => ({
				key: `uncategorized-${i}`,
				last_accessed_at: new Date(0).toISOString(),
			})),
		);

		const parentMap = new Map<string, string>();
		for (let i = 0; i < 125; i++) {
			parentMap.set(`cooking-${i}`, "_summary:cooking");
		}
		// uncategorized entries have no parent

		const input: DiscoverableArchiveInput = {
			entries,
			parentSummaryByKey: parentMap,
			staleChildKeysInWorkingKnowledge: new Set(),
			budgetPressure: false,
			nowMs: new Date("2026-05-23T12:00:00Z").getTime(),
			tunables: { n: 1000, m: 20 },
		};

		const result = renderDiscoverableArchive(input);
		const output = result.section.lines.join("\n");

		expect(output).toContain("### cooking (125 entries)");
		expect(output).toContain(`### ${UNCATEGORIZED_CLUSTER_NAME} (125 entries)`);
	});

	it("test 14: Cluster ordering — count descending, name ascending on tie", () => {
		// Create three clusters: alpha=100, beta=100, gamma=50
		const entries: DetailEntry[] = Array.from({ length: 100 }, (_, i) => ({
			key: `alpha-${i}`,
			last_accessed_at: new Date(0).toISOString(),
		}))
			.concat(
				Array.from({ length: 100 }, (_, i) => ({
					key: `beta-${i}`,
					last_accessed_at: new Date(0).toISOString(),
				})),
			)
			.concat(
				Array.from({ length: 50 }, (_, i) => ({
					key: `gamma-${i}`,
					last_accessed_at: new Date(0).toISOString(),
				})),
			);

		const parentMap = new Map<string, string>();
		for (let i = 0; i < 100; i++) {
			parentMap.set(`alpha-${i}`, "_summary:alpha");
			parentMap.set(`beta-${i}`, "_summary:beta");
		}
		for (let i = 0; i < 50; i++) {
			parentMap.set(`gamma-${i}`, "_summary:gamma");
		}

		const input: DiscoverableArchiveInput = {
			entries,
			parentSummaryByKey: parentMap,
			staleChildKeysInWorkingKnowledge: new Set(),
			budgetPressure: false,
			nowMs: new Date("2026-05-23T12:00:00Z").getTime(),
			tunables: { n: 1000, m: 20 },
		};

		const result = renderDiscoverableArchive(input);

		const lines = result.section.lines;
		// Find cluster headings
		const alphaIdx = lines.findIndex((l) => l.includes("### alpha"));
		const betaIdx = lines.findIndex((l) => l.includes("### beta"));
		const gammaIdx = lines.findIndex((l) => l.includes("### gamma"));

		// Both alpha and beta have 100 entries; alpha should come first (alphabetical)
		expect(alphaIdx).toBeLessThan(betaIdx);
		// gamma has 50 entries; it should come last
		expect(betaIdx).toBeLessThan(gammaIdx);
	});

	it("test 15: Within-cluster ordering by last_accessed_at DESC preserved", () => {
		const now = new Date("2026-05-23T12:00:00Z").getTime();
		// Create entries that SPAN Tier 2 (>200)
		// Input must be sorted DESC by last_accessed_at (as R-VC4 supplies)
		const uncategorizedEntries = Array.from({ length: 199 }, (_, i) => ({
			key: `uncategorized-${i}`,
			last_accessed_at: new Date(now - 300 * 60_000).toISOString(),
		}));
		const timedEntries: DetailEntry[] = [
			{ key: "newest", last_accessed_at: new Date(now - 1 * 60_000).toISOString() },
			{ key: "middle", last_accessed_at: new Date(now - 5 * 60_000).toISOString() },
			{ key: "oldest", last_accessed_at: new Date(now - 10 * 60_000).toISOString() },
		];
		const entries = [...timedEntries, ...uncategorizedEntries];

		const parentMap = new Map<string, string>();
		for (const e of timedEntries) {
			parentMap.set(e.key, "_summary:cooking");
		}

		const input: DiscoverableArchiveInput = {
			entries,
			parentSummaryByKey: parentMap,
			staleChildKeysInWorkingKnowledge: new Set(),
			budgetPressure: false,
			nowMs: now,
			tunables: { n: 1000, m: 20 },
		};

		const result = renderDiscoverableArchive(input);

		// Find the cluster section for cooking
		const lines = result.section.lines;
		const cookingHeadingIdx = lines.findIndex((l) => l.includes("### cooking"));
		expect(cookingHeadingIdx).toBeGreaterThanOrEqual(0);

		// Extract lines after cooking heading until next cluster or footer
		const cookingLines = [];
		for (let i = cookingHeadingIdx + 1; i < lines.length; i++) {
			if (lines[i].startsWith("###") || lines[i].includes("Bodies are accessed")) {
				break;
			}
			if (lines[i].startsWith("- ")) {
				cookingLines.push(lines[i]);
			}
		}

		// Find indices within cooking cluster entries
		const newestIdx = cookingLines.findIndex((l) => l.includes("newest"));
		const middleIdx = cookingLines.findIndex((l) => l.includes("middle"));
		const oldestIdx = cookingLines.findIndex((l) => l.includes("oldest"));

		// All should appear
		expect(newestIdx).toBeGreaterThanOrEqual(0);
		expect(middleIdx).toBeGreaterThanOrEqual(0);
		expect(oldestIdx).toBeGreaterThanOrEqual(0);
		// And respect DESC order
		expect(newestIdx).toBeLessThan(middleIdx);
		expect(middleIdx).toBeLessThan(oldestIdx);
	});

	it("test 16: Sub-cluster ### typography (R-VC22)", () => {
		const entries: DetailEntry[] = Array.from({ length: 201 }, (_, i) => ({
			key: `entry-${i}`,
			last_accessed_at: new Date(0).toISOString(),
		}));

		const input: DiscoverableArchiveInput = {
			entries,
			parentSummaryByKey: new Map(),
			staleChildKeysInWorkingKnowledge: new Set(),
			budgetPressure: false,
			nowMs: new Date("2026-05-23T12:00:00Z").getTime(),
			tunables: { n: 1000, m: 20 },
		};

		const result = renderDiscoverableArchive(input);

		// All cluster headings should be ### (not ## or ####)
		const clusterHeadings = result.section.lines.filter((l) => l.startsWith("###"));
		expect(clusterHeadings.length).toBeGreaterThan(0);
		for (const heading of clusterHeadings) {
			expect(heading).toMatch(/^### /);
			expect(heading).not.toMatch(/^## /);
			expect(heading).not.toMatch(/^#### /);
		}
	});

	it("test 17: At BOUND_VC15_N boundary (250 entries with tunable n=250 → Tier 2)", () => {
		const entries = Array.from({ length: 250 }, (_, i) => ({
			key: `entry-${i}`,
			last_accessed_at: new Date(0).toISOString(),
		}));

		const input: DiscoverableArchiveInput = {
			entries,
			parentSummaryByKey: new Map(),
			staleChildKeysInWorkingKnowledge: new Set(),
			budgetPressure: false,
			nowMs: new Date("2026-05-23T12:00:00Z").getTime(),
			tunables: { n: 250, m: 20 },
		};

		const result = renderDiscoverableArchive(input);

		// Should be Tier 2 (cluster output with ### headings, not throw)
		const output = result.section.lines.join("\n");
		expect(output).toContain("###");
		expect(output).toContain(UNCATEGORIZED_CLUSTER_NAME);
		expect(result.synthesisBacklogCount).toBe(null);
	});

	it("test 18: Budget-pressure mode preserves cluster sub-headers and titles, drops context fragment", () => {
		const entries: DetailEntry[] = Array.from({ length: 201 }, (_, i) => ({
			key: `entry-${i}`,
			last_accessed_at: new Date(100_000).toISOString(),
		}));

		const input: DiscoverableArchiveInput = {
			entries,
			parentSummaryByKey: new Map(),
			staleChildKeysInWorkingKnowledge: new Set(),
			budgetPressure: true,
			nowMs: new Date("2026-05-23T12:00:00Z").getTime(),
			tunables: { n: 1000, m: 20 },
		};

		const result = renderDiscoverableArchive(input);

		const output = result.section.lines.join("\n");
		// Cluster heading should still be present
		expect(output).toContain("###");
		// Entries should be present but WITHOUT the (last accessed ...) fragment
		const entryLines = result.section.lines.filter((l) => l.startsWith("- entry-"));
		expect(entryLines.length).toBeGreaterThan(0);
		for (const line of entryLines) {
			expect(line).not.toContain("(last accessed");
		}
	});

	it("test 19: synthesisBacklogCount is null in Tier 2 even when Uncategorized > 50", () => {
		const uncategorizedEntries = Array.from({ length: 60 }, (_, i) => ({
			key: `uncategorized-${i}`,
			last_accessed_at: new Date(0).toISOString(),
		}));
		const categorizedEntries = Array.from({ length: 145 }, (_, i) => ({
			key: `cooking-${i}`,
			last_accessed_at: new Date(0).toISOString(),
		}));
		const entries = [...uncategorizedEntries, ...categorizedEntries];

		const parentMap = new Map<string, string>();
		for (let i = 0; i < 145; i++) {
			parentMap.set(`cooking-${i}`, "_summary:cooking");
		}
		// uncategorized entries have no parent

		const input: DiscoverableArchiveInput = {
			entries,
			parentSummaryByKey: parentMap,
			staleChildKeysInWorkingKnowledge: new Set(),
			budgetPressure: false,
			nowMs: new Date("2026-05-23T12:00:00Z").getTime(),
			tunables: { n: 1000, m: 20 },
		};

		const result = renderDiscoverableArchive(input);

		// Should be Tier 2 (205 < 1000)
		const output = result.section.lines.join("\n");
		expect(output).toContain("###");
		// But synthesisBacklogCount should still be null (only set in Tier 3)
		expect(result.synthesisBacklogCount).toBe(null);
	});
});
