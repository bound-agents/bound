import type { CommandContext, CommandDefinition, CommandResult } from "@bound/sandbox";

/**
 * Registry of all commands — populated at startup by start.ts.
 * The help command reads from this to show available commands and syntax.
 */
let commandRegistry: CommandDefinition[] = [];
let serverNamesRegistry: Set<string> = new Set();

export function setCommandRegistry(commands: CommandDefinition[], serverNames?: Set<string>): void {
	commandRegistry = commands;
	if (serverNames) {
		serverNamesRegistry = serverNames;
	}
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

			// For MCP server commands, delegate to the handler's built-in --help output
			if (serverNamesRegistry.has(target)) {
				return cmd.handler({ help: "true" }, ctx);
			}

			// Regular command: show args listing
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

			return { stdout: output, stderr: "", exitCode: 0 };
		}

		// List all commands
		let output = "Available commands:\n\n";

		const builtins = commandRegistry.filter((c) => !serverNamesRegistry.has(c.name));
		const localMcp = commandRegistry.filter((c) => serverNamesRegistry.has(c.name));

		// Get remote MCP server names from hosts table
		const remoteServerNames = new Set<string>();
		const serverToHostName = new Map<string, string>();
		try {
			const hosts = ctx.db
				.prepare(
					"SELECT site_id, host_name, mcp_tools FROM hosts WHERE deleted = 0 AND mcp_tools IS NOT NULL",
				)
				.all() as Array<{ site_id: string; host_name: string; mcp_tools: string }>;
			for (const host of hosts) {
				try {
					const serverNames = JSON.parse(host.mcp_tools) as string[];
					for (const serverName of serverNames) {
						if (!serverNamesRegistry.has(serverName)) {
							remoteServerNames.add(serverName);
							serverToHostName.set(serverName, host.host_name);
						}
					}
				} catch {
					// skip unparseable hosts
				}
			}
		} catch {
			// skip DB errors
		}

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

		if (remoteServerNames.size > 0) {
			output += "\nREMOTE (via relay):\n";
			for (const serverName of remoteServerNames) {
				const hostName = serverToHostName.get(serverName);
				const hostInfo = hostName ? ` [host: ${hostName}]` : "";
				output += `  ${serverName}${hostInfo}\n`;
			}
		}

		output += "\nRun 'commands <name>' for detailed usage.\n";

		return { stdout: output, stderr: "", exitCode: 0 };
	},
};
