import type { Database } from "bun:sqlite";
import type { SyncedTableName } from "@bound/shared";
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
