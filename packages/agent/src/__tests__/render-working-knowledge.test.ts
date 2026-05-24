import { describe, expect, it } from "bun:test";
import type { StageEntry, WorkingKnowledgeInput } from "../summary-extraction";
import { renderWorkingKnowledge } from "../summary-extraction";

describe("renderWorkingKnowledge — stable/varying split", () => {
	describe("Empty input", () => {
		it("emits stable header+footer and no varying lines", () => {
			const input: WorkingKnowledgeInput = {
				pinned: [],
				summaries: [],
				staleChildrenBySummary: new Map(),
				deltaKeys: new Set(),
			};

			const result = renderWorkingKnowledge(input);

			expect(result.stableLines).toEqual([
				"## Working Knowledge — operational and durable",
				"",
				"",
				"Bodies of summary entries are accessed via memory search using terms from the entry key.",
			]);
			expect(result.varyingLines).toEqual([]);
		});
	});

	describe("Pinned only, no deltas", () => {
		it("renders pinned bodies on the stable side and emits no varying lines", () => {
			const input: WorkingKnowledgeInput = {
				pinned: [
					{
						key: "stand_rule_one",
						value: "Always validate input before processing",
						source: null,
						modifiedAt: "2026-05-22T10:00:00Z",
						tier: "pinned",
						tag: "[pinned]",
					} as StageEntry,
					{
						key: "stand_rule_two",
						value: "Logging must include timestamp and level",
						source: null,
						modifiedAt: "2026-05-22T10:00:00Z",
						tier: "pinned",
						tag: "[pinned]",
					} as StageEntry,
				],
				summaries: [],
				staleChildrenBySummary: new Map(),
				deltaKeys: new Set(),
			};

			const result = renderWorkingKnowledge(input);

			expect(result.stableLines).toContain(
				"- stand_rule_one: Always validate input before processing",
			);
			expect(result.stableLines).toContain(
				"- stand_rule_two: Logging must include timestamp and level",
			);
			expect(result.varyingLines).toEqual([]);
		});
	});

	describe("Summary only, no deltas, no stale children", () => {
		it("renders summary bodies with 200-char gloss on the stable side and no varying lines", () => {
			const longText =
				"This is a very long summary that exceeds two hundred characters and should be truncated to exactly two hundred characters plus an ellipsis marker to indicate that content has been cut off. The full text continues here but will not be visible in the rendered output because it exceeds the maximum length.";

			const input: WorkingKnowledgeInput = {
				pinned: [],
				summaries: [
					{
						key: "summary_key_1",
						value: longText,
						source: null,
						modifiedAt: "2026-05-22T10:00:00Z",
						tier: "summary",
						tag: "[summary]",
					} as StageEntry,
				],
				staleChildrenBySummary: new Map(),
				deltaKeys: new Set(),
			};

			const result = renderWorkingKnowledge(input);

			const summaryLine = result.stableLines.find((line) => line.startsWith("- summary_key_1: "));
			expect(summaryLine).toBeDefined();
			const truncatedValue = (summaryLine ?? "").substring("- summary_key_1: ".length);
			expect(truncatedValue).toContain("...");
			const beforeEllipsis = truncatedValue.substring(0, truncatedValue.length - 3);
			expect(beforeEllipsis.length).toBe(200);
			expect(result.varyingLines).toEqual([]);
		});
	});

	describe("Summary with stale children", () => {
		it("keeps parent body stable; child + [stale child of] live in varying", () => {
			const staleChild = {
				key: "stale_detail_1",
				value: "This is a stale child entry that was updated after the summary",
				source: null,
				modifiedAt: "2026-05-22T11:00:00Z",
				tier: "default",
				tag: "[stale-detail]",
			} as StageEntry;

			const input: WorkingKnowledgeInput = {
				pinned: [],
				summaries: [
					{
						key: "parent_summary",
						value: "Parent summary entry",
						source: null,
						modifiedAt: "2026-05-22T10:00:00Z",
						tier: "summary",
						tag: "[summary]",
					} as StageEntry,
				],
				staleChildrenBySummary: new Map([["parent_summary", [staleChild]]]),
				deltaKeys: new Set(),
			};

			const result = renderWorkingKnowledge(input);

			expect(result.stableLines).toContain("- parent_summary: Parent summary entry");
			// No marker in stable section.
			for (const line of result.stableLines) {
				expect(line).not.toContain("[stale child of");
			}

			// Varying side: header + the child reference.
			expect(result.varyingLines[0]).toBe("## Working Knowledge — updates");
			const childLine = result.varyingLines.find((line) => line.includes("stale_detail_1"));
			expect(childLine).toBeDefined();
			expect(childLine).toContain("  - stale_detail_1:");
			expect(childLine).toContain("[stale child of parent_summary]");
		});
	});

	describe("Delta on a summary entry (R-VC11(a))", () => {
		it("keeps body stable; emits keyed [changed since last turn] on the varying side", () => {
			const input: WorkingKnowledgeInput = {
				pinned: [],
				summaries: [
					{
						key: "changed_summary",
						value: "This summary was recently updated",
						source: null,
						modifiedAt: "2026-05-22T11:00:00Z",
						tier: "summary",
						tag: "[summary]",
					} as StageEntry,
				],
				staleChildrenBySummary: new Map(),
				deltaKeys: new Set(["changed_summary"]),
			};

			const result = renderWorkingKnowledge(input);

			expect(result.stableLines).toContain("- changed_summary: This summary was recently updated");
			for (const line of result.stableLines) {
				expect(line).not.toContain("[changed since last turn]");
			}
			expect(result.varyingLines).toContain("- changed_summary [changed since last turn]");
		});
	});

	describe("Delta on a pinned entry (R-VC11(b))", () => {
		it("keeps body stable; emits keyed [changed since last turn] on the varying side", () => {
			const input: WorkingKnowledgeInput = {
				pinned: [
					{
						key: "changed_pinned",
						value: "This pinned rule was just updated",
						source: null,
						modifiedAt: "2026-05-22T11:00:00Z",
						tier: "pinned",
						tag: "[pinned]",
					} as StageEntry,
				],
				summaries: [],
				staleChildrenBySummary: new Map(),
				deltaKeys: new Set(["changed_pinned"]),
			};

			const result = renderWorkingKnowledge(input);

			expect(result.stableLines).toContain("- changed_pinned: This pinned rule was just updated");
			for (const line of result.stableLines) {
				expect(line).not.toContain("[changed since last turn]");
			}
			expect(result.varyingLines).toContain("- changed_pinned [changed since last turn]");
		});
	});

	describe("Delta on a multi-line pinned entry (R-VC11(b) edge case)", () => {
		it("keeps full multi-line value stable; emits single-line keyed marker on varying side", () => {
			const input: WorkingKnowledgeInput = {
				pinned: [
					{
						key: "multi_line_pinned",
						value: "Line 1 of the pinned rule\nLine 2 of the pinned rule\nLine 3 continues",
						source: null,
						modifiedAt: "2026-05-22T11:00:00Z",
						tier: "pinned",
						tag: "[pinned]",
					} as StageEntry,
				],
				summaries: [],
				staleChildrenBySummary: new Map(),
				deltaKeys: new Set(["multi_line_pinned"]),
			};

			const result = renderWorkingKnowledge(input);

			const stableJoined = result.stableLines.join("\n");
			expect(stableJoined).toContain("- multi_line_pinned:");
			expect(stableJoined).toContain(
				"Line 1 of the pinned rule\nLine 2 of the pinned rule\nLine 3 continues",
			);
			expect(result.varyingLines).toContain("- multi_line_pinned [changed since last turn]");
		});
	});

	describe("Stale child + delta composition (R-VC11(c))", () => {
		it("renders [stale child of] before [changed since last turn] on the varying side", () => {
			const staleChild = {
				key: "stale_and_changed",
				value: "This child is both stale and changed",
				source: null,
				modifiedAt: "2026-05-22T11:00:00Z",
				tier: "default",
				tag: "[stale-detail]",
			} as StageEntry;

			const input: WorkingKnowledgeInput = {
				pinned: [],
				summaries: [
					{
						key: "parent",
						value: "Parent summary",
						source: null,
						modifiedAt: "2026-05-22T10:00:00Z",
						tier: "summary",
						tag: "[summary]",
					} as StageEntry,
				],
				staleChildrenBySummary: new Map([["parent", [staleChild]]]),
				deltaKeys: new Set(["stale_and_changed"]),
			};

			const result = renderWorkingKnowledge(input);

			const childLine = result.varyingLines.find((line) => line.includes("stale_and_changed"));
			expect(childLine).toBeDefined();
			const line = childLine ?? "";
			const staleIndex = line.indexOf("[stale child of parent]");
			const deltaIndex = line.indexOf("[changed since last turn]");
			expect(staleIndex).toBeGreaterThan(-1);
			expect(deltaIndex).toBeGreaterThan(-1);
			expect(staleIndex).toBeLessThan(deltaIndex);
		});
	});

	describe("Stale child without delta (R-VC11(c) negative case)", () => {
		it("emits only [stale child of] on the varying side when child is not in deltaKeys", () => {
			const staleChild = {
				key: "stale_not_changed",
				value: "This child is stale but not changed this turn",
				source: null,
				modifiedAt: "2026-05-22T11:00:00Z",
				tier: "default",
				tag: "[stale-detail]",
			} as StageEntry;

			const input: WorkingKnowledgeInput = {
				pinned: [],
				summaries: [
					{
						key: "parent",
						value: "Parent summary",
						source: null,
						modifiedAt: "2026-05-22T10:00:00Z",
						tier: "summary",
						tag: "[summary]",
					} as StageEntry,
				],
				staleChildrenBySummary: new Map([["parent", [staleChild]]]),
				deltaKeys: new Set(),
			};

			const result = renderWorkingKnowledge(input);

			const childLine = result.varyingLines.find((line) => line.includes("stale_not_changed"));
			expect(childLine).toBeDefined();
			const line = childLine ?? "";
			expect(line).toContain("[stale child of parent]");
			expect(line).not.toContain("[changed since last turn]");
		});
	});

	describe("Full mixed input", () => {
		it("partitions all bodies into stable and all annotations into varying", () => {
			const staleChild1 = {
				key: "stale_detail_alpha",
				value: "First stale child under summary A",
				source: null,
				modifiedAt: "2026-05-22T11:00:00Z",
				tier: "default",
				tag: "[stale-detail]",
			} as StageEntry;

			const staleChild2 = {
				key: "stale_detail_beta",
				value: "Second stale child, also changed this turn",
				source: null,
				modifiedAt: "2026-05-22T11:30:00Z",
				tier: "default",
				tag: "[stale-detail]",
			} as StageEntry;

			const input: WorkingKnowledgeInput = {
				pinned: [
					{
						key: "stand_pinned_1",
						value: "First pinned rule",
						source: null,
						modifiedAt: "2026-05-22T10:00:00Z",
						tier: "pinned",
						tag: "[pinned]",
					} as StageEntry,
					{
						key: "stand_pinned_2",
						value: "Second pinned rule, changed this turn",
						source: null,
						modifiedAt: "2026-05-22T11:00:00Z",
						tier: "pinned",
						tag: "[pinned]",
					} as StageEntry,
				],
				summaries: [
					{
						key: "summary_A",
						value: "Summary of topic A with some context about the current situation",
						source: null,
						modifiedAt: "2026-05-22T10:00:00Z",
						tier: "summary",
						tag: "[summary]",
					} as StageEntry,
					{
						key: "summary_B",
						value: "Summary of topic B, also changed recently",
						source: null,
						modifiedAt: "2026-05-22T11:00:00Z",
						tier: "summary",
						tag: "[summary]",
					} as StageEntry,
				],
				staleChildrenBySummary: new Map([["summary_A", [staleChild1, staleChild2]]]),
				deltaKeys: new Set(["stand_pinned_2", "summary_B", "stale_detail_beta"]),
			};

			const result = renderWorkingKnowledge(input);

			const stable = result.stableLines.join("\n");
			expect(stable).toStartWith("## Working Knowledge — operational and durable");
			expect(stable).toContain("stand_pinned_1");
			expect(stable).toContain("stand_pinned_2");
			expect(stable).toContain("summary_A");
			expect(stable).toContain("summary_B");
			expect(stable).not.toContain("[changed since last turn]");
			expect(stable).not.toContain("[stale child of");

			const varying = result.varyingLines.join("\n");
			expect(varying).toContain("- stand_pinned_2 [changed since last turn]");
			expect(varying).toContain("- summary_B [changed since last turn]");
			expect(varying).toContain("stale_detail_alpha");
			expect(varying).toContain("stale_detail_beta");
			expect(varying).toContain("[stale child of summary_A]");
		});
	});

	describe("Header typography uniformity (R-VC22)", () => {
		it("uses ## (not ### or #) for both top-level headers", () => {
			const input: WorkingKnowledgeInput = {
				pinned: [],
				summaries: [
					{
						key: "k",
						value: "v",
						source: null,
						modifiedAt: "2026-05-22T10:00:00Z",
						tier: "summary",
						tag: "[summary]",
					} as StageEntry,
				],
				staleChildrenBySummary: new Map(),
				deltaKeys: new Set(["k"]),
			};

			const result = renderWorkingKnowledge(input);

			expect(result.stableLines[0]).toBe("## Working Knowledge — operational and durable");
			expect(result.varyingLines[0]).toBe("## Working Knowledge — updates");
			for (const line of [...result.stableLines, ...result.varyingLines]) {
				expect(line).not.toContain("###");
			}
		});
	});

	describe("Footer text (R-VC6)", () => {
		it("renders exact footer text on the stable side", () => {
			const input: WorkingKnowledgeInput = {
				pinned: [],
				summaries: [],
				staleChildrenBySummary: new Map(),
				deltaKeys: new Set(),
			};

			const result = renderWorkingKnowledge(input);

			const lastStable = result.stableLines[result.stableLines.length - 1];
			expect(lastStable).toBe(
				"Bodies of summary entries are accessed via memory search using terms from the entry key.",
			);
		});
	});

	describe("R-VC11(d) — no last_accessed_at side effects", () => {
		it("accepts plain input and produces output with no DB access", () => {
			const input: WorkingKnowledgeInput = {
				pinned: [
					{
						key: "test_key",
						value: "test value",
						source: null,
						modifiedAt: "2026-05-22T10:00:00Z",
						tier: "pinned",
						tag: "[pinned]",
					} as StageEntry,
				],
				summaries: [],
				staleChildrenBySummary: new Map(),
				deltaKeys: new Set(),
			};

			expect(() => {
				renderWorkingKnowledge(input);
			}).not.toThrow();

			const result = renderWorkingKnowledge(input);
			expect(result).toBeDefined();
			expect(result.stableLines).toBeArray();
			expect(result.varyingLines).toBeArray();
		});
	});
});
