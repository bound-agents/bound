import type { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import type { Advisory, Result } from "@bound/shared";

export function createAdvisory(
	db: Database,
	advisory: Omit<
		Advisory,
		"id" | "proposed_at" | "modified_at" | "created_by" | "defer_until" | "resolved_at"
	>,
	siteId: string,
): string {
	const id = randomUUID();
	const now = new Date().toISOString();

	db.prepare(
		`INSERT INTO advisories (id, type, status, title, detail, action, impact, evidence, proposed_at, modified_at, created_by)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
	).run(
		id,
		advisory.type,
		"proposed",
		advisory.title,
		advisory.detail,
		advisory.action,
		advisory.impact,
		advisory.evidence,
		now,
		now,
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
		db.prepare(
			"UPDATE advisories SET status = ?, resolved_at = ?, modified_at = ? WHERE id = ?",
		).run("approved", now, now, advisoryId);
		return { ok: true };
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
		db.prepare(
			"UPDATE advisories SET status = ?, resolved_at = ?, modified_at = ? WHERE id = ?",
		).run("dismissed", now, now, advisoryId);
		return { ok: true };
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
		const now = new Date().toISOString();
		db.prepare(
			"UPDATE advisories SET status = ?, defer_until = ?, modified_at = ? WHERE id = ?",
		).run("deferred", deferUntil, now, advisoryId);
		return { ok: true };
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
		db.prepare(
			"UPDATE advisories SET status = ?, resolved_at = ?, modified_at = ? WHERE id = ?",
		).run("applied", now, now, advisoryId);
		return { ok: true };
	} catch (error) {
		return {
			ok: false,
			error: error instanceof Error ? error : new Error("Unknown error"),
		};
	}
}

export function getPendingAdvisories(db: Database): Advisory[] {
	const now = new Date().toISOString();

	const advisories = db
		.prepare(
			`SELECT * FROM advisories
			 WHERE status IN ('proposed', 'deferred')
			 AND (status = 'proposed' OR (status = 'deferred' AND defer_until < ?))
			 ORDER BY proposed_at DESC`,
		)
		.all(now) as Advisory[];

	return advisories;
}
