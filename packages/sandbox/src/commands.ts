import type Database from "bun:sqlite";

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

			// Parse arguments from argv
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

			try {
				return await def.handler(args, context);
			} catch (error) {
				const errorMsg = error instanceof Error ? error.message : String(error);
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
