import { loadConfigWithPrecedence } from "@bound/core";
import { mcpSchema } from "@bound/shared";
import { openBoundDBWithSite, resolveDataDir, upsertClusterConfig } from "../lib/db";
export interface ConfigReloadArgs {
	target: string;
	configDir?: string;
}
export async function runConfigReload(args: ConfigReloadArgs): Promise<void> {
	const configDir = args.configDir || "config";
	const dataDir = resolveDataDir(configDir);
	if (args.target !== "mcp") {
		throw new Error(`unsupported config target: ${args.target} (supported targets: mcp)`);
	}
	console.log(`Reloading ${args.target} configuration...`);
	const { db, siteId } = openBoundDBWithSite(dataDir);
	try {
		// Evaluate and validate the precedence-selected mcp.js / mcp.json candidate
		// before notifying the daemon. A bad JavaScript config never triggers a reload.
		const mcpResult = await loadConfigWithPrecedence(configDir, "mcp", mcpSchema);
		if (!mcpResult.ok) {
			throw new Error(`Failed to load ${mcpResult.error.filename}: ${mcpResult.error.message}`);
		}
		const mcpConfig = mcpResult.value;

		const serverNames = new Set<string>();
		for (const server of mcpConfig.servers) {
			if (serverNames.has(server.name)) {
				throw new Error(`duplicate server name: ${server.name}`);
			}
			serverNames.add(server.name);
		}
		upsertClusterConfig(db, "config_reload_requested", new Date().toISOString(), siteId);
		console.log("Configuration reload requested successfully.");
		console.log("The orchestrator will pick up the change on next poll.");
	} finally {
		db.close();
	}
}
