import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { getSiteId } from "@bound/core";
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
	const dbPath = join(dataDir, "bound.db");
	if (args.target !== "mcp") {
		console.error(`Error: unsupported config target: ${args.target}`);
		console.error("Supported targets: mcp");
		process.exit(1);
	}
	console.log(`Reloading ${args.target} configuration...`);
	try {
		const db = openBoundDB(dataDir);
		// Get site_id from host_meta for change-log
		const siteId = getSiteId(db);
		if (siteId === "unknown") {
			console.error("Failed to read site_id from database. Database may not be initialized.");
			db.close();
			process.exit(1);
		}
		// Read mcp.json
		const mcpPath = resolve(configDir, "mcp.json");
		let mcpContent: string;
		try {
			mcpContent = readFileSync(mcpPath, "utf-8");
		} catch (error) {
			console.error(`Failed to read ${mcpPath}:`, error);
			db.close();
			process.exit(1);
			return; // unreachable but satisfies TS
		}
		// Parse JSON
		let mcpData: unknown;
		try {
			mcpData = JSON.parse(mcpContent);
		} catch (error) {
			console.error("Failed to parse mcp.json:", error);
			db.close();
			process.exit(1);
			return; // unreachable but satisfies TS
		}
		// Validate schema
		const validationResult = mcpSchema.safeParse(mcpData);
		if (!validationResult.success) {
			console.error("MCP configuration validation failed:");
			for (const issue of validationResult.error.issues) {
				console.error(`  - ${issue.path.join(".")}: ${issue.message}`);
			}
			db.close();
			process.exit(1);
		}
		const mcpConfig = validationResult.data;
		// Check for name collisions (duplicate server names)
		const serverNames = new Set<string>();
		for (const server of mcpConfig.servers) {
			if (serverNames.has(server.name)) {
				console.error(`Error: duplicate server name: ${server.name}`);
				db.close();
				process.exit(1);
			}
			serverNames.add(server.name);
		}
		// Write config_reload_requested entry to cluster_config
		const now = new Date().toISOString();
		const key = "config_reload_requested";
		const existing = db.query("SELECT key FROM cluster_config WHERE key = ?").get(key);
		// Use transaction to write + log
		const txFn = db.transaction(() => {
			if (existing) {
				db.query("UPDATE cluster_config SET value = ?, modified_at = ? WHERE key = ?").run(
					now,
					now,
					key,
				);
			} else {
				db.query("INSERT INTO cluster_config (key, value, modified_at) VALUES (?, ?, ?)").run(
					key,
					now,
					now,
				);
			}
			// Write change_log entry
			const rowData = { key, value: now, modified_at: now };
			db.query(
				`INSERT INTO change_log (table_name, row_id, site_id, timestamp, row_data)
				 VALUES (?, ?, ?, ?, ?)`,
			).run("cluster_config", key, siteId, now, JSON.stringify(rowData));
		});
		txFn();
		console.log("Configuration reload requested successfully.");
		console.log("The orchestrator will pick up the change on next poll.");
		db.close();
	} catch (error) {
		console.error("Failed to reload configuration:", error);
		process.exit(1);
	}
}
