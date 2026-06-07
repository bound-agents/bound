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
			tunables: { n: 1000, m: 20 },
		};

		const result = renderDiscoverableArchive(input);

		expect(result.section.lines).toEqual([
			"## Discoverable Archive — title-only; bodies via memory search",
			"",
			"",
			"Title-only catalog (detail entries + older summary overflow). Bodies are accessed via memory search or query against semantic_memory.",
		]);
		expect(result.synthesisBacklogCount).toBe(null);
	});

	it("test 2: Single entry, no budget pressure — title-only line, no access date", () => {
		// The line is now a pure function of the entry key: no `(accessed …)`
		// suffix. The access date was a continuously-bumped wall-clock value that
		// leaked into the cached stable-prefix bytes; dropping it makes the
		// Discoverable Archive byte-invariant to bumps.
		const entry = createTestEntry("my-memory", undefined, 0.0625);
		const input: DiscoverableArchiveInput = {
			entries: [entry],
			parentSummaryByKey: new Map(),
			staleChildKeysInWorkingKnowledge: new Set(),
			budgetPressure: false,
			tunables: { n: 1000, m: 20 },
		};

		const result = renderDiscoverableArchive(input);

		expect(result.section.lines).toContain("- my-memory");
		expect(result.section.lines.join("\n")).not.toContain("accessed 2026");
		expect(result.synthesisBacklogCount).toBe(null);
	});

	it("test 3: Single entry with null last_accessed_at — still a bare title line", () => {
		const entry: DetailEntry = { key: "forgotten-key", last_accessed_at: null };
		const input: DiscoverableArchiveInput = {
			entries: [entry],
			parentSummaryByKey: new Map(),
			staleChildKeysInWorkingKnowledge: new Set(),
			budgetPressure: false,
			tunables: { n: 1000, m: 20 },
		};

		const result = renderDiscoverableArchive(input);

		expect(result.section.lines).toContain("- forgotten-key");
		// No date-derived fragment of any kind (including the old "never").
		expect(result.section.lines.join("\n")).not.toContain("never");
	});

	it("test 4: Tier-1 lines render key-sorted (ASC), independent of last_accessed_at", () => {
		const now = new Date("2026-05-23T12:00:00Z").getTime();
		// Insertion order deliberately NOT key-sorted and NOT access-time order,
		// to prove the render sorts by key regardless.
		const entries: DetailEntry[] = [
			{ key: "middle", last_accessed_at: new Date(now - 1 * 60_000).toISOString() }, // newest
			{ key: "apex", last_accessed_at: new Date(now - 10 * 60_000).toISOString() }, // oldest
			{ key: "zulu", last_accessed_at: new Date(now - 5 * 60_000).toISOString() },
		];

		const input: DiscoverableArchiveInput = {
			entries,
			parentSummaryByKey: new Map(),
			staleChildKeysInWorkingKnowledge: new Set(),
			budgetPressure: false,
			tunables: { n: 1000, m: 20 },
		};

		const result = renderDiscoverableArchive(input);

		const contentLines = result.section.lines.filter((l) => l.startsWith("- "));
		expect(contentLines).toEqual(["- apex", "- middle", "- zulu"]);
	});

	it("test 5: Budget-pressure mode drops context fragment but preserves title", () => {
		const entry = createTestEntry("my-memory", undefined, 0.0625); // 90 minutes ago
		const input: DiscoverableArchiveInput = {
			entries: [entry],
			parentSummaryByKey: new Map(),
			staleChildKeysInWorkingKnowledge: new Set(),
			budgetPressure: true,
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
			tunables: { n: 1000, m: 20 },
		};

		const result = renderDiscoverableArchive(input);

		expect(result.section.lines[0]).toBe(
			"## Discoverable Archive — title-only; bodies via memory search",
		);
		expect(result.section.lines[result.section.lines.length - 1]).toBe(
			"Title-only catalog (detail entries + older summary overflow). Bodies are accessed via memory search or query against semantic_memory.",
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

	it("test 15: Within-cluster lines render key-sorted (ASC), independent of access time", () => {
		const now = new Date("2026-05-23T12:00:00Z").getTime();
		// Create entries that SPAN Tier 2 (>200).
		const uncategorizedEntries = Array.from({ length: 199 }, (_, i) => ({
			key: `uncategorized-${i}`,
			last_accessed_at: new Date(now - 300 * 60_000).toISOString(),
		}));
		// Access-time order (newest->oldest) is the REVERSE of key order, so a
		// key-sorted render is unambiguously distinguishable from an access-sorted
		// one: keys sort apple < mango < zebra; access has zebra newest.
		const timedEntries: DetailEntry[] = [
			{ key: "zebra", last_accessed_at: new Date(now - 1 * 60_000).toISOString() },
			{ key: "mango", last_accessed_at: new Date(now - 5 * 60_000).toISOString() },
			{ key: "apple", last_accessed_at: new Date(now - 10 * 60_000).toISOString() },
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
			tunables: { n: 1000, m: 20 },
		};

		const result = renderDiscoverableArchive(input);

		const lines = result.section.lines;
		const cookingHeadingIdx = lines.findIndex((l) => l.includes("### cooking"));
		expect(cookingHeadingIdx).toBeGreaterThanOrEqual(0);

		const cookingLines = [];
		for (let i = cookingHeadingIdx + 1; i < lines.length; i++) {
			if (lines[i].startsWith("###") || lines[i].includes("Bodies are accessed")) {
				break;
			}
			if (lines[i].startsWith("- ")) {
				cookingLines.push(lines[i]);
			}
		}

		// Key ASC, not access-time DESC.
		expect(cookingLines).toEqual(["- apple", "- mango", "- zebra"]);
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

describe("renderDiscoverableArchive — Tier 3 (heading-only compression with M-cap + synthesis-backlog)", () => {
	it("test 20: Just over BOUND_VC15_N (tunables.n=210, 211 entries → Tier 3)", () => {
		const entries = Array.from({ length: 211 }, (_, i) => ({
			key: `entry-${i}`,
			last_accessed_at: new Date(0).toISOString(),
		}));

		const input: DiscoverableArchiveInput = {
			entries,
			parentSummaryByKey: new Map(),
			staleChildKeysInWorkingKnowledge: new Set(),
			budgetPressure: false,
			tunables: { n: 210, m: 3 },
		};

		const result = renderDiscoverableArchive(input);
		const output = result.section.lines.join("\n");

		// Should use Tier 3 heading format with "showing M most recent"
		expect(output).toContain("showing 3 most recent");
		// Should be Uncategorized since no parents
		expect(output).toContain(`### ${UNCATEGORIZED_CLUSTER_NAME}`);
	});

	it("test 21: M-cap respected — each cluster renders only M most-recent entries", () => {
		const entries = Array.from({ length: 215 }, (_, i) => ({
			key: `entry-${i}`,
			last_accessed_at: new Date(0).toISOString(),
		}));

		const input: DiscoverableArchiveInput = {
			entries,
			parentSummaryByKey: new Map(),
			staleChildKeysInWorkingKnowledge: new Set(),
			budgetPressure: false,
			tunables: { n: 210, m: 3 },
		};

		const result = renderDiscoverableArchive(input);

		// Count entry lines (lines starting with "- ")
		const entryLines = result.section.lines.filter((l) => l.startsWith("- "));
		// Should have only 3 entries rendered (M-cap)
		expect(entryLines.length).toBe(3);
	});

	it("test 22: Header includes total count and M — cluster of 100 with m=5", () => {
		const entries = Array.from({ length: 210 }, (_, i) => ({
			key: `entry-${i}`,
			last_accessed_at: new Date(0).toISOString(),
		}));

		const parentMap = new Map<string, string>();
		for (let i = 0; i < 210; i++) {
			parentMap.set(`entry-${i}`, "_summary:foo");
		}

		const input: DiscoverableArchiveInput = {
			entries,
			parentSummaryByKey: parentMap,
			staleChildKeysInWorkingKnowledge: new Set(),
			budgetPressure: false,
			tunables: { n: 200, m: 5 },
		};

		const result = renderDiscoverableArchive(input);
		const output = result.section.lines.join("\n");

		// Should have heading with total count (210) and M (5)
		expect(output).toContain("### foo (210 entries, showing 5 most recent)");
	});

	it("test 23: Tier-3 SELECTS most-recent (slice m), then RENDERS them key-sorted", () => {
		const now = new Date("2026-05-23T12:00:00Z").getTime();
		// Need >200 entries to reach Tier 3 with n=200. The cooking cluster has
		// FOUR candidates; m=3 must SELECT the three most-recently-accessed
		// (sel-newest, sel-2, sel-3 — NOT sel-old), then render those three in
		// KEY order. Keys are chosen so key-order != access-order.
		const entries: DetailEntry[] = [
			{ key: "carrot", last_accessed_at: new Date(now - 1 * 60_000).toISOString() }, // newest
			{ key: "apple", last_accessed_at: new Date(now - 3 * 60_000).toISOString() },
			{ key: "banana", last_accessed_at: new Date(now - 5 * 60_000).toISOString() },
			{ key: "durian", last_accessed_at: new Date(now - 50 * 60_000).toISOString() }, // oldest -> dropped
			// Filler to reach >200 total (all uncategorized).
			...Array.from({ length: 210 }, (_, i) => ({
				key: `filler-${i}`,
				last_accessed_at: new Date(now - 100 * 60_000).toISOString(),
			})),
		];

		const parentMap = new Map<string, string>();
		for (const k of ["carrot", "apple", "banana", "durian"]) {
			parentMap.set(k, "_summary:cooking");
		}

		// Caller supplies entries last_accessed_at DESC (as loadDetailEntries does)
		// so slice(0, m) selects the most-recent. Sort the cooking candidates DESC
		// here to mirror that contract.
		const input: DiscoverableArchiveInput = {
			entries,
			parentSummaryByKey: parentMap,
			staleChildKeysInWorkingKnowledge: new Set(),
			budgetPressure: false,
			tunables: { n: 200, m: 3 },
		};

		const result = renderDiscoverableArchive(input);

		const lines = result.section.lines;
		const cookingHeadingIdx = lines.findIndex((l) => l.includes("### cooking"));
		expect(cookingHeadingIdx).toBeGreaterThanOrEqual(0);

		const entryLines = [];
		for (let i = cookingHeadingIdx + 1; i < lines.length; i++) {
			if (lines[i].startsWith("###") || lines[i].includes("Bodies are accessed")) {
				break;
			}
			if (lines[i].startsWith("- ")) {
				entryLines.push(lines[i]);
			}
		}

		// SELECTION: the 3 most-recent (carrot, apple, banana); durian dropped.
		// RENDER: those 3 key-sorted -> apple, banana, carrot.
		expect(entryLines).toEqual(["- apple", "- banana", "- carrot"]);
	});

	it("test 24: synthesisBacklogCount raised when Uncategorized > 50 in Tier 3", () => {
		const uncategorizedEntries = Array.from({ length: 60 }, (_, i) => ({
			key: `uncategorized-${i}`,
			last_accessed_at: new Date(0).toISOString(),
		}));
		const categorizedEntries = Array.from({ length: 155 }, (_, i) => ({
			key: `cooking-${i}`,
			last_accessed_at: new Date(0).toISOString(),
		}));
		const entries = [...uncategorizedEntries, ...categorizedEntries];

		const parentMap = new Map<string, string>();
		for (let i = 0; i < 155; i++) {
			parentMap.set(`cooking-${i}`, "_summary:cooking");
		}

		const input: DiscoverableArchiveInput = {
			entries,
			parentSummaryByKey: parentMap,
			staleChildKeysInWorkingKnowledge: new Set(),
			budgetPressure: false,
			tunables: { n: 200, m: 10 },
		};

		const result = renderDiscoverableArchive(input);

		// Should be Tier 3 (215 > 200) and Uncategorized has 60 entries (> 50)
		expect(result.synthesisBacklogCount).toBe(60);
	});

	it("test 25: synthesisBacklogCount NOT raised when Uncategorized ≤ 50", () => {
		const uncategorizedEntries = Array.from({ length: 30 }, (_, i) => ({
			key: `uncategorized-${i}`,
			last_accessed_at: new Date(0).toISOString(),
		}));
		const categorizedEntries = Array.from({ length: 185 }, (_, i) => ({
			key: `cooking-${i}`,
			last_accessed_at: new Date(0).toISOString(),
		}));
		const entries = [...uncategorizedEntries, ...categorizedEntries];

		const parentMap = new Map<string, string>();
		for (let i = 0; i < 185; i++) {
			parentMap.set(`cooking-${i}`, "_summary:cooking");
		}

		const input: DiscoverableArchiveInput = {
			entries,
			parentSummaryByKey: parentMap,
			staleChildKeysInWorkingKnowledge: new Set(),
			budgetPressure: false,
			tunables: { n: 200, m: 10 },
		};

		const result = renderDiscoverableArchive(input);

		// Tier 3 (215 > 200) but Uncategorized has 30 entries (≤ 50)
		expect(result.synthesisBacklogCount).toBe(null);
	});

	it("test 26: synthesisBacklogCount NOT raised when no Uncategorized cluster", () => {
		// All entries have parents
		const entries: DetailEntry[] = Array.from({ length: 220 }, (_, i) => ({
			key: `entry-${i}`,
			last_accessed_at: new Date(0).toISOString(),
		}));

		const parentMap = new Map<string, string>();
		for (let i = 0; i < 220; i++) {
			parentMap.set(`entry-${i}`, "_summary:topic");
		}

		const input: DiscoverableArchiveInput = {
			entries,
			parentSummaryByKey: parentMap,
			staleChildKeysInWorkingKnowledge: new Set(),
			budgetPressure: false,
			tunables: { n: 200, m: 10 },
		};

		const result = renderDiscoverableArchive(input);

		// Tier 3 (220 > 200) but no Uncategorized cluster (all have parents)
		expect(result.synthesisBacklogCount).toBe(null);
	});

	it("test 27: Budget-pressure mode preserves cluster sub-headers and M-cap, drops per-entry context", () => {
		const entries: DetailEntry[] = Array.from({ length: 220 }, (_, i) => ({
			key: `entry-${i}`,
			last_accessed_at: new Date(100_000).toISOString(),
		}));

		const input: DiscoverableArchiveInput = {
			entries,
			parentSummaryByKey: new Map(),
			staleChildKeysInWorkingKnowledge: new Set(),
			budgetPressure: true,
			tunables: { n: 200, m: 3 },
		};

		const result = renderDiscoverableArchive(input);
		const output = result.section.lines.join("\n");

		// Cluster sub-header should still be present
		expect(output).toContain("###");
		// Should show "showing M most recent"
		expect(output).toContain("showing 3 most recent");
		// Entries should be present but WITHOUT (last accessed ...) fragment
		const entryLines = result.section.lines.filter((l) => l.startsWith("- entry-"));
		expect(entryLines.length).toBe(3);
		for (const line of entryLines) {
			expect(line).not.toContain("(last accessed");
		}
	});

	it("test 28: R-VC21 — every rendered entry title is present across all clusters", () => {
		// Create a multi-cluster Tier 3 setup with enough entries to trigger Tier 3 (>n)
		const now = new Date("2026-05-23T12:00:00Z").getTime();
		// Need >200 entries to enter Tier 3 (with n=200). Create 3 clusters of 75 entries each = 225
		const entries: DetailEntry[] = [
			// Cluster 1 (cooking, 75 entries): will render m=2 most recent
			{ key: "cooking-newest", last_accessed_at: new Date(now - 1 * 60_000).toISOString() },
			{ key: "cooking-second", last_accessed_at: new Date(now - 5 * 60_000).toISOString() },
			...Array.from({ length: 73 }, (_, i) => ({
				key: `cooking-filler-${i}`,
				last_accessed_at: new Date(now - (100 + i) * 60_000).toISOString(),
			})),
			// Cluster 2 (transit, 75 entries): will render m=2 most recent
			{ key: "transit-newest", last_accessed_at: new Date(now - 2 * 60_000).toISOString() },
			{ key: "transit-second", last_accessed_at: new Date(now - 6 * 60_000).toISOString() },
			...Array.from({ length: 73 }, (_, i) => ({
				key: `transit-filler-${i}`,
				last_accessed_at: new Date(now - (100 + i) * 60_000).toISOString(),
			})),
			// Cluster 3 (other, 75 entries): will render m=2 most recent
			{ key: "other-newest", last_accessed_at: new Date(now - 3 * 60_000).toISOString() },
			{ key: "other-second", last_accessed_at: new Date(now - 7 * 60_000).toISOString() },
			...Array.from({ length: 73 }, (_, i) => ({
				key: `other-filler-${i}`,
				last_accessed_at: new Date(now - (100 + i) * 60_000).toISOString(),
			})),
		];

		const parentMap = new Map<string, string>();
		parentMap.set("cooking-newest", "_summary:cooking");
		parentMap.set("cooking-second", "_summary:cooking");
		for (let i = 0; i < 73; i++) {
			parentMap.set(`cooking-filler-${i}`, "_summary:cooking");
		}
		parentMap.set("transit-newest", "_summary:transit");
		parentMap.set("transit-second", "_summary:transit");
		for (let i = 0; i < 73; i++) {
			parentMap.set(`transit-filler-${i}`, "_summary:transit");
		}
		parentMap.set("other-newest", "_summary:other");
		parentMap.set("other-second", "_summary:other");
		for (let i = 0; i < 73; i++) {
			parentMap.set(`other-filler-${i}`, "_summary:other");
		}

		const input: DiscoverableArchiveInput = {
			entries,
			parentSummaryByKey: parentMap,
			staleChildKeysInWorkingKnowledge: new Set(),
			budgetPressure: false,
			tunables: { n: 200, m: 2 },
		};

		const result = renderDiscoverableArchive(input);
		const output = result.section.lines.join("\n");

		// All M-tail entries (first 2 per cluster) should appear verbatim
		expect(output).toContain("cooking-newest");
		expect(output).toContain("cooking-second");
		expect(output).toContain("transit-newest");
		expect(output).toContain("transit-second");
		expect(output).toContain("other-newest");
		expect(output).toContain("other-second");

		// Filler entries (outside M-tail) should NOT appear
		expect(output).not.toContain("cooking-filler-0");
		expect(output).not.toContain("transit-filler-0");
		expect(output).not.toContain("other-filler-0");
	});
});

describe("renderDiscoverableArchive — R-VC29 summary-overflow sub-block", () => {
	it("renders demoted summaries under an `### Older summaries` sub-header after the detail tier, before the footer", () => {
		const input: DiscoverableArchiveInput = {
			entries: [
				{ key: "adapter:foo", last_accessed_at: "2026-05-30T10:00:00Z" },
				{ key: "adapter:bar", last_accessed_at: "2026-05-29T10:00:00Z" },
			],
			parentSummaryByKey: new Map(),
			staleChildKeysInWorkingKnowledge: new Set(),
			budgetPressure: false,
			tunables: { n: 1000, m: 20 },
			demotedSummaries: [{ key: "_summary:old-a" }, { key: "_summary:old-b" }],
		};

		const lines = renderDiscoverableArchive(input).section.lines;
		const subHeaderIdx = lines.indexOf(
			"### Older summaries (titles only — search the key for the body)",
		);
		const footerIdx = lines.findIndex((l) => l.includes("Bodies are accessed via"));

		// Sub-header present, sits after the detail lines and before the footer.
		expect(subHeaderIdx).toBeGreaterThan(-1);
		expect(footerIdx).toBeGreaterThan(subHeaderIdx);
		expect(lines.indexOf("- adapter:bar")).toBeLessThan(subHeaderIdx);

		// Overflow titles render title-only, in order, between the sub-header and footer.
		expect(lines.indexOf("- _summary:old-a")).toBeGreaterThan(subHeaderIdx);
		expect(lines.indexOf("- _summary:old-a")).toBeLessThan(lines.indexOf("- _summary:old-b"));
		expect(lines.indexOf("- _summary:old-b")).toBeLessThan(footerIdx);
	});

	it("renders the `### Older summaries` sub-block even when there are no detail entries", () => {
		const input: DiscoverableArchiveInput = {
			entries: [],
			parentSummaryByKey: new Map(),
			staleChildKeysInWorkingKnowledge: new Set(),
			budgetPressure: false,
			tunables: { n: 1000, m: 20 },
			demotedSummaries: [{ key: "_summary:only-overflow" }],
		};

		const out = renderDiscoverableArchive(input).section.lines.join("\n");
		expect(out).toContain("### Older summaries (titles only — search the key for the body)");
		expect(out).toContain("- _summary:only-overflow");
	});

	it("omits the sub-block entirely when there are no demoted summaries (byte-identical to pre-R-VC29)", () => {
		const input: DiscoverableArchiveInput = {
			entries: [{ key: "adapter:foo", last_accessed_at: "2026-05-30T10:00:00Z" }],
			parentSummaryByKey: new Map(),
			staleChildKeysInWorkingKnowledge: new Set(),
			budgetPressure: false,
			tunables: { n: 1000, m: 20 },
			demotedSummaries: [],
		};

		const out = renderDiscoverableArchive(input).section.lines.join("\n");
		expect(out).not.toContain("Older summaries");
	});
});
