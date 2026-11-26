/**
 * `composeStableVolatileSubsection` — the sole renderer for the R-VC24
 * stable subsection of the volatile context.
 *
 * The byte-stability contract is type-enforced: no `nowMs` parameter, no DB
 * handle, no `Date.now()` call. Every production path (cold assembly, the
 * no-history path, the budget-pressure rebuild, and the per-thread cache)
 * renders through this function, so there is no second renderer to drift
 * from. Production drift is caught post-hoc by
 * `validation/run-stable-prefix-drift-validation.ts`.
 */

import { compareBytewise, escapeXmlAttr } from "@bound/shared";
import {
	DISCOVERABLE_FOOTER,
	DISCOVERABLE_HEADER,
	type DiscoverableArchiveInput,
	VC15_TIER1_THRESHOLD,
	WORKING_KNOWLEDGE_DEMOTED_HEADER,
	WORKING_KNOWLEDGE_FOOTER,
	WORKING_KNOWLEDGE_HEADER,
	capWorkingKnowledgeSummaries,
	clusterNameForEntry,
	formatCalendarDate,
	truncateGlossForSummary,
} from "../summary-extraction";
import type { DetailEntryView, MemoryEntryView, StableVolatileInputs } from "./types";

/**
 * Stable lines that are not part of `StableVolatileInputs`. Scenario A's
 * frozen cross-thread summary seed is per-thread, so it is fingerprinted
 * separately and never rides the thread-agnostic cache.
 */
export interface StableSubsectionSeed {
	/** Rendered after the Discoverable Archive, preceded by a blank line. */
	crossThreadLines?: ReadonlyArray<string>;
}

export function composeStableVolatileSubsection(
	inputs: StableVolatileInputs,
	seed: StableSubsectionSeed = {},
): string[] {
	const lines: string[] = [""];
	lines.push(...renderWorkingKnowledge(inputs.pinned, inputs.summaries));
	lines.push(
		...renderDiscoverableArchive({
			entries: inputs.detailEntries,
			parentSummaryByKey: inputs.parentSummaryByKey,
			staleChildKeysInWorkingKnowledge: inputs.staleChildKeysInWorkingKnowledge,
			budgetPressure: inputs.budgetPressure,
			tunables: inputs.tunables,
			// R-VC29: summary-tier overflow renders title-only in the Archive.
			demotedSummaries: capWorkingKnowledgeSummaries(inputs.summaries).demoted,
		}),
	);
	if (seed.crossThreadLines !== undefined) {
		lines.push("", ...seed.crossThreadLines);
	}
	if (inputs.skillIndex.length > 0) {
		lines.push(...renderSkillIndex(inputs.skillIndex).split("\n"));
	}
	lines.push(...renderClusterModels(inputs.clusterModels));
	return lines;
}

/**
 * The `<stable-context>` cluster-model topology block. Input arrays are
 * pre-sorted upstream (see `loadClusterModels`), so this is a straight
 * projection. Empty input adds no bytes.
 *
 * Every attribute value routes through `escapeXmlAttr`: host_names and future
 * alias schemes are not guaranteed XML-safe.
 */
export function renderClusterModels(
	models: ReadonlyArray<{
		name: string;
		hosts: ReadonlyArray<string>;
		local: boolean;
		contextWindow?: number;
		maxOutput?: number;
		vision?: boolean;
		thinking?: boolean;
		role?: "default" | "heavy" | "fast";
	}>,
): string[] {
	if (models.length === 0) return [];
	// R-MC12: the capability signal is the cluster `role` plus resolved
	// `context`/`max_output`. Pricing is deliberately NOT advertised: the
	// synced `hosts.models` JSON carries no pricing, so a price legend would be
	// a promise the data path cannot keep.
	const lines: string[] = [
		'<stable-context note="name is the logical model (or alias) to pass as aux model / model_hint / infer() model — it routes across every host and provider serving it; role is the model\'s cluster assignment (default/heavy/fast); context and max_output are token counts; prefer explicit metadata and role over model-name vibes when picking aux/infer() models">',
	];
	for (const m of models) {
		let attrs =
			`<model name="${escapeXmlAttr(m.name)}" local="${m.local}"` +
			` hosts="${escapeXmlAttr(m.hosts.join(","))}"`;
		// Numerics are validated finite upstream (loadClusterModels), so plain
		// interpolation is XML-safe.
		if (m.role !== undefined) attrs += ` role="${m.role}"`;
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
 * Working Knowledge bodies (R-VC3): pinned entries in full, the first
 * `WORKING_KNOWLEDGE_SUMMARY_CAP` summaries with a truncated gloss. The
 * `modified` capture date (#71) advances only on a real body rewrite — the
 * same event that already busts the prefix cache.
 */
export function renderWorkingKnowledge(
	pinned: ReadonlyArray<MemoryEntryView>,
	summaries: ReadonlyArray<MemoryEntryView>,
): string[] {
	const out: string[] = [WORKING_KNOWLEDGE_HEADER];
	for (const entry of pinned) {
		out.push(
			`<memory key="${escapeXmlAttr(entry.key)}" tier="pinned" modified="${formatCalendarDate(entry.modifiedAt)}">${escapeXmlAttr(entry.value)}</memory>`,
		);
	}
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
 * Discoverable Archive titles with R-VC15 three-tier compression: flat list
 * (Tier 1), cluster compression (Tier 2), heading-only with the M most
 * recently accessed per cluster (Tier 3).
 *
 * Lines are rendered key-sorted and carry no `last_accessed_at`-derived
 * fragment: that column is bumped on every cold assembly
 * (`bumpRenderedDetailEntries`), so rendering any function of it — date or
 * order — would bust the provider cache for no information change. Access
 * time survives only as the Tier-3 selection key.
 */
export function renderDiscoverableArchive(input: DiscoverableArchiveInput): string[] {
	const lines: string[] = [DISCOVERABLE_HEADER];

	// §5.2 step 2 — drop entries also rendered as stale children in Working Knowledge.
	const visible = input.entries.filter((e) => !input.staleChildKeysInWorkingKnowledge.has(e.key));
	const total = visible.length;

	if (total === 0) {
		// The common tail (sub-block + footer) still renders below.
	} else if (total <= VC15_TIER1_THRESHOLD) {
		for (const entry of sortDetailEntriesForRender(visible)) {
			lines.push(formatDetailLine(entry));
		}
	} else if (total <= input.tunables.n) {
		for (const cluster of sortClusters(groupByCluster(visible, input.parentSummaryByKey))) {
			lines.push(
				`<cluster name="${escapeXmlAttr(cluster.name)}" count="${cluster.entries.length}">`,
			);
			for (const entry of sortDetailEntriesForRender(cluster.entries)) {
				lines.push(formatDetailLine(entry));
			}
			lines.push("</cluster>");
		}
	} else {
		// Entries arrive last_accessed_at DESC, so slice(0, m) keeps the M
		// most-recently-accessed per cluster.
		for (const cluster of sortClusters(groupByCluster(visible, input.parentSummaryByKey))) {
			const tail = cluster.entries.slice(0, input.tunables.m);
			lines.push(
				`<cluster name="${escapeXmlAttr(cluster.name)}" count="${cluster.entries.length}" showing="${input.tunables.m}">`,
			);
			for (const entry of sortDetailEntriesForRender(tail)) {
				lines.push(formatDetailLine(entry));
			}
			lines.push("</cluster>");
		}
	}

	if (input.demotedSummaries && input.demotedSummaries.length > 0) {
		lines.push(WORKING_KNOWLEDGE_DEMOTED_HEADER);
		for (const summary of input.demotedSummaries) {
			lines.push(`<entry key="${escapeXmlAttr(summary.key)}"/>`);
		}
		lines.push("</older-summaries>");
	}

	lines.push(DISCOVERABLE_FOOTER);
	return lines;
}

function formatDetailLine(entry: DetailEntryView): string {
	return `<entry key="${escapeXmlAttr(entry.key)}"/>`;
}

function sortDetailEntriesForRender<T extends { key: string }>(entries: ReadonlyArray<T>): T[] {
	return entries.slice().sort((a, b) => compareBytewise(a.key, b.key));
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
		const name = clusterNameForEntry(entry.key, parentSummaryByKey);
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
		// Bytewise, NOT localeCompare: locale-dependent ordering would let two
		// hosts with different ICU configs render different prefixes for
		// identical synced state.
		return compareBytewise(a.name, b.name);
	});
}

/** The active-skills XML index. */
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
