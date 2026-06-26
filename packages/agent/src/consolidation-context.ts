/**
 * Consolidation context builder — assembles the prompt for the built-in
 * consolidation task type.
 *
 * The consolidation task is generative: it reads memory entries, identifies
 * clusters, synthesizes summaries, and connects edges. This is the cognitive
 * work that previously lived in the heartbeat instructions but doesn't trend
 * towards zero — it always has candidates to work on.
 *
 * Like the heartbeat, the context builder provides detection (what needs
 * consolidating) as code-injected sections. The agent reads the candidates
 * and does the synthesis.
 */

import type { Database } from "bun:sqlite";

const DEFAULT_CONSOLIDATION_INSTRUCTIONS = `Read the consolidation candidates below. Identify clusters of 3+ related entries that share a topic prefix. For each cluster, synthesize a 2-4 sentence summary, store it as _summary:<topic>, and connect edges (summarizes) to each child entry. Set children to tier 'detail'. If a stale summary is listed, re-read its children and update it. If nothing needs consolidating, respond briefly.`;

/**
 * Default consolidation cadence. Like the heartbeat, this is a system-managed,
 * uncancellable task seeded once per install. 4-hour interval.
 */
export const DEFAULT_CONSOLIDATION_INTERVAL_MS = 14_400_000; // 4 hours

export function buildConsolidationContext(
	db: Database,
	lastRunAt: string | null,
): string {
	const instructions = loadConsolidationInstructions(db);
	const candidateSection = buildCandidateSection(db);
	const staleSection = buildStaleSummarySection(db);
	const pressureSection = buildPressureSection(db);

	return `You are running a scheduled memory consolidation pass.

## Standing Instructions
These are your self-maintained consolidation policies. You can update them via the memory tool (key: \`_consolidation_instructions\`). Constraints: (1) each instruction must be a consolidation rule or response policy. (2) The total instruction set is capped at 2000 characters. (3) A healthy consolidation pass identifies clusters, synthesizes summaries, and exits — do not create work beyond what the candidates show.

${instructions}

## Consolidation Candidates
${candidateSection}

## Stale Summaries
${staleSection}

## Memory Stats
${pressureSection}

Review the candidates above. Identify clusters that warrant summary, synthesize them, and connect edges. If nothing needs consolidating, respond briefly with what you observed.`;
}

function loadConsolidationInstructions(db: Database): string {
	const row = db
		.prepare("SELECT value FROM semantic_memory WHERE key = ? AND deleted = 0")
		.get("_consolidation_instructions") as { value: string } | null;
	return row?.value ?? DEFAULT_CONSOLIDATION_INSTRUCTIONS;
}

interface MemoryEntry {
	key: string;
	snippet: string;
	modified_at: string;
}

function buildCandidateSection(db: Database): string {
	// Group default-tier entries by their prefix (the part before the first ':')
	// and list clusters with 3+ entries that don't have a parent summary.
	const entries = db
		.prepare(
			`SELECT key, substr(value, 1, 120) AS snippet, modified_at
			 FROM semantic_memory
			 WHERE tier = 'default' AND deleted = 0
			   AND (key LIKE 'curiosity:%' OR key LIKE 'research:%')
			 ORDER BY key`,
		)
		.all() as MemoryEntry[];

	if (entries.length === 0) return "No unconsolidated entries found.";

	// Group by prefix up to the last ':' before any date/timestamp
	const groups = new Map<string, MemoryEntry[]>();
	for (const entry of entries) {
		const colonIdx = entry.key.lastIndexOf(":");
		// Use the key up to the last colon as the group key, but if the last
		// segment looks like a date (starts with 2026/2025), use the prefix before it
		let groupKey = entry.key;
		if (colonIdx > 0) {
			const lastSegment = entry.key.slice(colonIdx + 1);
			if (/^(2025|2026)/.test(lastSegment)) {
				// Strip the date suffix to group entries from different dates
				groupKey = entry.key.slice(0, colonIdx);
			}
		}

		const existing = groups.get(groupKey) ?? [];
		existing.push(entry);
		groups.set(groupKey, existing);
	}

	// Filter to clusters with 3+ entries that don't already have a summary
	const clusters: string[] = [];
	for (const [prefix, items] of groups) {
		if (items.length < 3) continue;

		// Check if a summary already exists for this prefix
		const summaryKey = `_summary:${prefix}`;
		const hasSummary = db
			.prepare("SELECT 1 FROM semantic_memory WHERE key = ? AND deleted = 0")
			.get(summaryKey);

		if (hasSummary) continue;

		clusters.push(
			`### ${prefix} (${items.length} entries)\n${items.map((e) => `- ${e.key}: ${e.snippet}`).join("\n")}`,
		);
	}

	if (clusters.length === 0) return "All candidate clusters already have summaries.";

	return clusters.join("\n\n");
}

interface StaleSummary {
	key: string;
	stale_children: number;
}

function buildStaleSummarySection(db: Database): string {
	const stale = db
		.prepare(
			`SELECT DISTINCT s.key,
			        SUM(CASE WHEN c.modified_at > s.modified_at THEN 1 ELSE 0 END) AS stale_children
			 FROM semantic_memory s
			 JOIN memory_edges e ON e.source_key = s.key AND e.relation = 'summarizes' AND e.deleted = 0
			 JOIN semantic_memory c ON c.key = e.target_key AND c.deleted = 0
			 WHERE s.tier = 'summary' AND s.deleted = 0
			 GROUP BY s.key
			 HAVING stale_children > 0
			 ORDER BY stale_children DESC`,
		)
		.all() as StaleSummary[];

	if (stale.length === 0) return "No stale summaries found.";

	return stale
		.map((s) => `- ${s.key}: ${s.stale_children} children modified since last summary`)
		.join("\n");
}

interface TierCount {
	tier: string;
	n: number;
}

function buildPressureSection(db: Database): string {
	const rows = db
		.prepare(
			"SELECT tier, COUNT(*) AS n FROM semantic_memory WHERE deleted=0 GROUP BY tier",
		)
		.all() as TierCount[];

	const parts = rows.map((r) => `${r.tier}=${r.n}`).join(", ");
	const total = rows.reduce((sum, r) => sum + r.n, 0);
	return `${total} total (${parts})`;
}
