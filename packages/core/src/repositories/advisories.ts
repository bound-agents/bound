import type { Database } from "bun:sqlite";
import type { Advisory } from "@bound/shared";
import type { NotNull } from "kysely";
import { getAll, getOne, queryBuilder } from "../query-builder";

/** Statuses an advisory never leaves; excluded from the "active" listings. */
const TERMINAL_ADVISORY_STATUSES = ["applied", "dismissed"];

/** Live (`deleted = 0`) advisory rows. */
function liveAdvisories() {
	return queryBuilder.selectFrom("advisories").where("deleted", "=", 0);
}

/** Every column of a live advisory row, typed as the shared `Advisory`. */
function liveAdvisoryRows() {
	return liveAdvisories().selectAll().$castTo<Advisory>();
}

/** Summary projection of live advisory rows. */
function liveAdvisorySummaries() {
	return liveAdvisories().select(["id", "type", "status", "title", "detail"]);
}

export function findAdvisoryById(db: Database, id: string): Advisory | null {
	return getOne(
		db,
		queryBuilder.selectFrom("advisories").selectAll().$castTo<Advisory>().where("id", "=", id),
	);
}

export function findActiveAdvisoryById(db: Database, id: string): Advisory | null {
	return getOne(
		db,
		queryBuilder
			.selectFrom("advisories")
			.selectAll()
			.$castTo<Advisory>()
			.where("id", "=", id)
			.where("deleted", "=", 0),
	);
}

export function countProposedAdvisories(db: Database): number {
	const row = getOne(
		db,
		liveAdvisories()
			.select((eb) => eb.fn.countAll<number>().as("count"))
			.where("status", "=", "proposed"),
	);
	// COUNT(*) without GROUP BY always yields one row.
	return row?.count ?? 0;
}

/** Non-deleted advisories filtered to a single status, newest-proposed first. */
export function listAdvisoriesByStatus(db: Database, status: string): Advisory[] {
	return getAll(db, liveAdvisoryRows().where("status", "=", status).orderBy("proposed_at", "desc"));
}

/** Non-deleted advisories excluding terminal (applied/dismissed) states, newest-proposed first. */
export function listActiveAdvisories(db: Database): Advisory[] {
	return getAll(
		db,
		liveAdvisoryRows()
			.where("status", "not in", TERMINAL_ADVISORY_STATUSES)
			.orderBy("proposed_at", "desc"),
	);
}

/**
 * Every non-deleted advisory of a given type, regardless of status (includes the
 * terminal `applied`/`dismissed` states that {@link listActiveAdvisories}
 * excludes), newest-proposed first. The reconciler uses this to dedup raises
 * against operator-acted rows — a reference an operator already dismissed must
 * not re-raise a fresh `proposed` row every pass — and, together with
 * `created_by`, to scope auto-resolve to this host's own rows so two hosts with
 * divergent `hosts` replicas don't soft-delete and re-raise each other's rows.
 */
export function listAdvisoriesByType(db: Database, type: string): Advisory[] {
	return getAll(db, liveAdvisoryRows().where("type", "=", type).orderBy("proposed_at", "desc"));
}

/** IDs, titles, and resolved_at of applied, non-deleted advisories resolved at or after a cutoff. */
export function listAppliedAdvisoriesResolvedSince(
	db: Database,
	resolvedSince: string,
): Array<{ id: string; title: string; resolved_at: string }> {
	return getAll(
		db,
		queryBuilder
			.selectFrom("advisories")
			.select(["id", "title", "resolved_at"])
			.where("status", "=", "applied")
			.where("deleted", "=", 0)
			.where("resolved_at", "is not", null)
			.where("resolved_at", ">=", resolvedSince)
			.orderBy("resolved_at", "desc")
			.$narrowType<{ resolved_at: NotNull }>(),
	);
}

/** Ids of non-deleted advisories whose id starts with a prefix (capped at 2 for ambiguity check). */
export function findAdvisoryIdsByPrefix(db: Database, prefix: string): Array<{ id: string }> {
	return getAll(
		db,
		queryBuilder
			.selectFrom("advisories")
			.select("id")
			.where("id", "like", `${prefix}%`)
			.where("deleted", "=", 0)
			.limit(2),
	);
}

type AdvisoryListItem = {
	id: string;
	type: string;
	status: string;
	title: string;
	detail: string;
};

/** Summary fields for non-deleted advisories of a given status, newest-proposed first, capped at 20. */
export function listAdvisorySummariesByStatus(db: Database, status: string): AdvisoryListItem[] {
	return getAll(
		db,
		liveAdvisorySummaries().where("status", "=", status).orderBy("proposed_at", "desc").limit(20),
	);
}

/** Summary fields for non-deleted, non-terminal advisories, newest-proposed first, capped at 20. */
export function listActiveAdvisorySummaries(db: Database): AdvisoryListItem[] {
	return getAll(
		db,
		liveAdvisorySummaries()
			.where("status", "not in", TERMINAL_ADVISORY_STATUSES)
			.orderBy("proposed_at", "desc")
			.limit(20),
	);
}
