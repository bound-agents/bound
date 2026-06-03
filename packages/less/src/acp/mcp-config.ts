import type { McpServer } from "@agentclientprotocol/sdk";
import type { McpServerConfig } from "../config";

/**
 * Warning produced while converting an ACP-supplied MCP server to a boundless
 * config. `mapped` distinguishes a degraded mapping (server is usable but lost
 * something, e.g. http headers) from a full skip (transport unsupported).
 */
export interface McpConversionWarning {
	name: string;
	mapped: boolean;
	reason: string;
}

export interface AcpMcpConversion {
	configs: McpServerConfig[];
	warnings: McpConversionWarning[];
}

/**
 * Convert the `mcpServers` array an ACP client (e.g. Zed) sends on session/new
 * and session/load into boundless `McpServerConfig`s.
 *
 * Transport coverage mirrors what boundless's config schema supports:
 *  - stdio  -> stdio (command/args/env). The bare ACP variant carries no `type`
 *             discriminant; an explicit `type: "stdio"` is treated identically.
 *  - http   -> http (url). boundless's http config has no headers field, so any
 *             ACP-supplied headers are dropped with a degraded-mapping warning.
 *  - sse    -> unsupported (no boundless equivalent); skipped with a warning.
 *  - acp    -> unsupported (experimental nested-ACP transport); skipped.
 */
export function acpMcpServersToConfigs(servers: readonly McpServer[]): AcpMcpConversion {
	const configs: McpServerConfig[] = [];
	const warnings: McpConversionWarning[] = [];

	for (const server of servers) {
		const type = (server as { type?: string }).type;
		const name = (server as { name?: string }).name ?? "unnamed";

		if (type === "http") {
			const http = server as { name: string; url: string; headers?: unknown[] };
			if (Array.isArray(http.headers) && http.headers.length > 0) {
				warnings.push({
					name,
					mapped: true,
					reason: `${http.headers.length} HTTP header(s) dropped — boundless http config has no headers field`,
				});
			}
			configs.push({ transport: "http", name: http.name, url: http.url, enabled: true });
		} else if (type === "sse") {
			warnings.push({
				name,
				mapped: false,
				reason: "sse transport is not supported by boundless; server skipped",
			});
		} else if (type === "acp") {
			warnings.push({
				name,
				mapped: false,
				reason: "acp transport is not supported by boundless; server skipped",
			});
		} else {
			// stdio: bare variant (no `type`) or explicit `type: "stdio"`.
			const stdio = server as {
				name: string;
				command: string;
				args?: string[];
				env?: Array<{ name: string; value: string }>;
			};
			const env: Record<string, string> = {};
			for (const entry of stdio.env ?? []) env[entry.name] = entry.value;
			const config: McpServerConfig = {
				transport: "stdio",
				name: stdio.name,
				command: stdio.command,
				args: stdio.args ?? [],
				enabled: true,
			};
			if (Object.keys(env).length > 0) config.env = env;
			configs.push(config);
		}
	}

	return { configs, warnings };
}

/**
 * Merge ACP-supplied configs into boundless's own (config-file) MCP configs.
 * The config-file entry wins on a name collision — it is the operator's explicit
 * local choice and may carry secrets in `env` that a session param should not
 * silently shadow. Collisions are reported so the caller can warn.
 */
export function mergeMcpConfigs(
	base: readonly McpServerConfig[],
	extra: readonly McpServerConfig[],
): { merged: McpServerConfig[]; collisions: string[] } {
	const byName = new Map<string, McpServerConfig>();
	const collisions: string[] = [];
	for (const config of base) byName.set(config.name, config);
	for (const config of extra) {
		if (byName.has(config.name)) {
			collisions.push(config.name);
			continue;
		}
		byName.set(config.name, config);
	}
	return { merged: [...byName.values()], collisions };
}
