import type { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import { insertRow, updateRow } from "@bound/core";
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

export function getPendingAdvisories(db: Database): Advisory[] {
	const now = new Date().toISOString();

	const advisories = db
		.prepare(
			`SELECT * FROM advisories
			 WHERE status IN ('proposed', 'deferred')
			 AND (status = 'proposed' OR (status = 'deferred' AND defer_until < ?))
			 ORDER BY proposed_at ASC, rowid ASC`,
		)
		.all(now) as Advisory[];

	return advisories;
}
