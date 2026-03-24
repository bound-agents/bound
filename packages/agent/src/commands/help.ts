import type { CommandDefinition, CommandResult } from "@bound/sandbox";

/**
 * Registry of all commands — populated at startup by start.ts.
 * The help command reads from this to show available commands and syntax.
 */
let commandRegistry: CommandDefinition[] = [];

export function setCommandRegistry(commands: CommandDefinition[]): void {
	commandRegistry = commands;
}

export const help: CommandDefinition = {
	name: "help",
	args: [
		{ name: "command", required: false, description: "Command name to get detailed help for" },
	],
	handler: async (args): Promise<CommandResult> => {
		const target = args.command;

		if (target) {
			// Detailed help for a specific command
			const cmd = commandRegistry.find((c) => c.name === target);
			if (!cmd) {
				return {
					stdout: "",
					stderr: `Unknown command: ${target}\nRun 'help' to see all available commands.\n`,
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

			// For MCP tools (no declared args), note the key=value syntax
			if (cmd.args.length === 0) {
				output += "\nThis is an MCP tool. Pass arguments as:\n";
				output += `  ${cmd.name} --key value --key2 value2\n`;
				output += `  ${cmd.name} key=value key2=value2\n`;
			}

			return { stdout: output, stderr: "", exitCode: 0 };
		}

		// List all commands
		let output = "Available commands:\n\n";

		const builtins = commandRegistry.filter((c) => !c.name.includes("-") || c.name.startsWith("cache-") || c.name.startsWith("model-"));
		const mcpTools = commandRegistry.filter((c) => c.name.includes("-") && !c.name.startsWith("cache-") && !c.name.startsWith("model-") && c.name !== "help");

		if (builtins.length > 0) {
			output += "Built-in:\n";
			for (const cmd of builtins) {
				const argHint = cmd.args.length > 0
					? ` ${cmd.args.map((a) => (a.required ? `<${a.name}>` : `[${a.name}]`)).join(" ")}`
					: "";
				output += `  ${cmd.name}${argHint}\n`;
			}
		}

		if (mcpTools.length > 0) {
			output += "\nMCP tools:\n";
			for (const cmd of mcpTools) {
				output += `  ${cmd.name}\n`;
			}
		}

		output += "\nRun 'help <command>' for detailed usage.\n";

		return { stdout: output, stderr: "", exitCode: 0 };
	},
};
