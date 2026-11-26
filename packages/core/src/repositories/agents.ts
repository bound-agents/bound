import type { Database } from "bun:sqlite";
import type { Agent } from "@bound/shared";
import type { NotNull } from "kysely";
import { getAll, getOne, queryBuilder } from "../query-builder";

/**
 * Read repository for the `agents` table (#201 auxiliary-agent identities).
 *
 * Two orthogonal "is this live?" axes, and finders are explicit about both:
 *  - `deleted = 0` — the sync tombstone (invariant #2). Every finder filters it.
 *  - `retired_at IS NULL` — domain state. A retired identity is hidden from
 *    list/invoke but its memory namespace stays readable, so the retire/update
 *    paths need finders that see retired rows while dispatch/list do not.
 */

/** `Agent` treats `deleted` as non-null; the schema declares it nullable with a default. */
const fullAgentRows = () =>
	queryBuilder.selectFrom("agents").selectAll().$narrowType<{ deleted: NotNull }>();

/**
 * Dispatch resolution: name -> the active (non-retired, non-deleted) definition.
 * `name` is deliberately not UNIQUE (synced tables can't enforce cluster-wide
 * uniqueness — two hosts may define the same name offline and both must
 * converge), so resolution is deterministic via `modified_at DESC`: the most
 * recently written definition wins, and `list` surfaces any duplicates for the
 * operator/agent to retire one.
 */
export function findActiveAgentByName(db: Database, name: string): Agent | null {
	return getOne(
		db,
		fullAgentRows()
			.where("name", "=", name)
			.where("retired_at", "is", null)
			.where("deleted", "=", 0)
			.orderBy("modified_at", "desc")
			.limit(1),
	);
}

/**
 * Name -> definition INCLUDING retired (but not sync-deleted) rows, newest
 * first. For the update/retire paths, which must find a retired identity to
 * un-retire or to re-confirm its namespace is still addressable.
 */
export function findAgentByNameIncludingRetired(db: Database, name: string): Agent | null {
	return getOne(
		db,
		fullAgentRows()
			.where("name", "=", name)
			.where("deleted", "=", 0)
			.orderBy("modified_at", "desc")
			.limit(1),
	);
}

/** Full row by id, active only (non-deleted). Includes retired rows. */
export function findAgentById(db: Database, id: string): Agent | null {
	return getOne(db, fullAgentRows().where("id", "=", id).where("deleted", "=", 0));
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
	return getAll(
		db,
		queryBuilder
			.selectFrom("agents")
			.select(["name", "persona", "model_hint"])
			.where("retired_at", "is", null)
			.where("deleted", "=", 0)
			.orderBy("name", "asc"),
	);
}
