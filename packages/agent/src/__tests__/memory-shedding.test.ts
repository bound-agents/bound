import { beforeEach, describe, expect, it } from "bun:test";
import { type SheddingResult, shedMemoryTiers } from "../memory-shedding";
import type { StageEntry, TieredEnrichment } from "../summary-extraction";

describe("shedMemoryTiers", () => {
	let mockLogger: { warn: (msg: string) => void; warnings: string[] };

	beforeEach(() => {
		mockLogger = {
			warnings: [],
			warn(msg: string) {
				this.warnings.push(msg);
			},
		};
	});

	// Helper to create a StageEntry
	const createEntry = (
		key: string,
		tier: "pinned" | "summary" | "stale-detail" | "seed" | "recency",
		idx = 0,
	): StageEntry => ({
		key,
		value: `value for ${key}`,
		source: `src-${idx}`,
		modifiedAt: new Date().toISOString(),
		tier: tier === "pinned" ? "pinned" : "default",
		tag:
			tier === "pinned"
				? "[pinned]"
				: tier === "summary"
					? "[summary]"
					: tier === "stale-detail"
						? "[stale-detail]"
						: tier === "seed"
							? "[seed]"
							: "[recency]",
	});

	describe("hierarchical-memory.AC5.1: Shed L3 entirely", () => {
		it("should remove all L3 entries under budget pressure", () => {
			const tiers: TieredEnrichment = {
				L0: [createEntry("pinned1", "pinned", 0), createEntry("pinned2", "pinned", 1)],
				L1: [createEntry("summary1", "summary", 2)],
				L2: [
					createEntry("seed1", "seed", 3),
					createEntry("seed2", "seed", 4),
					createEntry("seed3", "seed", 5),
					createEntry("seed4", "seed", 6),
					createEntry("seed5", "seed", 7),
				],
				L3: Array.from({ length: 10 }, (_, i) => createEntry(`recency${i + 1}`, "recency", i + 8)),
			};

			const result = shedMemoryTiers(tiers, ["Task summary"], mockLogger);

			// Count memory delta lines (skip header and empty lines)
			const memoryLines = result.memoryDeltaLines.filter((l) => l.startsWith("-"));

			// Should have L0 (2) + L1 (1) + L2 (5) = 8, NO L3
			expect(memoryLines.length).toBe(8);

			// Verify no recency entries
			const recencyLines = memoryLines.filter((l) => l.includes("recency"));
			expect(recencyLines.length).toBe(0);

			// Verify L0, L1, L2 are present
			const pinnedLines = memoryLines.filter((l) => l.includes("[pinned]"));
			expect(pinnedLines.length).toBe(2);

			const summaryLines = memoryLines.filter((l) => l.includes("[summary]"));
			expect(summaryLines.length).toBe(1);

			const seedLines = memoryLines.filter((l) => l.includes("[seed]"));
			expect(seedLines.length).toBe(5);
		});
	});

	describe("hierarchical-memory.AC5.2: Reduce L2 to at most 5", () => {
		it("should keep only first 5 L2 entries when L2 exceeds 5", () => {
			const tiers: TieredEnrichment = {
				L0: [createEntry("pinned1", "pinned", 0)],
				L1: [],
				L2: Array.from({ length: 8 }, (_, i) => createEntry(`seed${i + 1}`, "seed", i)),
				L3: [createEntry("recency1", "recency", 10)],
			};

			const result = shedMemoryTiers(tiers, [], mockLogger);

			const memoryLines = result.memoryDeltaLines.filter((l) => l.startsWith("-"));

			// Should have L0 (1) + L2 (5, capped) = 6, NO L3
			expect(memoryLines.length).toBe(6);

			const seedLines = memoryLines.filter((l) => l.includes("[seed]"));
			expect(seedLines.length).toBe(5);

			// Verify the kept seeds are in order (seed1-seed5)
			for (let i = 1; i <= 5; i++) {
				expect(seedLines.some((l) => l.includes(`seed${i}`))).toBe(true);
			}

			// Verify seed6, seed7, seed8 are NOT present
			for (let i = 6; i <= 8; i++) {
				expect(seedLines.some((l) => l.includes(`seed${i}`))).toBe(false);
			}

			// No recency
			const recencyLines = memoryLines.filter((l) => l.includes("[recency]"));
			expect(recencyLines.length).toBe(0);
		});
	});

	describe("hierarchical-memory.AC5.3: Never shed L0+L1", () => {
		it("should preserve all L0 and L1 entries regardless of pressure", () => {
			const tiers: TieredEnrichment = {
				L0: Array.from({ length: 5 }, (_, i) => createEntry(`pinned${i + 1}`, "pinned", i)),
				L1: Array.from({ length: 3 }, (_, i) => createEntry(`summary${i + 1}`, "summary", i + 5)),
				L2: [],
				L3: [],
			};

			const result = shedMemoryTiers(tiers, [], mockLogger);

			const memoryLines = result.memoryDeltaLines.filter((l) => l.startsWith("-"));

			// Should have all L0 (5) + L1 (3) = 8
			expect(memoryLines.length).toBe(8);

			const pinnedLines = memoryLines.filter((l) => l.includes("[pinned]"));
			expect(pinnedLines.length).toBe(5);

			const summaryLines = memoryLines.filter((l) => l.includes("[summary]"));
			expect(summaryLines.length).toBe(3);
		});
	});

	describe("hierarchical-memory.AC5.4: Log warning when L0+L1 exceed 20", () => {
		it("should log warning but not truncate when L0+L1 alone exceed 20 entries", () => {
			const tiers: TieredEnrichment = {
				L0: Array.from({ length: 15 }, (_, i) => createEntry(`pinned${i + 1}`, "pinned", i)),
				L1: Array.from({ length: 10 }, (_, i) => createEntry(`summary${i + 1}`, "summary", i + 15)),
				L2: [],
				L3: [],
			};

			const result = shedMemoryTiers(tiers, [], mockLogger);

			// Should have warning
			expect(result.warning).toBeDefined();
			expect(mockLogger.warnings.length).toBe(1);

			// All entries still present
			const memoryLines = result.memoryDeltaLines.filter((l) => l.startsWith("-"));
			expect(memoryLines.length).toBe(25); // All 15 + 10

			const pinnedLines = memoryLines.filter((l) => l.includes("[pinned]"));
			expect(pinnedLines.length).toBe(15);

			const summaryLines = memoryLines.filter((l) => l.includes("[summary]"));
			expect(summaryLines.length).toBe(10);
		});
	});

	describe("hierarchical-memory.AC5.5: No database access", () => {
		it("should only depend on TieredEnrichment structure, not database", () => {
			const tiers: TieredEnrichment = {
				L0: [createEntry("k1", "pinned", 0)],
				L1: [createEntry("k2", "summary", 1)],
				L2: [createEntry("k3", "seed", 2)],
				L3: [createEntry("k4", "recency", 3)],
			};

			// Call without database parameter
			const result: SheddingResult = shedMemoryTiers(tiers, [], mockLogger);

			// Should complete successfully with just the tiers
			expect(result.memoryDeltaLines).toBeDefined();
			expect(result.taskDigestLines).toBeDefined();
		});
	});

	describe("task digest reduction", () => {
		it("should reduce task digest to 3 entries max", () => {
			const tiers: TieredEnrichment = {
				L0: [],
				L1: [],
				L2: [],
				L3: [],
			};

			const taskLines = [
				"Task 1: something",
				"Task 2: something else",
				"Task 3: another task",
				"Task 4: should be removed",
				"Task 5: also removed",
			];

			const result = shedMemoryTiers(tiers, taskLines, mockLogger);

			// Task digest capped at 3
			expect(result.taskDigestLines.length).toBe(3);
		});
	});

	describe("entry formatting", () => {
		it("should format entries with correct tags and value truncation", () => {
			const entry: StageEntry = {
				key: "long_key",
				value: "a".repeat(250), // Long value, should be truncated
				source: "src-1",
				modifiedAt: new Date().toISOString(),
				tier: "default",
				tag: "[seed]",
			};

			const tiers: TieredEnrichment = {
				L0: [],
				L1: [],
				L2: [entry],
				L3: [],
			};

			const result = shedMemoryTiers(tiers, [], mockLogger);

			const memoryLines = result.memoryDeltaLines.filter((l) => l.startsWith("-"));

			// Should have exactly one entry
			expect(memoryLines.length).toBe(1);

			const line = memoryLines[0];

			// Should be truncated with ...
			expect(line).toContain("...");

			// Should have tag
			expect(line).toContain("[seed]");

			// Should have key
			expect(line).toContain("long_key");
		});
	});
});
