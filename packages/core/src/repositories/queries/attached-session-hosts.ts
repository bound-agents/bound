import type { Database } from "bun:sqlite";
import { attachedSessionLabelsSql } from "./sql-fragments";

export interface AttachedSessionHostRow {
	/** host_name when known, else the raw site_id. */
	label: string;
}

/** Distinct holding-host labels for live client sessions on a thread. */
export function getAttachedSessionHosts(db: Database, threadId: string): AttachedSessionHostRow[] {
	return db
		.query(`SELECT label FROM (${attachedSessionLabelsSql("?")})`)
		.all(threadId) as AttachedSessionHostRow[];
}
