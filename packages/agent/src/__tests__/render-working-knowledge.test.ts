import { describe, expect, it } from "bun:test";
import type { StageEntry, WorkingKnowledgeInput } from "../summary-extraction";
import { renderWorkingKnowledge } from "../summary-extraction";

describe("renderWorkingKnowledge", () => {
	describe("Empty input", () => {
		it("should output header, blank lines, and footer", () => {
			const input: WorkingKnowledgeInput = {
				pinned: [],
				summaries: [],
				staleChildrenBySummary: new Map(),
				deltaKeys: new Set(),
			};

			const result = renderWorkingKnowledge(input);

			expect(result.lines.length).toBe(4);
			expect(result.lines[0]).toBe("## Working Knowledge — operational and durable");
			expect(result.lines[1]).toBe("");
			expect(result.lines[2]).toBe("");
			expect(result.lines[3]).toBe(
				"Bodies of summary entries are accessed via memory search using terms from the entry key.",
			);
		});
	});

	describe("Pinned only, no deltas", () => {
		it("should render pinned entries in full text without delta markers", () => {
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

			expect(result.lines[2]).toBe("- stand_rule_one: Always validate input before processing");
			expect(result.lines[3]).toBe("- stand_rule_two: Logging must include timestamp and level");
		});
	});

	describe("Summary only, no deltas, no stale children", () => {
		it("should render summary entries with 200-char gloss", () => {
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

			const summaryLine = result.lines[2];
			expect(summaryLine).toMatch(/^- summary_key_1: /);
			// Check that it's truncated to 200 chars + "..."
			const valueStart = "- summary_key_1: ".length;
			const truncatedValue = summaryLine.substring(valueStart);
			expect(truncatedValue).toContain("...");
			const beforeEllipsis = truncatedValue.substring(0, truncatedValue.length - 3);
			expect(beforeEllipsis.length).toBe(200);
		});
	});

	describe("Summary with stale children", () => {
		it("should indent children beneath parent with [stale child of] marker", () => {
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

			const parentLine = result.lines[2];
			expect(parentLine).toContain("- parent_summary: Parent summary entry");

			const childLine = result.lines[3];
			expect(childLine).toContain("  - stale_detail_1:");
			expect(childLine).toContain("[stale child of parent_summary]");
		});
	});

	describe("Delta on a summary entry (R-VC11(a))", () => {
		it("should append [changed since last turn] marker on same line", () => {
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

			const summaryLine = result.lines[2];
			expect(summaryLine).toContain("- changed_summary: This summary was recently updated");
			expect(summaryLine).toMatch(/\[changed since last turn\]$/);
		});
	});

	describe("Delta on a single-line pinned entry (R-VC11(b))", () => {
		it("should render delta marker on separate indented line beneath pinned entry", () => {
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

			const pinnedLine = result.lines[2];
			expect(pinnedLine).toBe("- changed_pinned: This pinned rule was just updated");

			const markerLine = result.lines[3];
			expect(markerLine).toBe("    [changed since last turn]");
		});
	});

	describe("Delta on a multi-line pinned entry (R-VC11(b) edge case)", () => {
		it("should render delta marker on new indented line even for multi-line pinned content", () => {
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

			// First line should contain the full multi-line value
			const pinnedLine = result.lines[2];
			expect(pinnedLine).toContain("- multi_line_pinned:");
			expect(pinnedLine).toContain(
				"Line 1 of the pinned rule\nLine 2 of the pinned rule\nLine 3 continues",
			);

			// Delta marker should be on next line, indented
			const markerLine = result.lines[3];
			expect(markerLine).toBe("    [changed since last turn]");
		});
	});

	describe("Stale child + delta composition (R-VC11(c))", () => {
		it("should render markers in fixed order [stale child of] [changed since last turn]", () => {
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

			const childLine = result.lines[3];
			expect(childLine).toContain("  - stale_and_changed:");
			// Verify exact order: stale first, delta second
			const staleIndex = childLine.indexOf("[stale child of parent]");
			const deltaIndex = childLine.indexOf("[changed since last turn]");
			expect(staleIndex).toBeGreaterThan(-1);
			expect(deltaIndex).toBeGreaterThan(-1);
			expect(staleIndex).toBeLessThan(deltaIndex);
		});
	});

	describe("Stale child without delta (R-VC11(c) negative case)", () => {
		it("should render only [stale child of] marker when child is not in deltaKeys", () => {
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
				deltaKeys: new Set(), // Child NOT in deltaKeys
			};

			const result = renderWorkingKnowledge(input);

			const childLine = result.lines[3];
			expect(childLine).toContain("[stale child of parent]");
			expect(childLine).not.toContain("[changed since last turn]");
		});
	});

	describe("Full mixed input", () => {
		it("should handle pinned + summary + stale children + deltas combined", () => {
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

			// Verify structure: header, pinned entries, summaries with stale children, footer
			expect(result.lines[0]).toBe("## Working Knowledge — operational and durable");
			expect(result.lines[1]).toBe("");

			// Verify no exceptions and all sections present
			const output = result.lines.join("\n");
			expect(output).toContain("stand_pinned_1");
			expect(output).toContain("stand_pinned_2");
			expect(output).toContain("[changed since last turn]");
			expect(output).toContain("summary_A");
			expect(output).toContain("summary_B");
			expect(output).toContain("stale_detail_alpha");
			expect(output).toContain("stale_detail_beta");
			expect(output).toContain("[stale child of summary_A]");
		});
	});

	describe("Header typography uniformity (R-VC22)", () => {
		it("should use ## (not ### or #) for top-level header", () => {
			const input: WorkingKnowledgeInput = {
				pinned: [],
				summaries: [],
				staleChildrenBySummary: new Map(),
				deltaKeys: new Set(),
			};

			const result = renderWorkingKnowledge(input);

			expect(result.lines[0]).toBe("## Working Knowledge — operational and durable");
			expect(result.lines[0]).not.toContain("###");
			expect(result.lines[0]).not.toMatch(/^#[^#]/);
		});
	});

	describe("Footer text (R-VC6)", () => {
		it("should render exact footer text", () => {
			const input: WorkingKnowledgeInput = {
				pinned: [],
				summaries: [],
				staleChildrenBySummary: new Map(),
				deltaKeys: new Set(),
			};

			const result = renderWorkingKnowledge(input);

			const lastLine = result.lines[result.lines.length - 1];
			expect(lastLine).toBe(
				"Bodies of summary entries are accessed via memory search using terms from the entry key.",
			);
		});
	});

	describe("R-VC11(d) — no last_accessed_at side effects", () => {
		it("should accept frozen input and produce output with no DB access", () => {
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

			// The function should accept the input and produce output without throwing
			// or attempting any DB access (which would fail since no Database is provided).
			// This is structurally guaranteed by the function signature accepting only
			// WorkingKnowledgeInput (plain data), not a Database parameter.
			expect(() => {
				renderWorkingKnowledge(input);
			}).not.toThrow();

			const result = renderWorkingKnowledge(input);
			expect(result).toBeDefined();
			expect(result.lines).toBeArray();
		});
	});
});
