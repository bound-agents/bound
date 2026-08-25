import type { StageEntry, TieredEnrichment } from "../../summary-extraction";

/**
 * Test-side projection of `TieredEnrichment` into the flat line shape the
 * retrieval tests assert against.
 *
 * The production `memoryDeltaLines` field (and its `formatMemoryEntry`
 * renderer) was removed as dead code — nothing rendered it into either
 * volatile channel after R-VC24. The tests that consumed it, however, were
 * really asserting DATA-layer behavior: which entries land in which tier
 * (L0→L1→L2→L3 exclusion cascade), keyword seeding, `_internal.*` filtering,
 * `[forgotten]` tombstones, value truncation, and task/thread source
 * resolution (the JOIN-resolved `taskName`/`threadId`/`threadTitle` fields).
 * This helper reproduces just enough of the old line shape to keep those
 * assertions meaningful, flattened in tier order.
 */
export function deltaLines(enrichment: { tiers: TieredEnrichment }): string[] {
	const { L0, L1, L2, L3 } = enrichment.tiers;
	return [...L0, ...L1, ...L2, ...L3].map(formatEntry);
}

function formatEntry(entry: StageEntry): string {
	const value = entry.value.length > 200 ? `${entry.value.slice(0, 200)}...` : entry.value;
	const source =
		entry.taskName != null
			? `task "${entry.taskName}"`
			: entry.threadId != null
				? `thread "${entry.threadTitle ?? entry.threadId.slice(0, 8)}"`
				: entry.source == null
					? "unknown"
					: entry.source.slice(0, 8);
	if (entry.deleted) {
		return `- ${entry.key}: [forgotten] (via ${source})`;
	}
	if (entry.tag === "[pinned]" || entry.tag === "[summary]" || entry.tag === "[stale-detail]") {
		return `- ${entry.key}: ${value} ${entry.tag}`;
	}
	return `- ${entry.key}: ${value} (via ${source}) ${entry.tag}`;
}
