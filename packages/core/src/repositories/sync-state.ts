import type { Database } from "bun:sqlite";
import { HLC_ZERO, type SyncState } from "@bound/shared";
import type { NotNull } from "kysely";
import { getAll, getOne, queryBuilder } from "../query-builder";

export function getPeerSiteId(db: Database): string | undefined {
	try {
		const row = getOne(db, queryBuilder.selectFrom("sync_state").select("peer_site_id").limit(1));
		return row?.peer_site_id;
	} catch {
		return undefined;
	}
}

export function listSyncState(db: Database): SyncState[] {
	return getAll(
		db,
		queryBuilder
			.selectFrom("sync_state")
			.select([
				"peer_site_id",
				"last_received",
				"last_sent",
				"last_confirmed",
				"last_sync_at",
				"sync_errors",
			])
			// `SyncState` treats `sync_errors` as non-null; the column defaults to 0.
			.$narrowType<{ sync_errors: NotNull }>(),
	);
}

export function countSyncStatePeers(db: Database): number {
	const row = getOne(
		db,
		queryBuilder.selectFrom("sync_state").select((eb) => eb.fn.countAll<number>().as("count")),
	);
	return row?.count ?? 0;
}

export function getMinSyncReceivedHlc(db: Database): string {
	const row = getOne(
		db,
		queryBuilder
			.selectFrom("sync_state")
			.select((eb) => eb.fn.min<string | null>("last_received").as("min_hlc")),
	);
	return row?.min_hlc ?? HLC_ZERO;
}
