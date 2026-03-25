import type { CommandContext, CommandDefinition, CommandResult } from "@bound/sandbox";

/**
 * Registry of all commands — populated at startup by start.ts.
 * The help command reads from this to show available commands and syntax.
 */
let commandRegistry: CommandDefinition[] = [];

export function setCommandRegistry(commands: CommandDefinition[]): void {
	commandRegistry = commands;
}

export const help: CommandDefinition = {
	name: "commands",
	args: [
		{ name: "command", required: false, description: "Command name to get detailed help for" },
	],
	handler: async (args, ctx: CommandContext): Promise<CommandResult> => {
		const target = args.command;

		if (target) {
			// Detailed help for a specific command
			const cmd = commandRegistry.find((c) => c.name === target);
			if (!cmd) {
				return {
					stdout: "",
					stderr: `Unknown command: ${target}\nRun 'commands' to see all available commands.\n`,
					exitCode: 1,
				};
			}

			let output = `${cmd.name}`;
			if (cmd.args.length > 0) {
				const argSyntax = cmd.args
					.map((a) => (a.required ? `<${a.name}>` : `[${a.name}]`))
					.join(" ");
				output += ` ${argSyntax}`;
			}
			output += "\n";

			if (cmd.args.length > 0) {
				output += "\nArguments:\n";
				for (const arg of cmd.args) {
					const req = arg.required ? "(required)" : "(optional)";
					output += `  ${arg.name} ${req}`;
					if (arg.description) {
						output += ` — ${arg.description}`;
					}
					output += "\n";
				}
			}

			// For MCP tools, show the --key value syntax
			const isMCP =
				cmd.name.includes("-") &&
				!cmd.name.startsWith("cache-") &&
				!cmd.name.startsWith("model-") &&
				cmd.name !== "commands";
			if (isMCP) {
				const exampleArgs = cmd.args
					.filter((a) => a.required)
					.map((a) => `--${a.name} <value>`)
					.join(" ");
				output += `\nUsage: ${cmd.name} ${exampleArgs || "--key value"}\n`;
			}

			return { stdout: output, stderr: "", exitCode: 0 };
		}

		// List all commands
		let output = "Available commands:\n\n";

		const builtins = commandRegistry.filter(
			(c) => !c.name.includes("-") || c.name.startsWith("cache-") || c.name.startsWith("model-"),
		);
		const mcpTools = commandRegistry.filter(
			(c) =>
				c.name.includes("-") &&
				!c.name.startsWith("cache-") &&
				!c.name.startsWith("model-") &&
				c.name !== "commands",
		);

		// Get local MCP tool names from the MCPClient map
		const localMcpToolNames = new Set<string>();
		if (ctx.mcpClients) {
			for (const [serverName, client] of ctx.mcpClients) {
				try {
					const clientTyped = client as { listTools: () => Promise<Array<{ name: string }>> };
					const tools = await clientTyped.listTools();
					for (const tool of tools) {
						localMcpToolNames.add(`${serverName}-${tool.name}`);
					}
				} catch {
					// If we can't list tools, skip this client
				}
			}
		}

		// Get remote MCP tool names from hosts table
		const remoteMcpToolNames = new Set<string>();
		try {
			const hosts = ctx.db
				.prepare(
					"SELECT site_id, host_name, mcp_tools FROM hosts WHERE deleted = 0 AND mcp_tools IS NOT NULL",
				)
				.all() as Array<{ site_id: string; host_name: string; mcp_tools: string }>;
			for (const host of hosts) {
				try {
					const tools = JSON.parse(host.mcp_tools) as Array<{ server: string; name: string }>;
					for (const tool of tools) {
						const toolName = `${tool.server}-${tool.name}`;
						if (!localMcpToolNames.has(toolName)) {
							remoteMcpToolNames.add(toolName);
						}
					}
				} catch {
					// If we can't parse mcp_tools, skip this host
				}
			}
		} catch {
			// If query fails, skip remote tools
		}

		// Categorize MCP tools into local and remote
		const localMcp = mcpTools.filter((c) => localMcpToolNames.has(c.name));
		const remoteMcp = mcpTools.filter((c) => remoteMcpToolNames.has(c.name));

		if (builtins.length > 0) {
			output += "Built-in:\n";
			for (const cmd of builtins) {
				const argHint =
					cmd.args.length > 0
						? ` ${cmd.args.map((a) => (a.required ? `<${a.name}>` : `[${a.name}]`)).join(" ")}`
						: "";
				output += `  ${cmd.name}${argHint}\n`;
			}
		}

		if (localMcp.length > 0) {
			output += "\nLOCAL (MCP):\n";
			for (const cmd of localMcp) {
				output += `  ${cmd.name}\n`;
			}
		}

		if (remoteMcp.length > 0) {
			output += "\nREMOTE (via relay):\n";
			for (const cmd of remoteMcp) {
				// Try to find which host this tool comes from
				let hostInfo = "";
				try {
					const hosts = ctx.db
						.prepare(
							"SELECT site_id, host_name, mcp_tools FROM hosts WHERE deleted = 0 AND mcp_tools IS NOT NULL",
						)
						.all() as Array<{ site_id: string; host_name: string; mcp_tools: string }>;
					for (const host of hosts) {
						try {
							const tools = JSON.parse(host.mcp_tools) as Array<{
								server: string;
								name: string;
							}>;
							for (const tool of tools) {
								const toolName = `${tool.server}-${tool.name}`;
								if (toolName === cmd.name) {
									hostInfo = ` [host: ${host.host_name}]`;
									break;
								}
							}
							if (hostInfo) break;
						} catch {
							// Continue to next host
						}
					}
				} catch {
					// If query fails, don't add host info
				}
				output += `  ${cmd.name}${hostInfo}\n`;
			}
		}

		output += "\nRun 'help <command>' for detailed usage.\n";

		return { stdout: output, stderr: "", exitCode: 0 };
	},
};
