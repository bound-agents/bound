import type { Database } from "bun:sqlite";
import { type SyncedTableName, createLogger } from "@bound/shared";
import { CryptoHasher } from "bun";
import { getPkColumn, validateColumnName } from "./change-log.js";

const HASH_EXCLUDED_COLUMNS = new Set(["modified_at"]);
const IN_BATCH_SIZE = 500;
const logger = createLogger("core", "row-hash-cache");
let warnedMissingCacheTable = false;

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
	const cacheExists = db
		.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'row_state_hashes'")
		.get();
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
		for (let start = 0; start < uniquePks.length; start += IN_BATCH_SIZE) {
			const batch = uniquePks.slice(start, start + IN_BATCH_SIZE);
			const placeholders = batch.map(() => "?").join(", ");
			const cached = db
				.query(
					`SELECT pk, state_hash FROM row_state_hashes WHERE table_name = ? AND pk IN (${placeholders})`,
				)
				.all(table, ...batch) as Array<{ pk: string; state_hash: string }>;
			for (const row of cached) hashes.set(row.pk, row.state_hash);
		}
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
