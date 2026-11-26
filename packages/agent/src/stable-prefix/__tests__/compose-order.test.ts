/**
 * Composition-order test for `composeStableVolatileSubsection`: the stable
 * subsection is the leading blank line, Working Knowledge bodies, the
 * Discoverable Archive, the optional cross-thread seed, the skill index
 * (omitted when empty), and the cluster-model block, in that order. The cold
 * path, the no-history path, and the per-thread cache all render through this
 * one function.
 */

import { describe, expect, it } from "bun:test";
import {
	WORKING_KNOWLEDGE_SUMMARY_CAP,
	capWorkingKnowledgeSummaries,
} from "../../summary-extraction";
import {
	composeStableVolatileSubsection,
	renderClusterModels,
	renderDiscoverableArchive,
	renderSkillIndex,
	renderWorkingKnowledge,
} from "../compose";
import type { StableVolatileInputs } from "../types";

const WK_MOD_AT = "2026-05-25T12:00:00Z";

function baseInputs(overrides: Partial<StableVolatileInputs> = {}): StableVolatileInputs {
	return {
		pinned: [],
		summaries: [],
		detailEntries: [],
		parentSummaryByKey: new Map(),
		staleChildKeysInWorkingKnowledge: new Set(),
		budgetPressure: false,
		tunables: { n: 1000, m: 20 },
		skillIndex: [],
		clusterModels: [],
		...overrides,
	};
}

function expectedConcat(inputs: StableVolatileInputs, crossThreadLines?: string[]): string {
	return [
		"",
		...renderWorkingKnowledge(inputs.pinned, inputs.summaries),
		...renderDiscoverableArchive({
			entries: inputs.detailEntries,
			parentSummaryByKey: inputs.parentSummaryByKey,
			staleChildKeysInWorkingKnowledge: inputs.staleChildKeysInWorkingKnowledge,
			budgetPressure: inputs.budgetPressure,
			tunables: inputs.tunables,
			demotedSummaries: capWorkingKnowledgeSummaries(inputs.summaries).demoted,
		}),
		...(crossThreadLines ? ["", ...crossThreadLines] : []),
		...(inputs.skillIndex.length > 0 ? renderSkillIndex(inputs.skillIndex).split("\n") : []),
		...renderClusterModels(inputs.clusterModels),
	].join("\n");
}

describe("composeStableVolatileSubsection — composition order", () => {
	it("renders no skill index or cluster block for empty inputs", () => {
		const out = composeStableVolatileSubsection(baseInputs()).join("\n");
		expect(out).toBe(expectedConcat(baseInputs()));
		expect(out).not.toContain("<available_skills>");
		expect(out).not.toContain("<stable-context");
	});

	it("orders WK, DA, skill index, and cluster models", () => {
		const inputs = baseInputs({
			pinned: [{ key: "_standing:tone", value: "be terse", modifiedAt: WK_MOD_AT }],
			summaries: Array.from({ length: WORKING_KNOWLEDGE_SUMMARY_CAP + 2 }, (_, i) => ({
				key: `_summary:k${String(i).padStart(3, "0")}`,
				value: `summary ${i}`,
				modifiedAt: WK_MOD_AT,
			})),
			detailEntries: [{ key: "adapter:foo", last_accessed_at: null }],
			skillIndex: [{ name: "alpha", description: "the alpha skill" }],
			clusterModels: [{ name: "opus", hosts: ["h1"], local: true }],
		});
		const out = composeStableVolatileSubsection(inputs).join("\n");
		expect(out).toBe(expectedConcat(inputs));
		expect(out.indexOf("</working-knowledge>")).toBeLessThan(out.indexOf("<older-summaries>"));
		expect(out.indexOf("</discoverable-archive>")).toBeLessThan(out.indexOf("<available_skills>"));
		expect(out.indexOf("</available_skills>")).toBeLessThan(out.indexOf("<stable-context"));
	});

	it("places the cross-thread seed between the Archive and the skill index", () => {
		const inputs = baseInputs({ skillIndex: [{ name: "alpha", description: "a" }] });
		const seed = ["<cross-thread>", "</cross-thread>"];
		const out = composeStableVolatileSubsection(inputs, { crossThreadLines: seed }).join("\n");
		expect(out).toBe(expectedConcat(inputs, seed));
		expect(out.indexOf("<cross-thread>")).toBeGreaterThan(out.indexOf("</discoverable-archive>"));
		expect(out.indexOf("<cross-thread>")).toBeLessThan(out.indexOf("<available_skills>"));
	});
});
