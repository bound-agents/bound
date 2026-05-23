import { describe, expect, it } from "bun:test";
import {
	type DiscoverableArchiveInput,
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
