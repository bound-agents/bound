import type { Database } from "bun:sqlite";
import type { SyncedTableName } from "@bound/shared";
import { CryptoHasher } from "bun";
import { getPkColumn } from "./change-log.js";

export interface TableDiff {
	table: SyncedTableName;
	localCount: number;
	remoteCount: number;
	localOnly: string[];
	remoteOnly: string[];
	matching: number;
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
	let query = `SELECT ${pkCol} AS pk FROM ${table} ORDER BY ${pkCol} ASC`;
	if (table === "messages") {
		query = `SELECT ${pkCol} AS pk FROM ${table} WHERE role != 'system' ORDER BY ${pkCol} ASC`;
	}
	const rows = db.query(query).all() as Array<{ pk: string }>;
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
	const allSyncedTables: SyncedTableName[] = [
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
		"turns",
	];
	const tablesToCheck = tables ?? allSyncedTables;
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

// ── A1: per-row state hashing for state-aware backfill ──────────────────────

/**
 * Columns excluded from row hashing. The sync apply path bumps `modified_at`
 * on the receiving side, so including it would cause perpetual hash mismatches
 * between peers that have semantically identical rows. All other columns
 * participate, including `deleted`, `tier`, `value`, etc. — which is precisely
 * how this protocol detects tier flips, soft-delete tombstones, and value
 * mutations that PK-set diff misses.
 */
const HASH_EXCLUDED_COLUMNS = new Set(["modified_at"]);

/**
 * Canonical serialization for hash computation. Must be deterministic across
 * peers: keys sorted alphabetically, undefined coerced to null, JSON-encoded
 * with no whitespace. We do not rely on JS's native object-key insertion
 * order; we explicitly sort.
 */
function canonicalSerialize(row: Record<string, unknown>): string {
	const keys = Object.keys(row)
		.filter((k) => !HASH_EXCLUDED_COLUMNS.has(k))
		.sort();
	let out = "{";
	for (let i = 0; i < keys.length; i++) {
		if (i > 0) out += ",";
		const k = keys[i];
		const v = row[k];
		out += `${JSON.stringify(k)}:${JSON.stringify(v ?? null)}`;
	}
	out += "}";
	return out;
}

/**
 * Compute a deterministic SHA-256 hex hash over a row's content, excluding
 * `modified_at`. Used by the state-aware backfill protocol to detect
 * divergence on rows whose primary key exists on both sides.
 */
export function hashRow(row: Record<string, unknown>): string {
	const hasher = new CryptoHasher("sha256");
	hasher.update(canonicalSerialize(row));
	return hasher.digest("hex");
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
	let query = `SELECT * FROM ${table} ORDER BY ${pkCol} ASC`;
	if (table === "messages") {
		query = `SELECT * FROM ${table} WHERE role != 'system' ORDER BY ${pkCol} ASC`;
	}
	const rows = db.query(query).all() as Array<Record<string, unknown>>;
	return rows.map((row) => ({
		pk: String(row[pkCol]),
		hash: hashRow(row),
		modified_at: typeof row.modified_at === "string" ? row.modified_at : null,
	}));
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
