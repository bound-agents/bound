import type { Database } from "bun:sqlite";
import { sql } from "kysely";
import { getAll } from "../../query-builder";
import { attachedSessionLabelsQuery } from "./sql-fragments";

export interface AttachedSessionHostRow {
	/** host_name when known, else the raw site_id. */
	label: string;
}

/** Distinct holding-host labels for live client sessions on a thread. */
export function getAttachedSessionHosts(db: Database, threadId: string): AttachedSessionHostRow[] {
	return getAll(db, attachedSessionLabelsQuery(sql.val(threadId)));
}
