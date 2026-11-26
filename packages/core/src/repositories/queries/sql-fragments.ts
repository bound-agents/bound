/**
 * Query fragments shared by more than one repository module. Not re-exported
 * from the repository barrel.
 */

import { type Expression, sql } from "kysely";
import { queryBuilder } from "../../query-builder";

/**
 * Distinct holding-host labels (`host_name`, falling back to `site_id`) for the
 * live client sessions on `threadRef`, one per holding host, ordered `label ASC`.
 * `threadRef` is a bound value or a correlated column reference (`sql.ref("t.id")`).
 */
export function attachedSessionLabelsQuery(threadRef: Expression<string>) {
	return queryBuilder
		.selectFrom("client_sessions as cs")
		.leftJoin("hosts as h", (join) =>
			join.onRef("h.site_id", "=", "cs.site_id").on("h.deleted", "=", 0),
		)
		.select(sql<string>`COALESCE(h.host_name, cs.site_id)`.as("label"))
		.where("cs.thread_id", "=", threadRef)
		.where("cs.deleted", "=", 0)
		.groupBy(["cs.site_id", sql`label`])
		.orderBy("label", "asc");
}
