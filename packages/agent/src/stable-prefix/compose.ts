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

import {
	DISCOVERABLE_FOOTER,
	DISCOVERABLE_HEADER,
	UNCATEGORIZED_CLUSTER_NAME,
	VC15_TIER1_THRESHOLD,
	VC15_UNCATEGORIZED_BACKLOG_THRESHOLD,
	WORKING_KNOWLEDGE_FOOTER,
	WORKING_KNOWLEDGE_HEADER,
	formatStableDetailLine,
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
	out.push("");
	for (const entry of pinned) {
		out.push(`- ${entry.key}: ${entry.value}`);
	}
	for (const summary of summaries) {
		out.push(`- ${summary.key}: ${truncateGlossForSummary(summary.value)}`);
	}
	out.push("");
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
	out.push("");

	const visible = inputs.detailEntries.filter(
		(e) => !inputs.staleChildKeysInWorkingKnowledge.has(e.key),
	);
	const total = visible.length;

	if (total === 0) {
		out.push("");
		out.push(DISCOVERABLE_FOOTER);
		return out;
	}

	if (total <= VC15_TIER1_THRESHOLD) {
		for (const entry of visible) {
			out.push(formatStableDetailLine(entry, inputs.budgetPressure));
		}
		out.push("");
		out.push(DISCOVERABLE_FOOTER);
		return out;
	}

	const clusters = groupByCluster(visible, inputs.parentSummaryByKey);
	const sorted = sortClusters(clusters);

	if (total <= inputs.tunables.n) {
		// Tier 2: cluster compression.
		for (const cluster of sorted) {
			out.push(`### ${cluster.name} (${cluster.entries.length} entries)`);
			for (const entry of cluster.entries) {
				out.push(formatStableDetailLine(entry, inputs.budgetPressure));
			}
			out.push("");
		}
		if (out[out.length - 1] === "") out.pop();
		out.push("");
		out.push(DISCOVERABLE_FOOTER);
		return out;
	}

	// Tier 3: heading-only with M most-recent per cluster.
	for (const cluster of sorted) {
		const totalCount = cluster.entries.length;
		const tail = cluster.entries.slice(0, inputs.tunables.m);
		out.push(
			`### ${cluster.name} (${totalCount} entries, showing ${inputs.tunables.m} most recent)`,
		);
		for (const entry of tail) {
			out.push(formatStableDetailLine(entry, inputs.budgetPressure));
		}
		out.push("");
		if (
			cluster.name === UNCATEGORIZED_CLUSTER_NAME &&
			totalCount > VC15_UNCATEGORIZED_BACKLOG_THRESHOLD
		) {
			// Production renderer surfaces a synthesisBacklogCount here
			// for the varying-side `[synthesis-backlog]` Live-State line;
			// the count itself does not appear in the stable output.
		}
	}
	if (out[out.length - 1] === "") out.pop();
	out.push("");
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
		return a.name.localeCompare(b.name);
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
