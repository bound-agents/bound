import type { Database } from "bun:sqlite";
import type { Host } from "@bound/shared";

/**
 * Read repository for the `hosts` table. See ./index.ts for conventions.
 * Note: `hosts` is keyed by `site_id`, not `id`.
 */

export function findHostBySiteId(db: Database, siteId: string): Host | null {
	return db.query("SELECT * FROM hosts WHERE site_id = ?").get(siteId) as Host | null;
}

export function listHosts(db: Database): Host[] {
	return db.query("SELECT * FROM hosts WHERE deleted = 0").all() as Host[];
}

export function listHostsOrderedByName(db: Database): Host[] {
	return db.query("SELECT * FROM hosts WHERE deleted = 0 ORDER BY host_name ASC").all() as Host[];
}

/**
 * Existence check WITHOUT the `deleted = 0` filter — intentionally matches the
 * registration read-back paths in bootstrap/inference/host-heartbeat, which key
 * solely on `site_id`.
 */
export function findHostSiteIdById(db: Database, siteId: string): { site_id: string } | null {
	return db.query("SELECT site_id FROM hosts WHERE site_id = ?").get(siteId) as {
		site_id: string;
	} | null;
}

/** Existence check WITH the `deleted = 0` filter (live host affinity probe). */
export function findLiveHostSiteIdById(db: Database, siteId: string): { site_id: string } | null {
	return db.query("SELECT site_id FROM hosts WHERE site_id = ? AND deleted = 0").get(siteId) as {
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

export function findHostNameById(db: Database, siteId: string): { host_name: string } | null {
	return db.query("SELECT host_name FROM hosts WHERE site_id = ? AND deleted = 0").get(siteId) as {
		host_name: string;
	} | null;
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

export function listHostPlatforms(db: Database): Array<{ platforms: string }> {
	return db
		.query("SELECT platforms FROM hosts WHERE deleted = 0 AND platforms IS NOT NULL")
		.all() as Array<{ platforms: string }>;
}

export function listHostSiteIdAndPlatforms(
	db: Database,
): Array<{ site_id: string; platforms: string }> {
	return db
		.query("SELECT site_id, platforms FROM hosts WHERE deleted = 0 AND platforms IS NOT NULL")
		.all() as Array<{ site_id: string; platforms: string }>;
}

export function listHostPlatformLivenessOrderedByRecency(
	db: Database,
	localSiteId: string,
): Array<{
	site_id: string;
	platforms: string;
	modified_at: string | null;
	online_at: string | null;
}> {
	return db
		.query(
			`SELECT site_id, platforms, modified_at, online_at FROM hosts
			 WHERE deleted = 0 AND platforms IS NOT NULL AND site_id != ?
			 ORDER BY COALESCE(modified_at, online_at) DESC`,
		)
		.all(localSiteId) as Array<{
		site_id: string;
		platforms: string;
		modified_at: string | null;
		online_at: string | null;
	}>;
}

export function listHostPlatformLivenessExcludingLocal(
	db: Database,
	localSiteId: string,
): Array<{
	site_id: string;
	platforms: string;
	modified_at: string | null;
	online_at: string | null;
}> {
	return db
		.query(
			`SELECT site_id, platforms, modified_at, online_at FROM hosts
			 WHERE deleted = 0 AND platforms IS NOT NULL AND site_id != ?`,
		)
		.all(localSiteId) as Array<{
		site_id: string;
		platforms: string;
		modified_at: string | null;
		online_at: string | null;
	}>;
}

export function listRemoteHostModels(
	db: Database,
	localSiteId: string,
): Array<{ models: string | null }> {
	return db
		.query("SELECT models FROM hosts WHERE deleted = 0 AND site_id != ?")
		.all(localSiteId) as Array<{ models: string | null }>;
}

export function listAllHostModels(db: Database): Array<{ models: string | null }> {
	return db.query("SELECT models FROM hosts WHERE deleted = 0").all() as Array<{
		models: string | null;
	}>;
}

export function listHostSiteIdAndModels(db: Database): Array<{ site_id: string; models: string }> {
	return db
		.query("SELECT site_id, models FROM hosts WHERE deleted = 0 AND models IS NOT NULL")
		.all() as Array<{ site_id: string; models: string }>;
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

export function listRemoteHostsWithModels(
	db: Database,
	localSiteId: string,
): Array<{
	site_id: string;
	host_name: string;
	sync_url: string | null;
	models: string | null;
	online_at: string | null;
	modified_at: string | null;
}> {
	return db
		.query(
			`SELECT site_id, host_name, sync_url, models, online_at, modified_at
			 FROM hosts
			 WHERE deleted = 0 AND site_id != ?`,
		)
		.all(localSiteId) as Array<{
		site_id: string;
		host_name: string;
		sync_url: string | null;
		models: string | null;
		online_at: string | null;
		modified_at: string | null;
	}>;
}

export function listRemoteHostsWithMcpTools(
	db: Database,
	localSiteId: string,
): Array<{
	site_id: string;
	host_name: string;
	sync_url: string | null;
	mcp_tools: string | null;
	online_at: string | null;
	modified_at: string | null;
}> {
	return db
		.query(
			`SELECT site_id, host_name, sync_url, mcp_tools, online_at, modified_at
			 FROM hosts
			 WHERE deleted = 0 AND site_id != ?`,
		)
		.all(localSiteId) as Array<{
		site_id: string;
		host_name: string;
		sync_url: string | null;
		mcp_tools: string | null;
		online_at: string | null;
		modified_at: string | null;
	}>;
}

export function findHostMcpToolsById(
	db: Database,
	siteId: string,
): { mcp_tools: string | null } | null {
	return db.query("SELECT mcp_tools FROM hosts WHERE site_id = ? AND deleted = 0").get(siteId) as {
		mcp_tools: string | null;
	} | null;
}

export function listHostSiteIdAndMcpTools(
	db: Database,
): Array<{ site_id: string; mcp_tools: string | null }> {
	return db.query("SELECT site_id, mcp_tools FROM hosts WHERE deleted = 0").all() as Array<{
		site_id: string;
		mcp_tools: string | null;
	}>;
}

export function listRemoteHostMcpTools(
	db: Database,
	localSiteId: string,
): Array<{ site_id: string; host_name: string; mcp_tools: string }> {
	return db
		.query(
			"SELECT site_id, host_name, mcp_tools FROM hosts WHERE deleted = 0 AND mcp_tools IS NOT NULL AND site_id != ?",
		)
		.all(localSiteId) as Array<{ site_id: string; host_name: string; mcp_tools: string }>;
}

export function findHostSyncTargetById(
	db: Database,
	siteId: string,
): {
	host_name: string | null;
	sync_url: string | null;
	modified_at: string | null;
	online_at: string | null;
} | null {
	return db
		.query(
			"SELECT host_name, sync_url, modified_at, online_at FROM hosts WHERE site_id = ? AND deleted = 0",
		)
		.get(siteId) as {
		host_name: string | null;
		sync_url: string | null;
		modified_at: string | null;
		online_at: string | null;
	} | null;
}

export function findHostLivenessById(
	db: Database,
	siteId: string,
): { modified_at: string | null; online_at: string | null } | null {
	return db
		.query("SELECT modified_at, online_at FROM hosts WHERE site_id = ? AND deleted = 0")
		.get(siteId) as { modified_at: string | null; online_at: string | null } | null;
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

export function listHostMcpCapabilities(db: Database): Array<{ mcp_capabilities: string }> {
	return db
		.query("SELECT mcp_capabilities FROM hosts WHERE deleted = 0 AND mcp_capabilities IS NOT NULL")
		.all() as Array<{ mcp_capabilities: string }>;
}

export function findHostMcpToolAnnotationsById(
	db: Database,
	siteId: string,
): { mcp_tool_annotations: string | null } | null {
	return db
		.query("SELECT mcp_tool_annotations FROM hosts WHERE site_id = ? AND deleted = 0")
		.get(siteId) as { mcp_tool_annotations: string | null } | null;
}

export function listHostCapabilityProfiles(db: Database): Array<{
	site_id: string;
	models: string | null;
	mcp_servers: string | null;
	platforms: string | null;
}> {
	return db
		.query("SELECT site_id, models, mcp_servers, platforms FROM hosts WHERE deleted = 0")
		.all() as Array<{
		site_id: string;
		models: string | null;
		mcp_servers: string | null;
		platforms: string | null;
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
