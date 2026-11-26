import type { Database } from "bun:sqlite";
import type { SyncedTableName } from "@bound/shared";
import { CryptoHasher } from "bun";
import { CONSISTENCY_TABLES, getPkColumn, validateColumnName } from "./change-log.js";
import { getCachedRowStateHashes } from "./row-hash-cache.js";

export interface TableDiff {
	table: SyncedTableName;
	localCount: number;
	remoteCount: number;
	localOnly: string[];
	remoteOnly: string[];
	matching: number;
}

/**
 * SQL predicate (without the `WHERE` keyword) selecting only the rows of a
 * synced table that may participate in cross-host sync, or `null` when every
 * row is syncable.
 *
 * Single source of truth for invariant #19: `role='system'` messages are
 * forbidden in the `messages` table and rejected by the reducer, so they must
 * never enter the backfill diff. This predicate MUST be applied identically on
 * both sides of the diff — the *advertising* side (`streamConsistencyPages`,
 * which enumerates a peer's rows) and the *comparing* side (the
 * `getBackfillable*` helpers). Filtering one side but not the other makes the
 * unsyncable rows perpetually appear as `remoteOnly`, so every backfill cycle
 * re-pulls the same rows without ever converging (a hot, self-perpetuating
 * full-table scan). Route both sides through this function so they cannot drift.
 */
export function syncableRowPredicate(table: SyncedTableName): string | null {
	if (table === "messages") return "role != 'system'";
	return null;
}

/** Compose `syncableRowPredicate` into a ` WHERE ...` fragment (empty when null). */
export function syncableWhereClause(table: SyncedTableName): string {
	const predicate = syncableRowPredicate(table);
	return predicate ? ` WHERE ${predicate}` : "";
}

export function getLocalPksSorted(db: Database, table: SyncedTableName): string[] {
	const pkCol = getPkColumn(table);
	const rows = db
		.query(`SELECT ${pkCol} AS pk FROM ${table} ORDER BY ${pkCol} ASC`)
		.all() as Array<{ pk: string }>;
	return rows.map((r) => r.pk);
}

export function getBackfillablePksSorted(db: Database, table: SyncedTableName): string[] {
	const pkCol = getPkColumn(table);
	const rows = db
		.query(`SELECT ${pkCol} AS pk FROM ${table}${syncableWhereClause(table)} ORDER BY ${pkCol} ASC`)
		.all() as Array<{ pk: string }>;
	return rows.map((r) => r.pk);
}

export function countUnsyncableLocalOnly(
	db: Database,
	localOnlyPks: string[],
): { table: string; count: number; reason: string }[] {
	if (localOnlyPks.length === 0) return [];
	const results: { table: string; count: number; reason: string }[] = [];
	let systemCount = 0;
	for (const pk of localOnlyPks) {
		const row = db.query("SELECT role FROM messages WHERE id = ?").get(pk) as {
			role: string;
		} | null;
		if (row?.role === "system") systemCount++;
	}
	if (systemCount > 0) {
		results.push({
			table: "messages",
			count: systemCount,
			reason: "role='system' (invariant #19, hub rejects these)",
		});
	}
	return results;
}

export function mergeDiffPks(
	localPks: string[],
	remotePks: string[],
): { localOnly: string[]; remoteOnly: string[]; matching: number } {
	const localOnly: string[] = [];
	const remoteOnly: string[] = [];
	let matching = 0;
	let li = 0;
	let ri = 0;

	while (li < localPks.length && ri < remotePks.length) {
		const cmp = localPks[li] < remotePks[ri] ? -1 : localPks[li] > remotePks[ri] ? 1 : 0;
		if (cmp < 0) {
			localOnly.push(localPks[li]);
			li++;
		} else if (cmp > 0) {
			remoteOnly.push(remotePks[ri]);
			ri++;
		} else {
			matching++;
			li++;
			ri++;
		}
	}

	while (li < localPks.length) {
		localOnly.push(localPks[li]);
		li++;
	}
	while (ri < remotePks.length) {
		remoteOnly.push(remotePks[ri]);
		ri++;
	}

	return { localOnly, remoteOnly, matching };
}

export function compareAllTables(
	db: Database,
	remoteTables: Map<string, { count: number; pks: string[] }>,
	tables?: SyncedTableName[],
): TableDiff[] {
	const tablesToCheck = tables ?? CONSISTENCY_TABLES;
	const results: TableDiff[] = [];

	for (const table of tablesToCheck) {
		const localPks = getLocalPksSorted(db, table);
		const remote = remoteTables.get(table);
		if (!remote) {
			results.push({
				table,
				localCount: localPks.length,
				remoteCount: 0,
				localOnly: localPks,
				remoteOnly: [],
				matching: 0,
			});
			continue;
		}
		const diff = mergeDiffPks(localPks, remote.pks);
		results.push({
			table,
			localCount: localPks.length,
			remoteCount: remote.count,
			localOnly: diff.localOnly,
			remoteOnly: diff.remoteOnly,
			matching: diff.matching,
		});
	}

	return results;
}

/**
 * Per-row entry in the consistency check protocol. `modified_at` is included
 * when the row has it (most synced tables) so the receiver can do
 * bidirectional last-writer-wins resolution on mismatched hashes without
 * blindly clobbering newer local state.
 */
export interface ConsistencyEntry {
	pk: string;
	hash: string;
	modified_at: string | null;
}

/**
 * Spoke-side helper: fetch all backfillable rows from the table, hash each,
 * and return sorted entries. Matches the `messages.role != 'system'` filter
 * from `getBackfillablePksSorted` (system messages are reducer-rejected).
 */
export function getBackfillableEntriesSorted(
	db: Database,
	table: SyncedTableName,
): ConsistencyEntry[] {
	const pkCol = getPkColumn(table);
	const query = `SELECT ${pkCol}, modified_at FROM ${table}${syncableWhereClause(table)} ORDER BY ${pkCol} ASC`;
	const rows = db.query(query).all() as Array<Record<string, unknown>>;
	const cached = getCachedRowStateHashes(
		db,
		table,
		rows.map((row) => String(row[pkCol])),
	);
	return rows.flatMap((row) => {
		const pk = String(row[pkCol]);
		const hash = cached.hashes.get(pk);
		return hash
			? [{ pk, hash, modified_at: typeof row.modified_at === "string" ? row.modified_at : null }]
			: [];
	});
}

/**
 * Hash-aware diff. Compared to `mergeDiffPks`, this also detects rows whose
 * PK exists on both sides but whose content (hash) differs, and routes them
 * by `modified_at` direction:
 * - localOnly: PK present locally only → push (fabricate change_log)
 * - remoteOnly: PK present remotely only → pull
 * - localNewerMismatch: hashes differ, local modified_at strictly greater → push
 * - remoteNewerMismatch: hashes differ, otherwise → pull
 *
 * On modified_at ties (or either side missing modified_at), the row falls
 * into remoteNewerMismatch — hub is treated as authoritative for tiebreakers,
 * matching existing snapshot-seeding semantics where the snapshot is the
 * source of truth.
 */
export interface ConsistencyDiff {
	localOnly: string[];
	remoteOnly: string[];
	localNewerMismatch: string[];
	remoteNewerMismatch: string[];
	matching: number;
}

export function mergeDiffEntries(
	local: ConsistencyEntry[],
	remote: ConsistencyEntry[],
): ConsistencyDiff {
	const localOnly: string[] = [];
	const remoteOnly: string[] = [];
	const localNewerMismatch: string[] = [];
	const remoteNewerMismatch: string[] = [];
	let matching = 0;
	let li = 0;
	let ri = 0;

	while (li < local.length && ri < remote.length) {
		const cmp = local[li].pk < remote[ri].pk ? -1 : local[li].pk > remote[ri].pk ? 1 : 0;
		if (cmp < 0) {
			localOnly.push(local[li].pk);
			li++;
		} else if (cmp > 0) {
			remoteOnly.push(remote[ri].pk);
			ri++;
		} else {
			if (local[li].hash === remote[ri].hash) {
				matching++;
			} else {
				const localMa = local[li].modified_at;
				const remoteMa = remote[ri].modified_at;
				// Local strictly newer → push. Otherwise (remote newer, equal,
				// or either side missing modified_at) → pull. Hub authoritative on ties.
				if (localMa != null && remoteMa != null && localMa > remoteMa) {
					localNewerMismatch.push(local[li].pk);
				} else {
					remoteNewerMismatch.push(local[li].pk);
				}
			}
			li++;
			ri++;
		}
	}

	while (li < local.length) {
		localOnly.push(local[li].pk);
		li++;
	}
	while (ri < remote.length) {
		remoteOnly.push(remote[ri].pk);
		ri++;
	}

	return { localOnly, remoteOnly, localNewerMismatch, remoteNewerMismatch, matching };
}

/** Wire format of a table state digest: version tag plus a hex SHA-256. */
const TABLE_STATE_DIGEST_PATTERN = /^v1:[0-9a-f]{64}$/;
const TABLE_STATE_DIGEST_PAGE_SIZE = 5000;

export interface TableStateDigest {
	digest: string;
	rowCount: number;
	cacheHitCount: number;
	cacheMissCount: number;
}

/** True only for a well-formed digest; anything else falls back to the row stream. */
export function isTableStateDigest(value: unknown): value is string {
	return typeof value === "string" && TABLE_STATE_DIGEST_PATTERN.test(value);
}

/**
 * Deterministic digest over the `(pk, row state hash)` pairs that
 * `getBackfillableEntriesSorted` would produce, in SQLite's binary PK order.
 * Two tables digest equal exactly when the state-aware row comparison would
 * find no drift (modulo SHA-256 collisions). It applies the same syncable-row
 * filter, reads only PKs plus the `row_state_hashes` cache, and hashes full
 * rows only for cache misses, which it populates.
 */
export function computeTableStateDigest(
	db: Database,
	table: SyncedTableName,
	pageSize = TABLE_STATE_DIGEST_PAGE_SIZE,
): TableStateDigest {
	const pkCol = getPkColumn(table);
	validateColumnName(pkCol);
	const predicate = syncableRowPredicate(table);
	const hasher = new CryptoHasher("sha256");
	let rowCount = 0;
	let cacheHitCount = 0;
	let cacheMissCount = 0;
	let cursor: string | undefined;
	for (;;) {
		const conditions = [predicate, cursor === undefined ? null : `${pkCol} > ?`].filter(
			(condition): condition is string => condition !== null,
		);
		const where = conditions.length > 0 ? ` WHERE ${conditions.join(" AND ")}` : "";
		const params = cursor === undefined ? [pageSize] : [cursor, pageSize];
		const rows = db
			.query(`SELECT ${pkCol} AS pk FROM ${table}${where} ORDER BY ${pkCol} ASC LIMIT ?`)
			.all(...params) as Array<{ pk: unknown }>;
		if (rows.length === 0) break;
		const pks = rows.map((row) => String(row.pk));
		const cached = getCachedRowStateHashes(db, table, pks);
		cacheHitCount += cached.cacheHitCount;
		cacheMissCount += cached.cacheMissCount;
		for (const pk of pks) {
			const hash = cached.hashes.get(pk);
			if (!hash) continue;
			hasher.update(`${JSON.stringify([pk, hash])}\n`);
			rowCount++;
		}
		if (rows.length < pageSize) break;
		cursor = pks[pks.length - 1];
	}
	return { digest: `v1:${hasher.digest("hex")}`, rowCount, cacheHitCount, cacheMissCount };
}
