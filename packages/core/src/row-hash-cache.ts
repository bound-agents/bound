import type { Database } from "bun:sqlite";
import { type SyncedTableName, createLogger } from "@bound/shared";
import { CryptoHasher } from "bun";
import { getPkColumn, validateColumnName } from "./change-log.js";

const HASH_EXCLUDED_COLUMNS = new Set(["modified_at"]);
const IN_BATCH_SIZE = 500;
const logger = createLogger("core", "row-hash-cache");
let warnedMissingCacheTable = false;
const cacheTableExists = new WeakMap<Database, boolean>();

function compareUtf8Bytes(left: Uint8Array, right: Uint8Array): number {
	const length = Math.min(left.length, right.length);
	for (let index = 0; index < length; index++) {
		const difference = (left[index] ?? 0) - (right[index] ?? 0);
		if (difference !== 0) return difference;
	}
	return left.length - right.length;
}

function utf8Range(pks: readonly string[]): [string, string] {
	const encoder = new TextEncoder();
	let first = pks[0];
	let last = pks[0];
	if (first === undefined || last === undefined) throw new Error("non-empty PK list expected");
	let firstBytes = encoder.encode(first);
	let lastBytes = firstBytes;
	for (const pk of pks.slice(1)) {
		const bytes = encoder.encode(pk);
		if (compareUtf8Bytes(bytes, firstBytes) < 0) {
			first = pk;
			firstBytes = bytes;
		}
		if (compareUtf8Bytes(bytes, lastBytes) > 0) {
			last = pk;
			lastBytes = bytes;
		}
	}
	return [first, last];
}

function canonicalSerialize(row: Record<string, unknown>): string {
	const keys = Object.keys(row)
		.filter((key) => !HASH_EXCLUDED_COLUMNS.has(key))
		.sort();
	let out = "{";
	for (let index = 0; index < keys.length; index++) {
		if (index > 0) out += ",";
		const key = keys[index];
		out += `${JSON.stringify(key)}:${JSON.stringify(row[key] ?? null)}`;
	}
	return `${out}}`;
}

/** Deterministic state hash shared by cache warming and consistency comparison. */
export function computeRowStateHash(row: Record<string, unknown>): string {
	const hasher = new CryptoHasher("sha256");
	hasher.update(canonicalSerialize(row));
	return hasher.digest("hex");
}

export interface CachedRowStateHashes {
	hashes: Map<string, string>;
	cacheHitCount: number;
	cacheMissCount: number;
}

/**
 * Resolve state hashes for a page without scanning its table. Cache misses alone
 * select full rows and are populated before the surrounding consistency exchange
 * observes the returned map.
 */
export function getCachedRowStateHashes(
	db: Database,
	table: SyncedTableName,
	pks: readonly string[],
): CachedRowStateHashes {
	if (pks.length === 0) return { hashes: new Map(), cacheHitCount: 0, cacheMissCount: 0 };
	const uniquePks = [...new Set(pks)];
	const hashes = new Map<string, string>();
	const missing: string[] = [];
	let cacheExists = cacheTableExists.get(db) === true;
	if (!cacheExists) {
		cacheExists =
			db
				.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'row_state_hashes'")
				.get() !== null;
		if (cacheExists) cacheTableExists.set(db, true);
	}
	if (!cacheExists) {
		if (!warnedMissingCacheTable) {
			warnedMissingCacheTable = true;
			logger.warn("Row state hash cache table is absent; falling back to uncached hashes", {
				event: "row_state_hash_cache_unavailable",
				table,
			});
		}
		const pkColumn = getPkColumn(table);
		validateColumnName(pkColumn);
		for (let start = 0; start < uniquePks.length; start += IN_BATCH_SIZE) {
			const batch = uniquePks.slice(start, start + IN_BATCH_SIZE);
			const rows = db
				.query(`SELECT * FROM ${table} WHERE ${pkColumn} IN (${batch.map(() => "?").join(", ")})`)
				.all(...batch) as Array<Record<string, unknown>>;
			for (const row of rows) hashes.set(String(row[pkColumn]), computeRowStateHash(row));
		}
		return { hashes, cacheHitCount: 0, cacheMissCount: uniquePks.length };
	}
	const resolve = db.transaction(() => {
		const requested = new Set(uniquePks);
		const [firstPk, lastPk] = utf8Range(uniquePks);
		const cached = db
			.query(
				"SELECT pk, state_hash FROM row_state_hashes WHERE table_name = ? AND pk >= ? AND pk <= ? ORDER BY pk ASC",
			)
			.all(table, firstPk, lastPk) as Array<{ pk: string; state_hash: string }>;
		for (const row of cached) if (requested.has(row.pk)) hashes.set(row.pk, row.state_hash);
		for (const pk of uniquePks) if (!hashes.has(pk)) missing.push(pk);
		const pkColumn = getPkColumn(table);
		validateColumnName(pkColumn);
		for (let start = 0; start < missing.length; start += IN_BATCH_SIZE) {
			const batch = missing.slice(start, start + IN_BATCH_SIZE);
			const placeholders = batch.map(() => "?").join(", ");
			const rows = db
				.query(`SELECT * FROM ${table} WHERE ${pkColumn} IN (${placeholders})`)
				.all(...batch) as Array<Record<string, unknown>>;
			for (const row of rows) {
				const pk = String(row[pkColumn]);
				const stateHash = computeRowStateHash(row);
				hashes.set(pk, stateHash);
				db.run(
					"INSERT INTO row_state_hashes (table_name, pk, state_hash, hashed_at) VALUES (?, ?, ?, ?) ON CONFLICT(table_name, pk) DO UPDATE SET state_hash = excluded.state_hash, hashed_at = excluded.hashed_at",
					[table, pk, stateHash, new Date().toISOString()],
				);
			}
		}
	});
	resolve();
	return {
		hashes,
		cacheHitCount: uniquePks.length - missing.length,
		cacheMissCount: missing.length,
	};
}
