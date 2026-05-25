/**
 * Parity regression test for `composeStableVolatileSubsection`.
 *
 * `stable-prefix/compose.ts` deliberately renders the R-VC24 stable
 * subsection directly (rather than delegating to the dual-purpose
 * production renderers) so that `StableVolatileInputs` can be a
 * narrow input contract. This file pins the cost of that decoupling:
 * for any input set, the stable-side output of this module MUST be
 * byte-equivalent to concatenating the production renderers' stable
 * channels for the same inputs.
 *
 * If this test fails, one of two things happened:
 *
 *   1. The production renderer changed (header / footer / formatting
 *      logic) without a matching change here. Update `compose.ts`.
 *
 *   2. This module diverged from production. Revert `compose.ts`.
 *
 * Either way, the divergence must be reconciled before the change
 * lands — otherwise the drift detector at
 * `validation/run-stable-prefix-drift-validation.ts` would surface
 * false positives where production-rendered systemPrompts disagree
 * with this module's hash.
 */

import { describe, expect, it } from "bun:test";
import {
	type DetailEntry,
	type DiscoverableArchiveInput,
	type StageEntry,
	renderDiscoverableArchive,
	renderWorkingKnowledge,
} from "../../summary-extraction";
import { composeStableVolatileSubsection, renderSkillIndex } from "../compose";
import type { StableVolatileInputs } from "../types";

function makeStageEntry(key: string, value: string): StageEntry {
	return {
		key,
		value,
		source: "test",
		modifiedAt: "2026-05-25T12:00:00Z",
		tier: "summary",
		tag: "[summary]",
		deleted: false,
	};
}

function makeDetailEntry(key: string, lastAccessedAt: string | null): DetailEntry {
	return { id: `id-${key}`, key, last_accessed_at: lastAccessedAt };
}

describe("composeStableVolatileSubsection — parity with production renderers", () => {
	it("matches concatenated production stable output for empty inputs", () => {
		const inputs: StableVolatileInputs = {
			pinned: [],
			summaries: [],
			detailEntries: [],
			parentSummaryByKey: new Map(),
			staleChildKeysInWorkingKnowledge: new Set(),
			budgetPressure: false,
			tunables: { n: 1000, m: 20 },
			skillIndex: [],
		};

		const ours = composeStableVolatileSubsection(inputs).join("\n");
		const theirs = renderProductionStableConcat(inputs);

		expect(ours).toBe(theirs);
	});

	it("matches for a tier-1 DA workload with pinned + summary", () => {
		const inputs: StableVolatileInputs = {
			pinned: [
				{ key: "_standing:tone", value: "be terse and factual" },
				{ key: "_pinned:user-name", value: "user" },
			],
			summaries: [
				{ key: "_summary:transit", value: "notes on the local transit network and connections" },
			],
			detailEntries: [
				{ key: "adapter:foo", last_accessed_at: "2026-04-28T12:34:56Z" },
				{ key: "bug:bar", last_accessed_at: "2026-05-01T08:00:00Z" },
				{ key: "curiosity:baz", last_accessed_at: null },
			],
			parentSummaryByKey: new Map(),
			staleChildKeysInWorkingKnowledge: new Set(),
			budgetPressure: false,
			tunables: { n: 1000, m: 20 },
			skillIndex: [{ name: "alpha", description: "the alpha skill" }],
		};

		const ours = composeStableVolatileSubsection(inputs).join("\n");
		const theirs = renderProductionStableConcat(inputs);

		expect(ours).toBe(theirs);
	});

	it("matches under budget pressure (DA renders title-only)", () => {
		const inputs: StableVolatileInputs = {
			pinned: [{ key: "_standing:tone", value: "be terse" }],
			summaries: [],
			detailEntries: [
				{ key: "adapter:foo", last_accessed_at: "2026-04-28T12:34:56Z" },
				{ key: "bug:bar", last_accessed_at: "2026-05-01T08:00:00Z" },
			],
			parentSummaryByKey: new Map(),
			staleChildKeysInWorkingKnowledge: new Set(),
			budgetPressure: true,
			tunables: { n: 1000, m: 20 },
			skillIndex: [],
		};

		const ours = composeStableVolatileSubsection(inputs).join("\n");
		const theirs = renderProductionStableConcat(inputs);

		expect(ours).toBe(theirs);
	});

	it("matches when a stale child is excluded from DA via the workingKnowledge set", () => {
		const inputs: StableVolatileInputs = {
			pinned: [],
			summaries: [{ key: "_summary:transit", value: "transit notes" }],
			detailEntries: [
				{ key: "adapter:foo", last_accessed_at: "2026-04-28T12:34:56Z" },
				{ key: "stale:dropped-from-da", last_accessed_at: "2026-05-25T08:00:00Z" },
			],
			parentSummaryByKey: new Map(),
			staleChildKeysInWorkingKnowledge: new Set(["stale:dropped-from-da"]),
			budgetPressure: false,
			tunables: { n: 1000, m: 20 },
			skillIndex: [],
		};

		const ours = composeStableVolatileSubsection(inputs).join("\n");
		const theirs = renderProductionStableConcat(inputs);

		expect(ours).toBe(theirs);
	});
});

/**
 * Render the stable side via the production renderers and concatenate
 * them in the same order `composeStableVolatileSubsection` does. Any
 * format change in the production renderers will surface here as a
 * test diff against `compose.ts`.
 */
function renderProductionStableConcat(inputs: StableVolatileInputs): string {
	const wkInput = {
		pinned: inputs.pinned.map((e): StageEntry => makeStageEntry(e.key, e.value)),
		summaries: inputs.summaries.map((e): StageEntry => makeStageEntry(e.key, e.value)),
		staleChildrenBySummary: new Map(),
		deltaKeys: new Set<string>(),
	};
	const wk = renderWorkingKnowledge(wkInput);

	const daInput: DiscoverableArchiveInput = {
		entries: inputs.detailEntries.map((e) => makeDetailEntry(e.key, e.last_accessed_at)),
		parentSummaryByKey: new Map(inputs.parentSummaryByKey),
		staleChildKeysInWorkingKnowledge: new Set(inputs.staleChildKeysInWorkingKnowledge),
		budgetPressure: inputs.budgetPressure,
		tunables: inputs.tunables,
	};
	const da = renderDiscoverableArchive(daInput);

	// Use the shared `renderSkillIndex` — same function the production
	// path calls. Hand-rolling the XML here would be a parallel
	// implementation that could silently drift; this test is now
	// purely about orchestration (order + concatenation), not about
	// the skill-index byte layout.
	const skillIndex = renderSkillIndex(inputs.skillIndex);

	const lines = ["", ...wk.stableLines, ...da.section.lines, ...skillIndex.split("\n")];
	return lines.join("\n");
}
