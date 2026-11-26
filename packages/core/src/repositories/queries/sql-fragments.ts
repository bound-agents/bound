/**
 * SQL fragments shared by more than one repository module. Not re-exported from
 * the repository barrel.
 */

/**
 * Distinct holding-host labels (`host_name`, falling back to `site_id`) for the
 * live client sessions on `threadRef`, one per holding host, ordered `label ASC`.
 * `threadRef` is either a bind placeholder (`?`) or a correlated column (`t.id`).
 */
export function attachedSessionLabelsSql(threadRef: "?" | "t.id"): string {
	return `SELECT COALESCE(h.host_name, cs.site_id) as label
					FROM client_sessions cs
					LEFT JOIN hosts h ON h.site_id = cs.site_id AND h.deleted = 0
					WHERE cs.thread_id = ${threadRef} AND cs.deleted = 0
					GROUP BY cs.site_id, label
					ORDER BY label ASC`;
}

/**
 * Memory namespace predicate for an `agent_id` column: the main agent's
 * namespace is `agent_id IS NULL`; an aux agent's is `agent_id = ?`. Append
 * `params` once per use of `sql`.
 */
export function agentNamespace(agentId: string | null): {
	sql: "IS NULL" | "= ?";
	params: string[];
} {
	return agentId === null ? { sql: "IS NULL", params: [] } : { sql: "= ?", params: [agentId] };
}
