import type Database from "bun:sqlite";

import { formatError } from "@bound/shared";
import type { Logger, TypedEventEmitter } from "@bound/shared";

import type { CustomCommand, IFileSystem } from "just-bash";
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
	mcpClients?: Map<string, unknown>;
	modelRouter?: unknown; // ModelRouter from @bound/llm, optional for backward compatibility
	fs?: IFileSystem;
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

			// Bug #2: detect --_json <json> encoding used by executeToolCall to safely
			// pass string values that contain single quotes or other shell metacharacters.
			// The value arrives as a JSON-encoded string with ' replaced by \u0027 so that
			// just-bash's tokenizer doesn't split on literal single quotes.
			const jsonFlagIdx = argv.indexOf("--_json");
			if (jsonFlagIdx !== -1 && jsonFlagIdx + 1 < argv.length) {
				try {
					const parsed = JSON.parse(argv[jsonFlagIdx + 1]) as Record<string, unknown>;
					if (typeof parsed === "object" && parsed !== null) {
						return await def.handler(
							Object.fromEntries(Object.entries(parsed).map(([k, v]) => [k, String(v)])),
							context,
						);
					}
				} catch {
					// Fall through to normal parsing if JSON is malformed
				}
			}

			// Detect if argv uses --key value or key=value format.
			// Use a strict regex: a key=value token must start with an identifier
			// (no whitespace before "="). This prevents SQL strings like
			// "SELECT … WHERE deleted=0" from triggering key=value parsing — those
			// tokens contain spaces before "=", so they fail /^[^\s=]+=/
			const hasFlags = argv.some((a) => a.startsWith("--") || /^[^\s=]+=/.test(a));

			if (hasFlags) {
				// Parse --key value pairs and key=value pairs
				for (let i = 0; i < argv.length; i++) {
					const arg = argv[i];
					if (arg.startsWith("--") && i + 1 < argv.length) {
						args[arg.slice(2)] = argv[++i];
					} else if (arg.includes("=")) {
						const eqIdx = arg.indexOf("=");
						args[arg.slice(0, eqIdx)] = arg.slice(eqIdx + 1);
					}
				}
			} else if (def.args.length > 0) {
				// Positional args: match argv to declared arg definitions
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
				// No flags, no arg defs — try JSON parsing
				try {
					const jsonArgs = JSON.parse(argv.join(" "));
					if (typeof jsonArgs === "object" && jsonArgs !== null) {
						for (const [k, v] of Object.entries(jsonArgs)) {
							args[k] = String(v);
						}
					}
				} catch {
					for (let i = 0; i < argv.length; i++) {
						args[`arg${i}`] = argv[i];
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
