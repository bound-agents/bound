import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { getSiteId, insertRow, updateRow } from "@bound/core";
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
		// Read mcp.json
		const mcpPath = resolve(configDir, "mcp.json");
		let mcpContent: string;
		try {
			mcpContent = readFileSync(mcpPath, "utf-8");
		} catch (error) {
			throw new Error(
				`Failed to read ${mcpPath}: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
		// Parse JSON
		let mcpData: unknown;
		try {
			mcpData = JSON.parse(mcpContent);
		} catch (error) {
			throw new Error(
				`Failed to parse mcp.json: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
		// Validate schema
		const validationResult = mcpSchema.safeParse(mcpData);
		if (!validationResult.success) {
			const issues = validationResult.error.issues
				.map((issue) => `  - ${issue.path.join(".")}: ${issue.message}`)
				.join("\n");
			throw new Error(`MCP configuration validation failed:\n${issues}`);
		}
		const mcpConfig = validationResult.data;
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
		const existing = db.query("SELECT key FROM cluster_config WHERE key = ?").get(key);
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
