import type { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import { insertRow, softDelete, updateRow } from "@bound/core";
import type { Advisory, Result } from "@bound/shared";

/**
 * Provenance recorded on every advisory state transition (#192). `by` is the
 * actor that made the change — the literal `"agent"` when the change came
 * through the `advisory` tool, or an operator user id on the web path. `note`
 * is the required rationale/outcome, so a later reader (usually the agent
 * itself) has context for why an advisory was approved/dismissed/applied.
 */
export interface AdvisoryResolution {
	note: string;
	by: string;
}

export function createAdvisory(
	db: Database,
	advisory: Omit<
		Advisory,
		| "id"
		| "proposed_at"
		| "modified_at"
		| "created_by"
		| "defer_until"
		| "resolved_at"
		| "deleted"
		| "thread_id"
		| "resolved_by"
		| "resolution_note"
	>,
	siteId: string,
	threadId?: string | null,
): string {
	const id = randomUUID();
	const now = new Date().toISOString();

	insertRow(
		db,
		"advisories",
		{
			id,
			type: advisory.type,
			status: "proposed",
			title: advisory.title,
			detail: advisory.detail,
			action: advisory.action,
			impact: advisory.impact,
			evidence: advisory.evidence,
			proposed_at: now,
			defer_until: null,
			resolved_at: null,
			modified_at: now,
			created_by: siteId,
			thread_id: threadId ?? null,
			resolved_by: null,
			resolution_note: null,
			deleted: 0,
		},
		siteId,
	);

	return id;
}

export function approveAdvisory(
	db: Database,
	advisoryId: string,
	resolution: AdvisoryResolution,
	siteId: string,
): Result<void, Error> {
	try {
		const now = new Date().toISOString();
		updateRow(
			db,
			"advisories",
			advisoryId,
			{
				status: "approved",
				resolved_at: now,
				resolved_by: resolution.by,
				resolution_note: resolution.note,
			},
			siteId,
		);
		return { ok: true, value: undefined };
	} catch (error) {
		return {
			ok: false,
			error: error instanceof Error ? error : new Error("Unknown error"),
		};
	}
}

export function dismissAdvisory(
	db: Database,
	advisoryId: string,
	resolution: AdvisoryResolution,
	siteId: string,
): Result<void, Error> {
	try {
		const now = new Date().toISOString();
		updateRow(
			db,
			"advisories",
			advisoryId,
			{
				status: "dismissed",
				resolved_at: now,
				resolved_by: resolution.by,
				resolution_note: resolution.note,
			},
			siteId,
		);
		return { ok: true, value: undefined };
	} catch (error) {
		return {
			ok: false,
			error: error instanceof Error ? error : new Error("Unknown error"),
		};
	}
}

export function deferAdvisory(
	db: Database,
	advisoryId: string,
	deferUntil: string,
	resolution: AdvisoryResolution,
	siteId: string,
): Result<void, Error> {
	try {
		updateRow(
			db,
			"advisories",
			advisoryId,
			{
				status: "deferred",
				defer_until: deferUntil,
				resolved_by: resolution.by,
				resolution_note: resolution.note,
			},
			siteId,
		);
		return { ok: true, value: undefined };
	} catch (error) {
		return {
			ok: false,
			error: error instanceof Error ? error : new Error("Unknown error"),
		};
	}
}

export function applyAdvisory(
	db: Database,
	advisoryId: string,
	resolution: AdvisoryResolution,
	siteId: string,
): Result<void, Error> {
	try {
		const now = new Date().toISOString();
		updateRow(
			db,
			"advisories",
			advisoryId,
			{
				status: "applied",
				resolved_at: now,
				resolved_by: resolution.by,
				resolution_note: resolution.note,
			},
			siteId,
		);
		return { ok: true, value: undefined };
	} catch (error) {
		return {
			ok: false,
			error: error instanceof Error ? error : new Error("Unknown error"),
		};
	}
}

export function pruneResolvedAdvisories(db: Database, siteId: string): { pruned: number } {
	const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
	const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

	// Find applied advisories older than 7 days
	const appliedRows = db
		.prepare(
			`SELECT id FROM advisories
			 WHERE deleted = 0 AND status = 'applied' AND resolved_at < ?`,
		)
		.all(sevenDaysAgo) as Array<{ id: string }>;

	// Find dismissed advisories older than 1 day
	const dismissedRows = db
		.prepare(
			`SELECT id FROM advisories
			 WHERE deleted = 0 AND status = 'dismissed' AND resolved_at < ?`,
		)
		.all(oneDayAgo) as Array<{ id: string }>;

	// Use softDelete for changelog compliance
	for (const row of [...appliedRows, ...dismissedRows]) {
		softDelete(db, "advisories", row.id, siteId);
	}

	return { pruned: appliedRows.length + dismissedRows.length };
}

export function getPendingAdvisories(db: Database): Advisory[] {
	const now = new Date().toISOString();

	const advisories = db
		.prepare(
			`SELECT * FROM advisories
			 WHERE deleted = 0
			 AND (status = 'proposed' OR (status = 'deferred' AND defer_until < ?))
			 ORDER BY proposed_at ASC, rowid ASC`,
		)
		.all(now) as Advisory[];

	return advisories;
}

/**
 * True if a non-soft-deleted advisory with this exact title already exists, in
 * ANY status. Used to dedup the webhook dead-letter sweep: the prior reconciler
 * deduped only against `getPendingAdvisories` (proposed + due-deferred), so the
 * moment an operator *applied* the advisory it dropped out of that set and the
 * next sweep re-raised it — an apply-then-reraise churn loop. These advisories
 * describe a persistent infra condition, so an existing one in any active or
 * acknowledged state should suppress a re-raise; the operator can delete it to
 * force a fresh signal.
 */
export function hasAdvisoryWithTitle(db: Database, title: string): boolean {
	const row = db
		.prepare("SELECT 1 FROM advisories WHERE deleted = 0 AND title = ? LIMIT 1")
		.get(title);
	return row !== null;
}
