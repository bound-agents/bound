import type { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import { insertRow, softDelete, updateRow } from "@bound/core";
import type { Advisory, Result } from "@bound/shared";

export function createAdvisory(
	db: Database,
	advisory: Omit<
		Advisory,
		"id" | "proposed_at" | "modified_at" | "created_by" | "defer_until" | "resolved_at" | "deleted"
	>,
	siteId: string,
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
			deleted: 0,
		},
		siteId,
	);

	return id;
}

export function approveAdvisory(
	db: Database,
	advisoryId: string,
	siteId: string,
): Result<void, Error> {
	try {
		const now = new Date().toISOString();
		updateRow(db, "advisories", advisoryId, { status: "approved", resolved_at: now }, siteId);
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
	siteId: string,
): Result<void, Error> {
	try {
		const now = new Date().toISOString();
		updateRow(db, "advisories", advisoryId, { status: "dismissed", resolved_at: now }, siteId);
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
	siteId: string,
): Result<void, Error> {
	try {
		updateRow(
			db,
			"advisories",
			advisoryId,
			{ status: "deferred", defer_until: deferUntil },
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
	siteId: string,
): Result<void, Error> {
	try {
		const now = new Date().toISOString();
		updateRow(db, "advisories", advisoryId, { status: "applied", resolved_at: now }, siteId);
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
