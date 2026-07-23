import type { Database } from "bun:sqlite";
import type { Agent } from "@bound/shared";

/**
 * Read repository for the `agents` table (#201 auxiliary-agent identities).
 * See ./index.ts for conventions. Writes go through insertRow/updateRow/
 * softDelete (invariant #1), never here.
 *
 * Two orthogonal "is this live?" axes, and finders are explicit about both:
 *  - `deleted = 0` — the sync tombstone (invariant #2). Every finder filters it.
 *  - `retired_at IS NULL` — domain state. A retired identity is hidden from
 *    list/invoke but its memory namespace stays readable, so the retire/update
 *    paths need finders that see retired rows while dispatch/list do not.
 */

/**
 * Dispatch resolution: name -> the active (non-retired, non-deleted) definition.
 * `name` is deliberately not UNIQUE (synced tables can't enforce cluster-wide
 * uniqueness — two hosts may define the same name offline and both must
 * converge), so resolution is deterministic via `modified_at DESC`: the most
 * recently written definition wins, and `list` surfaces any duplicates for the
 * operator/agent to retire one.
 */
export function findActiveAgentByName(db: Database, name: string): Agent | null {
	return db
		.query(
			"SELECT * FROM agents WHERE name = ? AND retired_at IS NULL AND deleted = 0 ORDER BY modified_at DESC LIMIT 1",
		)
		.get(name) as Agent | null;
}

/**
 * Name -> definition INCLUDING retired (but not sync-deleted) rows, newest
 * first. For the update/retire paths, which must find a retired identity to
 * un-retire or to re-confirm its namespace is still addressable.
 */
export function findAgentByNameIncludingRetired(db: Database, name: string): Agent | null {
	return db
		.query("SELECT * FROM agents WHERE name = ? AND deleted = 0 ORDER BY modified_at DESC LIMIT 1")
		.get(name) as Agent | null;
}

/** Full row by id, active only (non-deleted). Includes retired rows. */
export function findAgentById(db: Database, id: string): Agent | null {
	return db.query("SELECT * FROM agents WHERE id = ? AND deleted = 0").get(id) as Agent | null;
}

/** Existence check by id (no `deleted` filter — matches the raw read-back). */
export function findAgentIdById(db: Database, id: string): { id: string } | null {
	return db.query("SELECT id FROM agents WHERE id = ?").get(id) as { id: string } | null;
}

/**
 * All active identities (non-retired, non-deleted), ordered by name. The
 * `list` action's source set and the tool-description enumeration.
 */
export function listActiveAgents(db: Database): Agent[] {
	return db
		.query("SELECT * FROM agents WHERE retired_at IS NULL AND deleted = 0 ORDER BY name ASC")
		.all() as Agent[];
}

/**
 * Agent list view for the tool description / `list` action: the fields the
 * main agent needs to decide whether to reuse an identity or mint a new one —
 * name, persona (who it IS), default model. Active identities only, ordered by
 * name.
 */
export function listAgentsForToolView(db: Database): Array<{
	name: string;
	persona: string;
	model_hint: string | null;
}> {
	return db
		.query(
			`SELECT name, persona, model_hint
			 FROM agents
			 WHERE retired_at IS NULL AND deleted = 0
			 ORDER BY name ASC`,
		)
		.all() as Array<{
		name: string;
		persona: string;
		model_hint: string | null;
	}>;
}
