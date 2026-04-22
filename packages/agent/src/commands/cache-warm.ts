import { formatError } from "@bound/shared";

import type { CommandContext, CommandDefinition, CommandResult } from "@bound/sandbox";

export const cacheWarm: CommandDefinition = {
	name: "cache-warm",
	description: "Pre-warm the prompt cache for a thread",
	args: [{ name: "patterns", required: false, description: "Glob patterns of paths to warm" }],
	handler: async (_args: Record<string, string>, _ctx: CommandContext): Promise<CommandResult> => {
		try {
			// cache-warm is designed to pre-fetch files from remote hosts via MCP
			// MCP connectivity is configured via mcp.json and must be enabled in the network config
			return {
				stdout:
					"cache-warm: requires remote host connectivity configured via mcp.json (MCP proxy not yet implemented)\nTo enable MCP proxy, add remote host configuration to your mcp.json file.\n",
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
