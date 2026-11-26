import type { Database } from "bun:sqlite";
import type { Host } from "@bound/shared";
import type { NotNull } from "kysely";
import { getAll, getOne, queryBuilder } from "../query-builder";

export function listHostsOrderedByName(db: Database): Host[] {
	return getAll(
		db,
		queryBuilder
			.selectFrom("hosts")
			.selectAll()
			.where("deleted", "=", 0)
			.orderBy("host_name", "asc")
			// `Host` treats `deleted` as non-null; the filter above guarantees it.
			.$narrowType<{ deleted: NotNull }>(),
	);
}

/**
 * Existence check WITHOUT the `deleted = 0` filter: host registration keys
 * solely on `site_id`, so a tombstoned row still counts.
 */
export function findHostSiteIdById(db: Database, siteId: string): { site_id: string } | null {
	return getOne(
		db,
		queryBuilder.selectFrom("hosts").select("site_id").where("site_id", "=", siteId),
	);
}

export function listHostSiteIdAndName(db: Database): Array<{ site_id: string; host_name: string }> {
	return getAll(
		db,
		queryBuilder.selectFrom("hosts").select(["site_id", "host_name"]).where("deleted", "=", 0),
	);
}

export function findHostSiteIdAndNameById(
	db: Database,
	siteId: string,
): { site_id: string; host_name: string } | null {
	return getOne(
		db,
		queryBuilder
			.selectFrom("hosts")
			.select(["site_id", "host_name"])
			.where("site_id", "=", siteId)
			.where("deleted", "=", 0),
	);
}

export function listHostsWithLiveness(db: Database): Array<{
	site_id: string;
	host_name: string;
	online_at: string | null;
	modified_at: string | null;
}> {
	return getAll(
		db,
		queryBuilder
			.selectFrom("hosts")
			.select(["site_id", "host_name", "online_at", "modified_at"])
			.where("deleted", "=", 0),
	);
}

export function listAllHostModels(db: Database): Array<{ models: string | null }> {
	return getAll(db, queryBuilder.selectFrom("hosts").select("models").where("deleted", "=", 0));
}

export function listRemoteHostModelLiveness(
	db: Database,
	localSiteId: string,
): Array<{
	host_name: string;
	models: string;
	online_at: string | null;
	modified_at: string | null;
}> {
	return getAll(
		db,
		queryBuilder
			.selectFrom("hosts")
			.select(["host_name", "models", "online_at", "modified_at"])
			.where("deleted", "=", 0)
			.where("models", "is not", null)
			.where("site_id", "!=", localSiteId)
			.$narrowType<{ models: NotNull }>(),
	);
}

export function listHostSyncTargets(
	db: Database,
): Array<{ site_id: string; host_name: string; sync_url: string | null }> {
	return getAll(
		db,
		queryBuilder
			.selectFrom("hosts")
			.select(["site_id", "host_name", "sync_url"])
			.where("deleted", "=", 0),
	);
}

export function listHostMcpInfo(db: Database): Array<{
	site_id: string;
	host_name: string;
	online_at: string | null;
	mcp_servers: string | null;
	mcp_tool_annotations: string | null;
	mcp_capabilities: string | null;
}> {
	return getAll(
		db,
		queryBuilder
			.selectFrom("hosts")
			.select([
				"site_id",
				"host_name",
				"online_at",
				"mcp_servers",
				"mcp_tool_annotations",
				"mcp_capabilities",
			])
			.where("deleted", "=", 0)
			.orderBy("host_name"),
	);
}

export function listHostSiteIdNameAndModels(
	db: Database,
): Array<{ site_id: string; host_name: string; models: string | null }> {
	return getAll(
		db,
		queryBuilder
			.selectFrom("hosts")
			.select(["site_id", "host_name", "models"])
			.where("deleted", "=", 0),
	);
}

/**
 * Includes tombstones because bootstrap updates the physical host row in place.
 * The caller picks the row type `T`, so the builder's inferred row is widened to it.
 */
export function findHostRowForChangeLog<T>(db: Database, siteId: string): T | null {
	return getOne(
		db,
		queryBuilder.selectFrom("hosts").selectAll().where("site_id", "=", siteId),
	) as T | null;
}

/** R-DW14 capability finder. A missing/legacy advertisement is conservatively false. */
export function findHostWorkSpoolCapabilityById(
	db: Database,
	siteId: string,
): { work_spool_capable: number } | null {
	return getOne(
		db,
		queryBuilder
			.selectFrom("hosts")
			.select("work_spool_capable")
			.where("site_id", "=", siteId)
			.where("deleted", "=", 0),
	);
}
