/**
 * Branch coverage for composeStableVolatileSubsection and its private
 * renderers — the Discoverable Archive tier paths (empty / Tier-1 / Tier-2
 * cluster compression / Tier-3 heading-only) and the cluster-model topology
 * block. The property/parity suites exercise byte-stability; this one drives
 * the structural branches directly.
 */

import { describe, expect, it } from "bun:test";
import type { Vc15Tunables } from "../../summary-extraction";
import { composeStableVolatileSubsection, renderClusterModels } from "../compose";
import type { DetailEntryView, MemoryEntryView, StableVolatileInputs } from "../types";

const TUNABLES: Vc15Tunables = { n: 1000, m: 20 };

function detail(key: string): DetailEntryView {
	return { key, last_accessed_at: null };
}

function baseInputs(overrides: Partial<StableVolatileInputs> = {}): StableVolatileInputs {
	return {
		pinned: [],
		summaries: [],
		detailEntries: [],
		parentSummaryByKey: new Map(),
		staleChildKeysInWorkingKnowledge: new Set(),
		budgetPressure: false,
		tunables: TUNABLES,
		skillIndex: [],
		clusterModels: [],
		...overrides,
	};
}

describe("composeStableVolatileSubsection — Discoverable Archive tiers", () => {
	it("renders empty-archive tail (no detail body) with footer", () => {
		const out = composeStableVolatileSubsection(baseInputs()).join("\n");
		// No cluster or entry lines, but the archive header/footer frame is present.
		expect(out).not.toContain("<cluster");
		expect(out).not.toContain("<entry");
	});

	it("renders Tier-1 key-sorted entries when total <= threshold", () => {
		const out = composeStableVolatileSubsection(
			baseInputs({ detailEntries: [detail("curiosity:z"), detail("curiosity:a")] }),
		).join("\n");
		expect(out).toContain("curiosity:a");
		expect(out).toContain("curiosity:z");
		// Below the Tier-2 threshold: no cluster wrappers.
		expect(out).not.toContain("<cluster");
	});

	it("excludes detail keys already routed to Working Knowledge as stale children", () => {
		const out = composeStableVolatileSubsection(
			baseInputs({
				detailEntries: [detail("curiosity:visible"), detail("curiosity:hidden")],
				staleChildKeysInWorkingKnowledge: new Set(["curiosity:hidden"]),
			}),
		).join("\n");
		expect(out).toContain("curiosity:visible");
		expect(out).not.toContain("curiosity:hidden");
	});

	it("Tier-2 cluster compression: lists entries grouped by parent summary", () => {
		// total > VC15_TIER1_THRESHOLD (200) but <= tunables.n forces cluster compression.
		const entries: DetailEntryView[] = [];
		const parentSummaryByKey = new Map<string, string>();
		for (let i = 0; i < 250; i++) {
			const key = `curiosity:topic-${i % 2}:${String(i).padStart(4, "0")}`;
			entries.push(detail(key));
			parentSummaryByKey.set(key, i % 2 === 0 ? "_summary:even" : "_summary:odd");
		}
		const out = composeStableVolatileSubsection(
			baseInputs({ detailEntries: entries, parentSummaryByKey }),
		).join("\n");
		expect(out).toContain('<cluster name="_summary:even"');
		expect(out).toContain('<cluster name="_summary:odd"');
		expect(out).toContain("</cluster>");
	});

	it("Tier-3 heading-only: emits showing=M and the uncategorized backlog branch", () => {
		// total > tunables.n -> Tier 3. All entries bucket as Uncategorized (no parent
		// summary), and the count clears VC15_UNCATEGORIZED_BACKLOG_THRESHOLD (50).
		const entries: DetailEntryView[] = [];
		for (let i = 0; i < 250; i++) {
			entries.push(detail(`curiosity:item:${String(i).padStart(4, "0")}`));
		}
		const out = composeStableVolatileSubsection(
			baseInputs({
				detailEntries: entries,
				tunables: { n: 200, m: 5 },
			}),
		).join("\n");
		expect(out).toContain('showing="5"');
		expect(out).toContain("<cluster");
		expect(out).toContain("</cluster>");
	});

	it("renders Working Knowledge pinned + summary bodies", () => {
		const pinned: MemoryEntryView[] = [
			{ key: "_pin:rule", value: "a standing rule body", modifiedAt: "2026-01-01T00:00:00.000Z" },
		];
		const summaries: MemoryEntryView[] = [
			{ key: "_summary:x", value: "a summary gloss body", modifiedAt: "2026-02-02T00:00:00.000Z" },
		];
		const out = composeStableVolatileSubsection(baseInputs({ pinned, summaries })).join("\n");
		expect(out).toContain('key="_pin:rule"');
		expect(out).toContain('tier="pinned"');
		expect(out).toContain('key="_summary:x"');
		expect(out).toContain('tier="summary"');
	});

	it("includes the skill index and cluster-model topology", () => {
		const out = composeStableVolatileSubsection(
			baseInputs({
				skillIndex: [{ name: "my-skill", description: "does a thing" }],
				clusterModels: [{ name: "opus", hosts: ["h1"], local: true, role: "heavy" }],
			}),
		).join("\n");
		expect(out).toContain("<available_skills>");
		expect(out).toContain("my-skill");
		expect(out).toContain('<model name="opus"');
	});
});

describe("renderClusterModels", () => {
	it("returns an empty array when there are no models", () => {
		expect(renderClusterModels([])).toEqual([]);
	});

	it("renders all optional decision-metadata attributes when present (R-MC12: role replaces tier)", () => {
		const lines = renderClusterModels([
			{
				name: "gpt-6-astra",
				hosts: ["a", "b"],
				local: true,
				role: "default",
				contextWindow: 700000,
				maxOutput: 64000,
				vision: true,
				thinking: false,
			},
		]);
		const joined = lines.join("\n");
		expect(joined).toContain("<stable-context");
		expect(joined).toContain('name="gpt-6-astra"');
		expect(joined).toContain('local="true"');
		expect(joined).toContain('hosts="a,b"');
		expect(joined).toContain('role="default"');
		expect(joined).toContain('context="700000"');
		expect(joined).toContain('max_output="64000"');
		expect(joined).toContain('vision="true"');
		expect(joined).toContain('thinking="false"');
		// R-MC12: the retired `tier` attribute is never emitted.
		expect(joined).not.toContain("tier=");
		// Pricing is NOT on the stable-context data path: `loadClusterModels`
		// (the sole production collector) reads only capability fields from the
		// `hosts.models` JSON, which carries no pricing. The legend must not
		// promise price_in/price_out, and no model line may emit them.
		expect(joined).not.toContain("price_in");
		expect(joined).not.toContain("price_out");
		expect(joined).not.toContain("USD per million");
		expect(joined).toContain("</stable-context>");
	});

	it("omits optional attributes that are undefined", () => {
		const lines = renderClusterModels([{ name: "alias-only", hosts: ["h"], local: false }]);
		const joined = lines.join("\n");
		expect(joined).toContain('name="alias-only"');
		expect(joined).not.toContain("role=");
		expect(joined).not.toContain("context=");
		expect(joined).not.toContain("vision=");
	});

	it("escapes XML-unsafe characters in name and hosts", () => {
		const lines = renderClusterModels([{ name: "a&b", hosts: ["h<x>"], local: true }]);
		const joined = lines.join("\n");
		expect(joined).toContain("a&amp;b");
		expect(joined).toContain("h&lt;x&gt;");
	});
});
