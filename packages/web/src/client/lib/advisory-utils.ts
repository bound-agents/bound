import type { Advisory } from "@bound/shared";

export interface DedupedAdvisory {
	representative: Advisory;
	count: number;
	sources: Advisory[];
}

export function deduplicateAdvisories(advisories: Advisory[]): DedupedAdvisory[] {
	// Group by title + status
	const groups = new Map<string, Advisory[]>();

	for (const advisory of advisories) {
		const key = `${advisory.title}|${advisory.status}`;
		if (!groups.has(key)) {
			groups.set(key, []);
		}
		groups.get(key)?.push(advisory);
	}

	// Convert groups to DedupedAdvisory entries
	const deduped: DedupedAdvisory[] = [];
	for (const sources of groups.values()) {
		// Sort sources by proposed_at descending (most recent first)
		const sorted = [...sources].sort(
			(a, b) => new Date(b.proposed_at).getTime() - new Date(a.proposed_at).getTime(),
		);
		deduped.push({
			representative: sorted[0],
			count: sources.length,
			sources: sorted,
		});
	}

	// Sort deduped advisories:
	// 1. Unresolved first (proposed, approved)
	// 2. Then resolved (applied, dismissed, deferred)
	// 3. Within each group, by most recent proposed_at (descending)

	const unresolvedStatuses = new Set(["proposed", "approved"]);

	const sorted = [...deduped].sort((a, b) => {
		const aUnresolved = unresolvedStatuses.has(a.representative.status);
		const bUnresolved = unresolvedStatuses.has(b.representative.status);

		// If one is unresolved and the other isn't, unresolved comes first
		if (aUnresolved !== bUnresolved) {
			return aUnresolved ? -1 : 1;
		}

		// Within the same group (both resolved or both unresolved),
		// sort by most recent proposed_at
		return (
			new Date(b.representative.proposed_at).getTime() -
			new Date(a.representative.proposed_at).getTime()
		);
	});

	return sorted;
}
