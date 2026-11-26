import type { Database } from "bun:sqlite";
import type { Advisory } from "@bound/shared";

export function findAdvisoryById(db: Database, id: string): Advisory | null {
	return db.query("SELECT * FROM advisories WHERE id = ?").get(id) as Advisory | null;
}

export function findActiveAdvisoryById(db: Database, id: string): Advisory | null {
	return db
		.query("SELECT * FROM advisories WHERE id = ? AND deleted = 0")
		.get(id) as Advisory | null;
}

export function countProposedAdvisories(db: Database): number {
	const row = db
		.query("SELECT COUNT(*) as count FROM advisories WHERE deleted = 0 AND status = 'proposed'")
		.get() as { count: number };
	return row.count;
}

/** Non-deleted advisories filtered to a single status, newest-proposed first. */
export function listAdvisoriesByStatus(db: Database, status: string): Advisory[] {
	return db
		.query("SELECT * FROM advisories WHERE deleted = 0 AND status = ? ORDER BY proposed_at DESC")
		.all(status) as Advisory[];
}

/** Non-deleted advisories excluding terminal (applied/dismissed) states, newest-proposed first. */
export function listActiveAdvisories(db: Database): Advisory[] {
	return db
		.query(
			"SELECT * FROM advisories WHERE deleted = 0 AND status NOT IN ('applied', 'dismissed') ORDER BY proposed_at DESC",
		)
		.all() as Advisory[];
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
	return db
		.query("SELECT * FROM advisories WHERE deleted = 0 AND type = ? ORDER BY proposed_at DESC")
		.all(type) as Advisory[];
}

/** IDs, titles, and resolved_at of applied, non-deleted advisories resolved at or after a cutoff. */
export function listAppliedAdvisoriesResolvedSince(
	db: Database,
	resolvedSince: string,
): Array<{ id: string; title: string; resolved_at: string }> {
	return db
		.query(
			"SELECT id, title, resolved_at FROM advisories WHERE status = 'applied' AND deleted = 0 AND resolved_at IS NOT NULL AND resolved_at >= ? ORDER BY resolved_at DESC",
		)
		.all(resolvedSince) as Array<{ id: string; title: string; resolved_at: string }>;
}

/** Ids of non-deleted advisories whose id starts with a prefix (capped at 2 for ambiguity check). */
export function findAdvisoryIdsByPrefix(db: Database, prefix: string): Array<{ id: string }> {
	return db
		.prepare("SELECT id FROM advisories WHERE id LIKE ? AND deleted = 0 LIMIT 2")
		.all(`${prefix}%`) as Array<{ id: string }>;
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
	return db
		.prepare(
			"SELECT id, type, status, title, detail FROM advisories WHERE deleted = 0 AND status = ? ORDER BY proposed_at DESC LIMIT 20",
		)
		.all(status) as AdvisoryListItem[];
}

/** Summary fields for non-deleted, non-terminal advisories, newest-proposed first, capped at 20. */
export function listActiveAdvisorySummaries(db: Database): AdvisoryListItem[] {
	return db
		.prepare(
			"SELECT id, type, status, title, detail FROM advisories WHERE deleted = 0 AND status NOT IN ('applied', 'dismissed') ORDER BY proposed_at DESC LIMIT 20",
		)
		.all() as AdvisoryListItem[];
}
