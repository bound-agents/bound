import type { Database } from "bun:sqlite";
import {
	findMemoryIdByKeyIncludingDeleted,
	findMemoryValueByKey,
	insertRow,
	updateRow,
} from "@bound/core";
import { BOUND_NAMESPACE, createLogger, deterministicUUID } from "@bound/shared";

const logger = createLogger("@bound/agent", "validation");

/**
 * True when the run marker at `key` is absent, unparseable, or older than
 * `intervalMs`. An unparseable marker parses to NaN, and every NaN comparison
 * is false — without the explicit check it would suppress the run forever.
 */
export function isValidationDue(
	db: Database,
	key: string,
	nowMs: number,
	intervalMs: number,
): boolean {
	const row = findMemoryValueByKey(db, key);
	if (!row) return true;
	const lastRunMs = Date.parse(row.value);
	if (!Number.isFinite(lastRunMs)) return true;
	return nowMs - lastRunMs >= intervalMs;
}

/** Record a validator run at `nowMs` under the marker `key`. */
export function recordValidationRun(
	db: Database,
	siteId: string,
	key: string,
	source: string,
	nowMs: number,
): void {
	const iso = new Date(nowMs).toISOString();
	writeValidationEntry(db, siteId, { key, value: iso, source, nowMs });
}

/**
 * Upsert a `tier: "default"` validation entry. An existing row — including a
 * soft-deleted one, which the key's UNIQUE index still covers — is updated
 * and revived; otherwise a row is inserted under the key's deterministic id.
 * Validators are advisory, so a failed write is logged, never thrown.
 */
export function writeValidationEntry(
	db: Database,
	siteId: string,
	entry: { key: string; value: string; source: string; nowMs: number },
): void {
	const now = new Date(entry.nowMs).toISOString();
	try {
		const existing = findMemoryIdByKeyIncludingDeleted(db, entry.key);
		if (existing) {
			updateRow(
				db,
				"semantic_memory",
				existing.id,
				{ value: entry.value, modified_at: now, last_accessed_at: now, deleted: 0 },
				siteId,
			);
			return;
		}
		insertRow(
			db,
			"semantic_memory",
			{
				id: deterministicUUID(BOUND_NAMESPACE, entry.key),
				key: entry.key,
				value: entry.value,
				tier: "default",
				source: entry.source,
				modified_at: now,
				last_accessed_at: now,
				created_at: now,
				deleted: 0,
			},
			siteId,
		);
	} catch (error) {
		logger.warn("Validation entry write failed", {
			key: entry.key,
			error: error instanceof Error ? error.message : String(error),
		});
	}
}
