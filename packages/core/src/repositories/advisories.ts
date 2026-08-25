import type { Database } from "bun:sqlite";
import type { Advisory } from "@bound/shared";

/** Read repository for the `advisories` table. See ./index.ts for conventions. */

export function findAdvisoryById(db: Database, id: string): Advisory | null {
	return db.query("SELECT * FROM advisories WHERE id = ?").get(id) as Advisory | null;
}

export function listPendingAdvisories(db: Database): Advisory[] {
	return db
		.query(
			"SELECT * FROM advisories WHERE status = 'proposed' AND deleted = 0 ORDER BY proposed_at DESC",
		)
		.all() as Advisory[];
}

/** Single non-deleted advisory by id. */
export function findActiveAdvisoryById(db: Database, id: string): Advisory | null {
	return db
		.query("SELECT * FROM advisories WHERE id = ? AND deleted = 0")
		.get(id) as Advisory | null;
}

/** Count of proposed, non-deleted advisories. */
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

/** Resolved advisories created by a site within a recency cutoff (approved/applied/dismissed). */
export function listResolvedAdvisoriesByCreator(
	db: Database,
	createdBy: string,
	resolvedAfter: string,
): Array<{ title: string; status: string; resolved_at: string }> {
	return db
		.query(
			`SELECT title, status, resolved_at FROM advisories
			 WHERE created_by = ?
			   AND status IN ('approved', 'applied', 'dismissed')
			   AND resolved_at > ?
			   AND deleted = 0
			 ORDER BY resolved_at DESC`,
		)
		.all(createdBy, resolvedAfter) as Array<{
		title: string;
		status: string;
		resolved_at: string;
	}>;
}

/** Titles of proposed, non-deleted advisories, oldest-proposed first. */
export function listProposedAdvisoryTitles(db: Database): Array<{ title: string }> {
	return db
		.query(
			"SELECT title FROM advisories WHERE deleted = 0 AND status = 'proposed' ORDER BY proposed_at ASC",
		)
		.all() as Array<{ title: string }>;
}

/** Title/status of non-deleted advisories resolved after a cutoff, newest-resolved first. */
export function listAdvisoriesResolvedAfter(
	db: Database,
	resolvedAfter: string,
): Array<{ title: string; status: string }> {
	return db
		.query(
			"SELECT title, status FROM advisories WHERE deleted = 0 AND resolved_at > ? ORDER BY resolved_at DESC",
		)
		.all(resolvedAfter) as Array<{ title: string; status: string }>;
}

/** Ids of non-deleted advisories in a given status resolved before a cutoff. */
export function listAdvisoryIdsByStatusResolvedBefore(
	db: Database,
	status: string,
	resolvedBefore: string,
): Array<{ id: string }> {
	return db
		.prepare(
			`SELECT id FROM advisories
			 WHERE deleted = 0 AND status = ? AND resolved_at < ?`,
		)
		.all(status, resolvedBefore) as Array<{ id: string }>;
}

/** Pending advisories: proposed, or deferred whose defer window has elapsed. Oldest-proposed first. */
export function listActionableAdvisories(db: Database, now: string): Advisory[] {
	return db
		.prepare(
			`SELECT * FROM advisories
			 WHERE deleted = 0
			 AND (status = 'proposed' OR (status = 'deferred' AND defer_until < ?))
			 ORDER BY proposed_at ASC, rowid ASC`,
		)
		.all(now) as Advisory[];
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

/** Per-creator count of proposed, non-deleted advisories. */
export function countProposedAdvisoriesByCreator(
	db: Database,
): Array<{ created_by: string; count: number }> {
	return db
		.prepare(
			`SELECT created_by, COUNT(*) as count
			 FROM advisories
			 WHERE deleted = 0 AND status = 'proposed'
			 GROUP BY created_by`,
		)
		.all() as Array<{ created_by: string; count: number }>;
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
