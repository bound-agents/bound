import { dirname, join, resolve } from "node:path";
import {
	findClusterConfigKeyByKeyIncludingDeleted,
	getSiteId,
	insertRow,
	loadConfigWithPrecedence,
	updateRow,
} from "@bound/core";
import { mcpSchema } from "@bound/shared";
import { openBoundDB } from "../lib/db";
export interface ConfigReloadArgs {
	target: string;
	configDir?: string;
}
export async function runConfigReload(args: ConfigReloadArgs): Promise<void> {
	const configDir = args.configDir || "config";
	// Assume data directory is sibling to config directory
	const dataDir = join(dirname(resolve(configDir)), "data");
	if (args.target !== "mcp") {
		throw new Error(`unsupported config target: ${args.target} (supported targets: mcp)`);
	}
	console.log(`Reloading ${args.target} configuration...`);
	const db = openBoundDB(dataDir);
	try {
		// Get site_id from host_meta for change-log
		const siteId = getSiteId(db);
		if (siteId === "unknown") {
			throw new Error("Failed to read site_id from database. Database may not be initialized.");
		}
		// Evaluate and validate the precedence-selected mcp.js / mcp.json candidate
		// before notifying the daemon. A bad JavaScript config never triggers a reload.
		const mcpResult = await loadConfigWithPrecedence(configDir, "mcp", mcpSchema);
		if (!mcpResult.ok) {
			throw new Error(`Failed to load ${mcpResult.error.filename}: ${mcpResult.error.message}`);
		}
		const mcpConfig = mcpResult.value;

		// Check for name collisions (duplicate server names)
		const serverNames = new Set<string>();
		for (const server of mcpConfig.servers) {
			if (serverNames.has(server.name)) {
				throw new Error(`duplicate server name: ${server.name}`);
			}
			serverNames.add(server.name);
		}
		// Write config_reload_requested entry to cluster_config. Probe ignoring
		// `deleted` so a previously soft-deleted key is un-tombstoned via UPDATE
		// rather than colliding on INSERT.
		const now = new Date().toISOString();
		const key = "config_reload_requested";
		const existing = findClusterConfigKeyByKeyIncludingDeleted(db, key);
		if (existing) {
			updateRow(db, "cluster_config", key, { value: now, deleted: 0 }, siteId);
		} else {
			insertRow(db, "cluster_config", { key, value: now, modified_at: now, deleted: 0 }, siteId);
		}
		console.log("Configuration reload requested successfully.");
		console.log("The orchestrator will pick up the change on next poll.");
	} finally {
		db.close();
	}
}
