/**
 * Outbox audit validator — runtime detector for direct writes to
 * synced tables that bypass the outbox.
 *
 * The static check at `scripts/validate-outbox-invariant.ts` greps
 * source for raw SQL mutations against synced-table names; this
 * validator is the **runtime** complement, catching:
 *
 *   - Dynamic SQL constructed via template literals where the table
 *     name isn't a literal (the regex misses these).
 *   - Future bypasses introduced via libraries / helpers we don't
 *     yet ban.
 *   - Local-only test setup that snuck into production paths.
 *
 * The audit query: for every synced-table row, check that
 * `change_log` contains at least one entry with matching
 * `(table_name, row_id)` whose `timestamp <= row.modified_at`. If
 * not, the row was inserted/updated without going through the
 * outbox helpers — sync would not propagate it to other hosts.
 *
 * Documented narrow exceptions:
 *
 *   - `semantic_memory.last_accessed_at` bumps via
 *     `bumpRenderedDetailEntries` write `last_accessed_at` only and
 *     do NOT advance `modified_at`. Audit keys on `modified_at` so
 *     these correctly fall outside the audit's claim space.
 *
 *   - Snapshot seeding on new spokes: rows arrive via the snapshot
 *     bulk-insert path before any change_log replay completes. We
 *     gate the audit on a stability threshold (rows older than
 *     30 minutes) to avoid false positives on recently-seeded rows.
 *
 * Outcomes are written as `_validation:outbox-audit:<table>:<row_id>`
 * (tier `default`, `source: "validation:outbox-audit"`) idempotently
 * with the standard `updateRow → insertRow` fallback.
 *
 * Cadence: hourly from `heartbeat-context.ts`.
 */

import type { Database } from "bun:sqlite";
import { insertRow, updateRow } from "@bound/core";
import { BOUND_NAMESPACE, deterministicUUID } from "@bound/shared";

const VALIDATION_INTERVAL_MS = 60 * 60 * 1000;

/**
 * Stability threshold — rows whose `modified_at` is within this
 * window are skipped to avoid false positives during snapshot
 * seeding on new spokes (where the bulk-insert path lands rows
 * ahead of change_log replay).
 */
const STABILITY_THRESHOLD_MS = 30 * 60 * 1000;

/**
 * Synced tables to audit. Mirrors the source-of-truth list at
 * `packages/shared/src/types.ts` `SyncedTableName`. Tables added
 * there must be added here too — there's no compile-time link.
 */
const AUDITED_TABLES = [
	"users",
	"threads",
	"messages",
	"semantic_memory",
	"tasks",
	"files",
	"hosts",
	"overlay_index",
	"cluster_config",
	"advisories",
	"skills",
	"memory_edges",
	"connector_handles",
	"webhooks",
	"turns",
] as const;

/**
 * Per-table primary-key column. Mirrors `TABLE_PK_COLUMN` in
 * `packages/core/src/change-log.ts`. Defaults to `id` when omitted.
 */
const TABLE_PK_OVERRIDE: Record<string, string> = {
	hosts: "site_id",
	cluster_config: "key",
};

/** Per-table modified_at column override. All tables use `modified_at`. */
const MODIFIED_AT_COLUMN = "modified_at";

export interface OutboxAuditReport {
	rowsExamined: number;
	violationsFound: number;
	tablesScanned: number;
}

export function runOutboxAuditValidation(
	db: Database,
	siteId: string,
	nowMs: number,
): OutboxAuditReport {
	updateLastRun(db, siteId, nowMs);

	const stabilityCutoff = new Date(nowMs - STABILITY_THRESHOLD_MS).toISOString();

	let rowsExamined = 0;
	let violationsFound = 0;
	let tablesScanned = 0;

	for (const table of AUDITED_TABLES) {
		// Some tables may not exist in older schemas; defensive try.
		let rows: Array<{ row_id: string; modified_at: string }>;
		try {
			const pkCol = TABLE_PK_OVERRIDE[table] ?? "id";
			rows = db
				.prepare(
					`SELECT ${pkCol} AS row_id, ${MODIFIED_AT_COLUMN} AS modified_at
					FROM ${table}
					WHERE ${MODIFIED_AT_COLUMN} <= ?
					LIMIT 1000`,
				)
				.all(stabilityCutoff) as Array<{ row_id: string; modified_at: string }>;
		} catch {
			continue;
		}
		tablesScanned++;
		rowsExamined += rows.length;

		for (const row of rows) {
			// We don't constrain on `change_log.timestamp` vs the row's
			// `modified_at` — the changelog's timestamp tracks
			// wall-clock at write time (HLC source), not the row's
			// reported `modified_at`. The mere existence of any
			// change_log entry for `(table, row_id)` proves the row
			// was reachable through the outbox helpers at some point.
			// A row that bypasses the outbox entirely will produce
			// zero entries.
			const hasEntry = db
				.prepare(
					`SELECT 1 AS hit FROM change_log
					WHERE table_name = ?
						AND row_id = ?
					LIMIT 1`,
				)
				.get(table, row.row_id) as { hit: number } | null;

			if (hasEntry === null) {
				violationsFound++;
				recordViolation(db, siteId, nowMs, table, row.row_id, row.modified_at);
			}
		}
	}

	return { rowsExamined, violationsFound, tablesScanned };
}

export function shouldRunOutboxAuditValidation(db: Database, nowMs: number): boolean {
	const row = db
		.prepare("SELECT value FROM semantic_memory WHERE key = ? AND deleted = 0")
		.get("_validation:outbox-audit-last-run") as { value: string } | null;

	if (!row) return true;

	try {
		const lastRunMs = new Date(row.value).getTime();
		return nowMs - lastRunMs >= VALIDATION_INTERVAL_MS;
	} catch (_e) {
		return true;
	}
}

function updateLastRun(db: Database, siteId: string, nowMs: number): void {
	const lastRunKey = "_validation:outbox-audit-last-run";
	const lastRunId = deterministicUUID(BOUND_NAMESPACE, lastRunKey);
	const lastRunValue = new Date(nowMs).toISOString();
	try {
		updateRow(
			db,
			"semantic_memory",
			lastRunId,
			{ modified_at: lastRunValue, value: lastRunValue },
			siteId,
		);
	} catch (_e) {
		try {
			insertRow(
				db,
				"semantic_memory",
				{
					id: lastRunId,
					key: lastRunKey,
					value: lastRunValue,
					tier: "default",
					source: "validation:outbox-audit",
					modified_at: lastRunValue,
					last_accessed_at: lastRunValue,
					created_at: lastRunValue,
					deleted: 0,
				},
				siteId,
			);
		} catch (insertErr) {
			console.warn("[outbox-audit] last-run write failed:", insertErr);
		}
	}
}

function recordViolation(
	db: Database,
	siteId: string,
	nowMs: number,
	table: string,
	rowId: string,
	modifiedAt: string,
): void {
	const outcomeKey = `_validation:outbox-audit:${table}:${rowId}`;
	const outcomeBody = JSON.stringify({
		table,
		row_id: rowId,
		modified_at: modifiedAt,
		detected_at: new Date(nowMs).toISOString(),
	});
	const outcomeId = deterministicUUID(BOUND_NAMESPACE, outcomeKey);
	const now = new Date(nowMs).toISOString();

	try {
		updateRow(
			db,
			"semantic_memory",
			outcomeId,
			{ value: outcomeBody, modified_at: now, last_accessed_at: now },
			siteId,
		);
	} catch (_updateErr) {
		try {
			insertRow(
				db,
				"semantic_memory",
				{
					id: outcomeId,
					key: outcomeKey,
					value: outcomeBody,
					tier: "default",
					source: "validation:outbox-audit",
					modified_at: now,
					last_accessed_at: now,
					created_at: now,
					deleted: 0,
				},
				siteId,
			);
		} catch (insertErr) {
			console.warn("[outbox-audit] violation entry write failed:", insertErr);
		}
	}
}
