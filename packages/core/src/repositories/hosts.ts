import type { Database } from "bun:sqlite";
import type { Host } from "@bound/shared";

export function listHostsOrderedByName(db: Database): Host[] {
	return db.query("SELECT * FROM hosts WHERE deleted = 0 ORDER BY host_name ASC").all() as Host[];
}

/**
 * Existence check WITHOUT the `deleted = 0` filter: host registration keys
 * solely on `site_id`, so a tombstoned row still counts.
 */
export function findHostSiteIdById(db: Database, siteId: string): { site_id: string } | null {
	return db.query("SELECT site_id FROM hosts WHERE site_id = ?").get(siteId) as {
		site_id: string;
	} | null;
}

export function listHostSiteIdAndName(db: Database): Array<{ site_id: string; host_name: string }> {
	return db.query("SELECT site_id, host_name FROM hosts WHERE deleted = 0").all() as Array<{
		site_id: string;
		host_name: string;
	}>;
}

export function findHostSiteIdAndNameById(
	db: Database,
	siteId: string,
): { site_id: string; host_name: string } | null {
	return db
		.query("SELECT site_id, host_name FROM hosts WHERE site_id = ? AND deleted = 0")
		.get(siteId) as { site_id: string; host_name: string } | null;
}

export function listHostsWithLiveness(db: Database): Array<{
	site_id: string;
	host_name: string;
	online_at: string | null;
	modified_at: string | null;
}> {
	return db
		.query("SELECT site_id, host_name, online_at, modified_at FROM hosts WHERE deleted = 0")
		.all() as Array<{
		site_id: string;
		host_name: string;
		online_at: string | null;
		modified_at: string | null;
	}>;
}

export function listAllHostModels(db: Database): Array<{ models: string | null }> {
	return db.query("SELECT models FROM hosts WHERE deleted = 0").all() as Array<{
		models: string | null;
	}>;
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
	return db
		.query(
			`SELECT host_name, models, online_at, modified_at
			 FROM hosts
			 WHERE deleted = 0 AND models IS NOT NULL AND site_id != ?`,
		)
		.all(localSiteId) as Array<{
		host_name: string;
		models: string;
		online_at: string | null;
		modified_at: string | null;
	}>;
}

export function listHostSyncTargets(
	db: Database,
): Array<{ site_id: string; host_name: string; sync_url: string | null }> {
	return db
		.query("SELECT site_id, host_name, sync_url FROM hosts WHERE deleted = 0")
		.all() as Array<{ site_id: string; host_name: string; sync_url: string | null }>;
}

export function listHostMcpInfo(db: Database): Array<{
	site_id: string;
	host_name: string;
	online_at: string | null;
	mcp_servers: string | null;
	mcp_tool_annotations: string | null;
	mcp_capabilities: string | null;
}> {
	return db
		.query(
			"SELECT site_id, host_name, online_at, mcp_servers, mcp_tool_annotations, mcp_capabilities FROM hosts WHERE deleted = 0 ORDER BY host_name",
		)
		.all() as Array<{
		site_id: string;
		host_name: string;
		online_at: string | null;
		mcp_servers: string | null;
		mcp_tool_annotations: string | null;
		mcp_capabilities: string | null;
	}>;
}

export function listHostSiteIdNameAndModels(
	db: Database,
): Array<{ site_id: string; host_name: string; models: string | null }> {
	return db.query("SELECT site_id, host_name, models FROM hosts WHERE deleted = 0").all() as Array<{
		site_id: string;
		host_name: string;
		models: string | null;
	}>;
}

/** Includes tombstones because bootstrap updates the physical host row in place. */
export function findHostRowForChangeLog<T>(db: Database, siteId: string): T | null {
	return db.query("SELECT * FROM hosts WHERE site_id = ?").get(siteId) as T | null;
}

/** R-DW14 capability finder. A missing/legacy advertisement is conservatively false. */
export function findHostWorkSpoolCapabilityById(
	db: Database,
	siteId: string,
): { work_spool_capable: number } | null {
	return db
		.query("SELECT work_spool_capable FROM hosts WHERE site_id = ? AND deleted = 0")
		.get(siteId) as { work_spool_capable: number } | null;
}
