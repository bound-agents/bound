/**
 * `composeStableVolatileSubsection` — pure renderer for the R-VC24
 * stable subsection of the volatile context.
 *
 * This is the seam established to make the byte-stability contract
 * **type-enforceable** (no `nowMs` parameter, no DB handle, no
 * `Date.now()` call) and **property-testable** (single function
 * boundary that fast-check can falsify). See `types.ts` for the
 * full input declaration and the JSDoc rationale.
 *
 * **Why this duplicates a small amount of rendering logic.** The
 * production renderers `renderWorkingKnowledge` and
 * `renderDiscoverableArchive` accept richer types than the stable
 * path actually reads (they also produce a varying-side output
 * channel that reads `modifiedAt`, `tag`, `source`, etc.). To keep
 * `StableVolatileInputs` truly minimal — and to make the type
 * system enforce the purity contract rather than merely document it
 * — this module renders the stable subsection directly from the
 * narrow views. The resulting output MUST stay byte-equivalent to
 * the production renderers' stable channels; that equivalence is
 * pinned by the regression test
 * `__tests__/parity-with-production.test.ts`. Header / footer /
 * gloss-max constants are imported from `summary-extraction.ts` so
 * a change there propagates here mechanically.
 *
 * **Determinism contract**: for a fixed `StableVolatileInputs`
 * object, this function returns byte-identical output across calls
 * within and across processes. Property tests under
 * `__tests__/compose.property.test.ts` exercise the contract;
 * production drift is caught by the validator at
 * `validation/run-stable-prefix-drift-validation.ts`.
 */

import { compareBytewise, escapeXmlAttr } from "@bound/shared";
import {
	DISCOVERABLE_FOOTER,
	DISCOVERABLE_HEADER,
	UNCATEGORIZED_CLUSTER_NAME,
	VC15_TIER1_THRESHOLD,
	VC15_UNCATEGORIZED_BACKLOG_THRESHOLD,
	WORKING_KNOWLEDGE_FOOTER,
	WORKING_KNOWLEDGE_HEADER,
	appendOlderSummariesSubBlock,
	capWorkingKnowledgeSummaries,
	formatCalendarDate,
	formatStableDetailLine,
	sortDetailEntriesForRender,
	truncateGlossForSummary,
} from "../summary-extraction";
import type { DetailEntryView, MemoryEntryView, StableVolatileInputs } from "./types";

/**
 * Render the stable volatile subsection (Working Knowledge bodies +
 * Discoverable Archive titles + skill index) as an array of lines,
 * suitable for joining onto `systemParts` by the caller.
 *
 * The function is **pure** in `inputs` alone. No reads from `db`,
 * `Date.now()`, `process.env`, the filesystem, or any other ambient
 * source. This is the property the abstraction exists to enforce.
 */
export function composeStableVolatileSubsection(inputs: StableVolatileInputs): string[] {
	const lines: string[] = [];
	lines.push("");
	lines.push(...renderWorkingKnowledgeStable(inputs.pinned, inputs.summaries));
	lines.push(...renderDiscoverableArchiveStable(inputs));
	lines.push(...renderSkillIndex(inputs.skillIndex).split("\n"));
	lines.push(...renderClusterModels(inputs.clusterModels));
	return lines;
}

/**
 * Single source of truth for the `<stable-context>` cluster-model topology
 * block. Used both by `composeStableVolatileSubsection` (the R-VC25 purity
 * seam / property test) and by the production stable-prefix fold in
 * `context-assembly.ts`, so the two channels stay byte-equivalent.
 *
 * Pure in `models` alone. Input arrays are pre-sorted upstream (bytewise by
 * `name`, hosts bytewise within each entry — see `loadClusterModels`), so no
 * sorting happens here; this renderer is a straight projection. Returns an
 * empty array when there are no models (no host topology yet), mirroring
 * `renderSkillIndex`'s suppress-when-empty behavior so an empty cluster adds
 * no bytes.
 *
 * Every attribute value routes through `escapeXmlAttr`: model aliases are
 * tame today, but host_names and future alias schemes are not guaranteed
 * XML-safe, and an unescaped `&` would make the fragment ill-formed.
 */
export function renderClusterModels(
	models: ReadonlyArray<{
		name: string;
		hosts: ReadonlyArray<string>;
		local: boolean;
		tier?: number;
		contextWindow?: number;
		maxOutput?: number;
		vision?: boolean;
		thinking?: boolean;
	}>,
): string[] {
	if (models.length === 0) return [];
	// The legend rides the opening tag so the metadata is self-describing:
	// without it, "tier" is an opaque number and the agent is back to guessing.
	const lines: string[] = [
		'<stable-context note="tier 1 is the most capable class, higher numbers are lighter/cheaper; context and max_output are token counts; prefer explicit metadata over model-name vibes when picking aux/infer() models">',
	];
	for (const m of models) {
		let attrs =
			`<model name="${escapeXmlAttr(m.name)}" local="${m.local}"` +
			` hosts="${escapeXmlAttr(m.hosts.join(","))}"`;
		// Decision metadata (optional — absent for string-alias host rows).
		// Numerics are validated finite upstream (loadClusterModels), so plain
		// interpolation is XML-safe without escaping.
		if (m.tier !== undefined) attrs += ` tier="${m.tier}"`;
		if (m.contextWindow !== undefined) attrs += ` context="${m.contextWindow}"`;
		if (m.maxOutput !== undefined) attrs += ` max_output="${m.maxOutput}"`;
		if (m.vision !== undefined) attrs += ` vision="${m.vision}"`;
		if (m.thinking !== undefined) attrs += ` thinking="${m.thinking}"`;
		lines.push(`${attrs}/>`);
	}
	lines.push("</stable-context>");
	return lines;
}

/**
 * Stable-side Working Knowledge: header + pinned bodies + summary
 * bodies (with truncated gloss) + footer. Mirrors the
 * `renderWorkingKnowledge.stableLines` channel of the production
 * renderer — which reads only `key` and `value` on its stable path.
 */
function renderWorkingKnowledgeStable(
	pinned: ReadonlyArray<MemoryEntryView>,
	summaries: ReadonlyArray<MemoryEntryView>,
): string[] {
	const out: string[] = [];
	out.push(WORKING_KNOWLEDGE_HEADER);
	for (const entry of pinned) {
		out.push(
			`<memory key="${escapeXmlAttr(entry.key)}" tier="pinned" modified="${formatCalendarDate(entry.modifiedAt)}">${escapeXmlAttr(entry.value)}</memory>`,
		);
	}
	// Identical cap to renderWorkingKnowledge's stable channel — via the SAME
	// shared helper so the two paths cannot drift (R-VC25 parity, pinned by
	// parity-with-production.test.ts). R-VC29: the `demoted` overflow no longer
	// renders here; it moves to the Discoverable Archive (renderDiscoverableArchiveStable).
	const { kept } = capWorkingKnowledgeSummaries(summaries);
	for (const summary of kept) {
		out.push(
			`<memory key="${escapeXmlAttr(summary.key)}" tier="summary" modified="${formatCalendarDate(summary.modifiedAt)}">${escapeXmlAttr(truncateGlossForSummary(summary.value))}</memory>`,
		);
	}
	out.push(WORKING_KNOWLEDGE_FOOTER);
	return out;
}

/**
 * Stable-side Discoverable Archive: header + title lines (Tier 1) or
 * cluster-compressed listing (Tier 2/3) + footer. Mirrors the body
 * of `renderDiscoverableArchive` in `summary-extraction.ts`. Since
 * the production renderer is itself stable-side-only after the
 * `nowMs` removal, the duplication here is a deliberate seam — not
 * a divergence — and is pinned by the parity regression test.
 *
 * Returns lines (not a `RenderedSection`) to keep this module
 * boundary uniform with the rest of `composeStableVolatileSubsection`.
 */
function renderDiscoverableArchiveStable(inputs: StableVolatileInputs): string[] {
	const out: string[] = [];
	out.push(DISCOVERABLE_HEADER);

	const visible = inputs.detailEntries.filter(
		(e) => !inputs.staleChildKeysInWorkingKnowledge.has(e.key),
	);
	const total = visible.length;

	if (total === 0) {
		// No detail body; the common tail (sub-block + footer) still renders below.
	} else if (total <= VC15_TIER1_THRESHOLD) {
		// Key-sorted render (mirrors production renderDiscoverableArchive).
		for (const entry of sortDetailEntriesForRender(visible)) {
			out.push(formatStableDetailLine(entry, inputs.budgetPressure));
		}
	} else {
		const clusters = groupByCluster(visible, inputs.parentSummaryByKey);
		const sorted = sortClusters(clusters);

		if (total <= inputs.tunables.n) {
			// Tier 2: cluster compression. Within-cluster lines key-sorted.
			for (const cluster of sorted) {
				out.push(
					`<cluster name="${escapeXmlAttr(cluster.name)}" count="${cluster.entries.length}">`,
				);
				for (const entry of sortDetailEntriesForRender(cluster.entries)) {
					out.push(formatStableDetailLine(entry, inputs.budgetPressure));
				}
				out.push("</cluster>");
			}
		} else {
			// Tier 3: heading-only with M most-recent per cluster. Recency SELECTION
			// (slice), key-sorted RENDER (mirrors production).
			for (const cluster of sorted) {
				const totalCount = cluster.entries.length;
				const tail = cluster.entries.slice(0, inputs.tunables.m);
				out.push(
					`<cluster name="${escapeXmlAttr(cluster.name)}" count="${totalCount}" showing="${inputs.tunables.m}">`,
				);
				for (const entry of sortDetailEntriesForRender(tail)) {
					out.push(formatStableDetailLine(entry, inputs.budgetPressure));
				}
				out.push("</cluster>");
				if (
					cluster.name === UNCATEGORIZED_CLUSTER_NAME &&
					totalCount > VC15_UNCATEGORIZED_BACKLOG_THRESHOLD
				) {
					// Production renderer surfaces a synthesisBacklogCount here
					// for the varying-side `[synthesis-backlog]` Live-State line;
					// the count itself does not appear in the stable output.
				}
			}
		}
	}

	// R-VC29: demoted summary-overflow titles render inside the Archive. Derived
	// from inputs.summaries through the SAME capWorkingKnowledgeSummaries +
	// appendOlderSummariesSubBlock the production renderer uses, so the stable
	// channel and its mirror cannot drift (pinned by parity-with-production.test.ts).
	const { demoted } = capWorkingKnowledgeSummaries(inputs.summaries);
	appendOlderSummariesSubBlock(out, demoted);

	out.push(DISCOVERABLE_FOOTER);
	return out;
}

interface Cluster {
	name: string;
	entries: DetailEntryView[];
}

function groupByCluster(
	entries: ReadonlyArray<DetailEntryView>,
	parentSummaryByKey: ReadonlyMap<string, string>,
): Cluster[] {
	const map = new Map<string, DetailEntryView[]>();
	for (const entry of entries) {
		const name = parentSummaryByKey.get(entry.key) ?? UNCATEGORIZED_CLUSTER_NAME;
		const bucket = map.get(name) ?? [];
		bucket.push(entry);
		map.set(name, bucket);
	}
	return Array.from(map.entries()).map(([name, bucketEntries]) => ({
		name,
		entries: bucketEntries,
	}));
}

function sortClusters(clusters: Cluster[]): Cluster[] {
	return clusters.slice().sort((a, b) => {
		if (a.entries.length !== b.entries.length) {
			return b.entries.length - a.entries.length;
		}
		// Bytewise tiebreak, mirroring the production sorter in
		// summary-extraction.ts — locale-dependent ordering would leak the
		// host ICU config into R-VC25-pure bytes.
		return compareBytewise(a.name, b.name);
	});
}

/**
 * Render the active-skills XML index. Pure in `skills` alone.
 *
 * Single source of truth for the skill-index byte layout. Used both
 * by `composeStableVolatileSubsection` (property-test seam) and by
 * the production stable-prefix folding in
 * `context-assembly.buildVolatileContext`. Both call sites import
 * this function so a future format change propagates everywhere
 * without a "keep in lockstep" coupling.
 */
export function renderSkillIndex(
	skills: ReadonlyArray<{ name: string; description: string }>,
): string {
	return `<available_skills>
${skills.map(
	(skill) => `<skill>
<name>${skill.name}</name>
<description>${skill.description}</description>
</skill>
`,
)}
</available_skills>`;
}
