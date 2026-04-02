import { formatError } from "@bound/shared";

import type { CommandContext, CommandDefinition, CommandResult } from "@bound/sandbox";

interface HostRow {
	site_id: string;
	host_name: string;
	version: string | null;
	sync_url: string | null;
	mcp_servers: string | null;
	mcp_tools: string | null;
	models: string | null;
	overlay_root: string | null;
	online_at: string | null;
	modified_at: string;
}

export const hostinfo: CommandDefinition = {
	name: "hostinfo",
	args: [],
	handler: async (_args: Record<string, string>, ctx: CommandContext): Promise<CommandResult> => {
		try {
			const hosts = ctx.db
				.prepare("SELECT * FROM hosts WHERE deleted = 0 ORDER BY host_name ASC")
				.all() as HostRow[];

			if (hosts.length === 0) {
				return {
					stdout: "No hosts registered.\n",
					stderr: "",
					exitCode: 0,
				};
			}

			const lines: string[] = [];
			for (const host of hosts) {
				lines.push(`Host: ${host.host_name}`);
				lines.push(`  site_id:     ${host.site_id}`);
				lines.push(`  version:     ${host.version ?? "(unknown)"}`);
				lines.push(`  sync_url:    ${host.sync_url ?? "(none)"}`);
				lines.push(`  overlay:     ${host.overlay_root ?? "(none)"}`);
				lines.push(`  online_at:   ${host.online_at ?? "(never)"}`);
				lines.push(`  modified_at: ${host.modified_at}`);
				if (host.models) {
					lines.push(`  models:      ${host.models}`);
				}
				if (host.mcp_servers) {
					lines.push(`  mcp_servers: ${host.mcp_servers}`);
				}
				lines.push("");
			}

			return {
				stdout: lines.join("\n"),
				stderr: "",
				exitCode: 0,
			};
		} catch (error) {
			const message = formatError(error);
			return {
				stdout: "",
				stderr: `Error: ${message}\n`,
				exitCode: 1,
			};
		}
	},
};
