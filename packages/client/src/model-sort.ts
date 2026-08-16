import type { ClusterModelInfo } from "./types";

/**
 * Stable model selector order shared by ACP, boundless, and the web UI.
 * ACP historically presents IDs in descending lexical order; clone before
 * sorting so callers never mutate the API response or reactive store input.
 * Host breaks duplicate-ID ties deterministically.
 */
export function sortClusterModelsById(models: readonly ClusterModelInfo[]): ClusterModelInfo[] {
	return [...models].sort((a, b) => b.id.localeCompare(a.id) || a.host.localeCompare(b.host));
}
