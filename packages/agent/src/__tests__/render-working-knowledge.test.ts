import { describe, expect, it } from "bun:test";
import type { StageEntry, WorkingKnowledgeInput } from "../summary-extraction";
import {
	WORKING_KNOWLEDGE_SUMMARY_CAP,
	capWorkingKnowledgeSummaries,
	renderWorkingKnowledge,
} from "../summary-extraction";

describe("renderWorkingKnowledge — stable/varying split", () => {
	describe("Empty input", () => {
		it("emits stable open+close tags and no varying lines", () => {
			const input: WorkingKnowledgeInput = {
				pinned: [],
				summaries: [],
				staleChildrenBySummary: new Map(),
				deltaKeys: new Set(),
			};

			const result = renderWorkingKnowledge(input);

			expect(result.stableLines).toEqual([
				'<working-knowledge sources="Bodies of summary entries are accessed via memory search using terms from the entry key.">',
				"</working-knowledge>",
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
				'<memory key="stand_rule_one" tier="pinned" modified="2026-05-22">Always validate input before processing</memory>',
			);
			expect(result.stableLines).toContain(
				'<memory key="stand_rule_two" tier="pinned" modified="2026-05-22">Logging must include timestamp and level</memory>',
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

			const openPrefix = '<memory key="summary_key_1" tier="summary" modified="2026-05-22">';
			const summaryLine = result.stableLines.find((line) => line.startsWith(openPrefix));
			expect(summaryLine).toBeDefined();
			const truncatedValue = (summaryLine ?? "").slice(openPrefix.length, -"</memory>".length);
			expect(truncatedValue).toContain("...");
			const beforeEllipsis = truncatedValue.substring(0, truncatedValue.length - 3);
			expect(beforeEllipsis.length).toBe(200);
			expect(result.varyingLines).toEqual([]);
		});
	});

	describe("Summary with stale children", () => {
		it("keeps parent body stable; stale-child element lives in varying", () => {
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

			expect(result.stableLines).toContain(
				'<memory key="parent_summary" tier="summary" modified="2026-05-22">Parent summary entry</memory>',
			);
			// No staleness marker in stable section.
			for (const line of result.stableLines) {
				expect(line).not.toContain('stale="true"');
			}

			// Varying side: opening tag + the child reference.
			expect(result.varyingLines[0]).toBe("<working-knowledge-updates>");
			expect(result.varyingLines[result.varyingLines.length - 1]).toBe(
				"</working-knowledge-updates>",
			);
			const childLine = result.varyingLines.find((line) => line.includes("stale_detail_1"));
			expect(childLine).toBeDefined();
			expect(childLine).toContain('<memory key="stale_detail_1"');
			expect(childLine).toContain('parent="parent_summary"');
			expect(childLine).toContain('stale="true"');
		});
	});

	describe("Delta on a summary entry (R-VC11(a))", () => {
		it("keeps body stable; emits keyed changed element on the varying side", () => {
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

			expect(result.stableLines).toContain(
				'<memory key="changed_summary" tier="summary" modified="2026-05-22">This summary was recently updated</memory>',
			);
			for (const line of result.stableLines) {
				expect(line).not.toContain('changed="true"');
			}
			expect(result.varyingLines).toContain(
				'<memory key="changed_summary" tier="summary" changed="true"/>',
			);
		});
	});

	describe("Delta on a pinned entry (R-VC11(b))", () => {
		it("keeps body stable; emits keyed changed element on the varying side", () => {
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

			expect(result.stableLines).toContain(
				'<memory key="changed_pinned" tier="pinned" modified="2026-05-22">This pinned rule was just updated</memory>',
			);
			for (const line of result.stableLines) {
				expect(line).not.toContain('changed="true"');
			}
			expect(result.varyingLines).toContain(
				'<memory key="changed_pinned" tier="pinned" changed="true"/>',
			);
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
			expect(stableJoined).toContain(
				'<memory key="multi_line_pinned" tier="pinned" modified="2026-05-22">',
			);
			expect(stableJoined).toContain(
				"Line 1 of the pinned rule\nLine 2 of the pinned rule\nLine 3 continues",
			);
			expect(result.varyingLines).toContain(
				'<memory key="multi_line_pinned" tier="pinned" changed="true"/>',
			);
		});
	});

	describe("Stale child + delta composition (R-VC11(c))", () => {
		it("carries both stale and changed attributes on one element", () => {
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
			expect(line).toContain('parent="parent"');
			expect(line).toContain('stale="true"');
			expect(line).toContain('changed="true"');
		});
	});

	describe("Stale child without delta (R-VC11(c) negative case)", () => {
		it("emits stale=true changed=false when child is not in deltaKeys", () => {
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
			expect(line).toContain('stale="true"');
			expect(line).toContain('changed="false"');
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
			expect(stable).toStartWith(
				'<working-knowledge sources="Bodies of summary entries are accessed via memory search using terms from the entry key.">',
			);
			expect(stable).toContain("stand_pinned_1");
			expect(stable).toContain("stand_pinned_2");
			expect(stable).toContain("summary_A");
			expect(stable).toContain("summary_B");
			expect(stable).not.toContain('changed="true"');
			expect(stable).not.toContain('stale="true"');

			const varying = result.varyingLines.join("\n");
			expect(varying).toContain('<memory key="stand_pinned_2" tier="pinned" changed="true"/>');
			expect(varying).toContain('<memory key="summary_B" tier="summary" changed="true"/>');
			expect(varying).toContain("stale_detail_alpha");
			expect(varying).toContain("stale_detail_beta");
			expect(varying).toContain('parent="summary_A"');
		});
	});

	describe("Section element naming (R-VC22)", () => {
		it("opens the stable and varying channels with their canonical elements", () => {
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

			expect(result.stableLines[0]).toBe(
				'<working-knowledge sources="Bodies of summary entries are accessed via memory search using terms from the entry key.">',
			);
			expect(result.varyingLines[0]).toBe("<working-knowledge-updates>");
			for (const line of [...result.stableLines, ...result.varyingLines]) {
				expect(line).not.toContain("###");
			}
		});
	});

	describe("Closing tag (R-VC6)", () => {
		it("closes the stable element as its last line", () => {
			const input: WorkingKnowledgeInput = {
				pinned: [],
				summaries: [],
				staleChildrenBySummary: new Map(),
				deltaKeys: new Set(),
			};

			const result = renderWorkingKnowledge(input);

			const lastStable = result.stableLines[result.stableLines.length - 1];
			expect(lastStable).toBe("</working-knowledge>");
		});
	});

	describe("XML escaping", () => {
		it("escapes XML-special characters in keys and values", () => {
			const input: WorkingKnowledgeInput = {
				pinned: [
					{
						key: "rule<&>",
						value: 'Use "quotes" & <tags> carefully',
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
				'<memory key="rule&lt;&amp;&gt;" tier="pinned" modified="2026-05-22">Use &quot;quotes&quot; &amp; &lt;tags&gt; carefully</memory>',
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

	// Summary cap + demote (volatile-prefix bloat fix). The stable prefix
	// rendered EVERY tier='summary' entry at full 200-char gloss, uncapped — the
	// largest growable slab in the cached prefix (166 entries / ~8.3k tok live).
	// Cap the full-gloss set at WORKING_KNOWLEDGE_SUMMARY_CAP most-recent; demote
	// the overflow to title-only entries in the Discoverable Archive so nothing
	// vanishes from view (the agent still sees every summary exists and can query
	// the body).
	describe("Summary cap + demote", () => {
		const mkSummary = (key: string): StageEntry =>
			({
				key,
				value: `body for ${key} — `.padEnd(300, "x"), // >200 so gloss truncates
				source: null,
				modifiedAt: "2026-05-22T10:00:00Z",
				tier: "summary",
				tag: "[summary]",
			}) as StageEntry;

		it("renders all summaries at full gloss when at or below the cap", () => {
			const summaries = Array.from({ length: WORKING_KNOWLEDGE_SUMMARY_CAP }, (_, i) =>
				mkSummary(`_summary:k${String(i).padStart(3, "0")}`),
			);
			const result = renderWorkingKnowledge({
				pinned: [],
				summaries,
				staleChildrenBySummary: new Map(),
				deltaKeys: new Set(),
			});
			// Every summary appears with its truncated gloss inside its element body.
			const glossLines = result.stableLines.filter((l) =>
				/^<memory key="_summary:k\d+" tier="summary" modified="\d{4}-\d{2}-\d{2}">body for/.test(l),
			);
			expect(glossLines).toHaveLength(WORKING_KNOWLEDGE_SUMMARY_CAP);
			// No demote sub-block when nothing overflowed.
			expect(result.stableLines.some((l) => l.includes("<older-summaries>"))).toBe(false);
		});

		it("caps at the summary limit and does NOT render overflow in Working Knowledge (R-VC29: moved to Discoverable Archive)", () => {
			const n = WORKING_KNOWLEDGE_SUMMARY_CAP + 16;
			const summaries = Array.from({ length: n }, (_, i) =>
				mkSummary(`_summary:k${String(i).padStart(3, "0")}`),
			);
			const result = renderWorkingKnowledge({
				pinned: [],
				summaries,
				staleChildrenBySummary: new Map(),
				deltaKeys: new Set(),
			});

			// First CAP entries keep their full gloss.
			const glossLines = result.stableLines.filter((l) =>
				/^<memory key="_summary:k\d+" tier="summary" modified="\d{4}-\d{2}-\d{2}">body for/.test(l),
			);
			expect(glossLines).toHaveLength(WORKING_KNOWLEDGE_SUMMARY_CAP);

			// R-VC29: NO demote sub-block in Working Knowledge — the overflow titles
			// now render in the Discoverable Archive, not here.
			expect(result.stableLines.some((l) => l.includes("<older-summaries>"))).toBe(false);

			// And NO title-only summary entries leak into Working Knowledge.
			const titleOnly = result.stableLines.filter((l) => /^<entry key="_summary:k\d+"\/>$/.test(l));
			expect(titleOnly).toHaveLength(0);

			// The kept set is still positional: the FIRST CAP keys keep gloss.
			expect(result.stableLines).toContain(
				`<memory key="_summary:k000" tier="summary" modified="2026-05-22">${mkSummary("_summary:k000").value.slice(0, 200)}...</memory>`,
			);
		});

		it("capWorkingKnowledgeSummaries is a pure positional split (kept + demoted)", () => {
			const summaries = Array.from({ length: 70 }, (_, i) => ({
				key: `_summary:k${String(i).padStart(3, "0")}`,
				value: "v",
			}));
			const a = capWorkingKnowledgeSummaries(summaries);
			const b = capWorkingKnowledgeSummaries(summaries);
			expect(a.kept.map((e) => e.key)).toEqual(b.kept.map((e) => e.key)); // deterministic
			expect(a.kept).toHaveLength(WORKING_KNOWLEDGE_SUMMARY_CAP);
			expect(a.demoted).toHaveLength(70 - WORKING_KNOWLEDGE_SUMMARY_CAP);
			// No entry lost or duplicated.
			expect(a.kept.length + a.demoted.length).toBe(70);
			// Order preserved (positional, not re-sorted).
			expect(a.kept[0].key).toBe("_summary:k000");
			expect(a.demoted[0].key).toBe(
				`_summary:k${String(WORKING_KNOWLEDGE_SUMMARY_CAP).padStart(3, "0")}`,
			);
		});
	});
});
