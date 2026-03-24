import type Database from "bun:sqlite";

import { formatError } from "@bound/shared";
import type { Logger, TypedEventEmitter } from "@bound/shared";

import type { CustomCommand } from "just-bash";
import { defineCommand } from "just-bash";

export interface CommandResult {
	stdout: string;
	stderr: string;
	exitCode: number;
}

export interface CommandContext {
	db: Database;
	siteId: string;
	eventBus: TypedEventEmitter;
	logger: Logger;
	threadId?: string;
	taskId?: string;
}

export interface CommandDefinition {
	name: string;
	args: Array<{ name: string; required: boolean; description?: string }>;
	handler: (args: Record<string, string>, ctx: CommandContext) => Promise<CommandResult>;
}

export function createDefineCommands(
	definitions: CommandDefinition[],
	context: CommandContext,
): (CustomCommand & { handler: (argv: string[]) => Promise<CommandResult> })[] {
	return definitions.map((def) => {
		const handler = async (argv: string[]) => {
			const args: Record<string, string> = {};

			if (def.args.length > 0) {
				// Named positional args: match argv to declared arg definitions
				let argIndex = 0;
				for (const argDef of def.args) {
					if (argIndex < argv.length) {
						args[argDef.name] = argv[argIndex];
						argIndex++;
					} else if (argDef.required) {
						return {
							stdout: "",
							stderr: `Missing required argument: ${argDef.name}\n`,
							exitCode: 1,
						};
					}
				}
			} else if (argv.length > 0) {
				// No declared args (e.g., MCP tools) — parse key=value pairs and --key value flags
				for (let i = 0; i < argv.length; i++) {
					const arg = argv[i];
					if (arg.startsWith("--") && i + 1 < argv.length) {
						args[arg.slice(2)] = argv[++i];
					} else if (arg.includes("=")) {
						const eqIdx = arg.indexOf("=");
						args[arg.slice(0, eqIdx)] = arg.slice(eqIdx + 1);
					} else {
						// Try parsing entire remaining argv as JSON
						try {
							const jsonArgs = JSON.parse(argv.slice(i).join(" "));
							if (typeof jsonArgs === "object" && jsonArgs !== null) {
								for (const [k, v] of Object.entries(jsonArgs)) {
									args[k] = String(v);
								}
							}
							break;
						} catch {
							args[`arg${i}`] = arg;
						}
					}
				}
			}

			try {
				return await def.handler(args, context);
			} catch (error) {
				const errorMsg = formatError(error);
				return {
					stdout: "",
					stderr: `${errorMsg}\n`,
					exitCode: 1,
				};
			}
		};

		const customCommand = defineCommand(def.name, handler) as CustomCommand & {
			handler?: (argv: string[]) => Promise<CommandResult>;
		};
		customCommand.handler = handler;
		return customCommand as CustomCommand & { handler: (argv: string[]) => Promise<CommandResult> };
	});
}
