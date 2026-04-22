import type Database from "bun:sqlite";
import { AsyncLocalStorage } from "node:async_hooks";

import { formatError } from "@bound/shared";
import type { Logger, TypedEventEmitter } from "@bound/shared";

/**
 * Per-loop execution context injected by the agent loop factory.
 * Used to propagate threadId and taskId to command handlers without
 * requiring a mutable shared context (which would be unsafe for
 * concurrent agent loops running on different threads).
 *
 * Usage in start.ts loopSandbox.exec:
 *   loopContextStorage.run({ threadId, taskId }, () => sandbox.bash.exec(cmd, opts))
 */
export const loopContextStorage = new AsyncLocalStorage<{
	threadId?: string;
	taskId?: string;
	/**
	 * Side-channel for relay requests from remote MCP proxy commands.
	 * just-bash normalizes custom command return values to { stdout, stderr, exitCode, env },
	 * stripping extra fields like outboxEntryId. Command handlers that need to signal a relay
	 * request set this field; the agent loop checks it after sandbox.exec returns.
	 */
	relayRequest?: unknown;
}>();

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
	description: string;
	helpText?: string;
	customHelp?: boolean;
	args: Array<{ name: string; required: boolean; description?: string }>;
	handler: (args: Record<string, string>, ctx: CommandContext) => Promise<CommandResult>;
}

/**
 * Render usage help for a command.
 * If helpText is provided, uses it verbatim; otherwise auto-generates from args schema.
 */
export function formatHelp(def: CommandDefinition): CommandResult {
	let body: string;
	if (def.helpText) {
		body = def.helpText;
	} else {
		const lines: string[] = [];
		// Usage line
		const argSyntax = def.args.map((a) => (a.required ? `<${a.name}>` : `[${a.name}]`)).join(" ");
		lines.push(`Usage: ${def.name}${argSyntax ? ` ${argSyntax}` : ""}`);
		// Arguments section
		if (def.args.length > 0) {
			lines.push("");
			lines.push("Arguments:");
			for (const a of def.args) {
				const req = a.required ? "(required)" : "(optional)";
				lines.push(`  ${a.name} ${req}${a.description ? ` — ${a.description}` : ""}`);
			}
		}
		body = lines.join("\n");
	}

	return {
		stdout: `${def.name} — ${def.description}\n\n${body}\n`,
		stderr: "",
		exitCode: 0,
	};
}

export function createDefineCommands(
	definitions: CommandDefinition[],
	context: CommandContext,
): (CustomCommand & { handler: (argv: string[]) => Promise<CommandResult> })[] {
	return definitions.map((def) => {
		const handler = async (argv: string[]) => {
			// --help / -h interception: sole argv, non-customHelp commands only
			if (!def.customHelp && argv.length === 1 && (argv[0] === "--help" || argv[0] === "-h")) {
				return formatHelp(def);
			}

			const args: Record<string, string> = {};

			// Detect if argv uses --key value or key=value format.
			// Use a strict regex: a key=value token must start with an identifier
			// (no whitespace before "="). This prevents SQL strings like
			// "SELECT … WHERE deleted=0" from triggering key=value parsing — those
			// tokens contain spaces before "=", so they fail /^[^\s=]+=/
			const hasFlags = argv.some((a) => a === "-h" || a.startsWith("--") || /^[^\s=]+=/.test(a));

			if (hasFlags) {
				// Parse --key value pairs, key=value pairs, and leading positional args.
				// Commands may mix positional and named-flag syntax, e.g.:
				//   emit event_name --payload json
				//   memorize key value --source agent
				// Tokens that are neither --flags nor key=value are assigned to the
				// next unfilled positional arg definition in declaration order.
				let positionalCount = 0;
				for (let i = 0; i < argv.length; i++) {
					const arg = argv[i];
					if (arg === "-h") {
						// Short-form alias: -h → args.help = "true"
						args.help = "true";
					} else if (arg.startsWith("--")) {
						const flag = arg.slice(2);
						const next = argv[i + 1];
						if (next !== undefined && !next.startsWith("--")) {
							// --flag value: consume next token as the value
							args[flag] = next;
							i++;
						} else {
							// Bare --flag (last token or followed by another --flag): boolean true
							args[flag] = "true";
						}
					} else if (/^[^\s=]+=/.test(arg)) {
						const eqIdx = arg.indexOf("=");
						args[arg.slice(0, eqIdx)] = arg.slice(eqIdx + 1);
					} else if (positionalCount < def.args.length) {
						// Unmatched token — assign to next positional arg slot
						args[def.args[positionalCount].name] = arg;
						positionalCount++;
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
							stderr: `Missing required argument: ${argDef.name}\n(run '${def.name} --help' for usage)\n`,
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
				// Merge per-loop threadId/taskId from AsyncLocalStorage with the shared
				// startup context, so commands like `purge --last` and `schedule` can
				// access ctx.threadId without it being passed as an explicit argument.
				// Safe for concurrent agent loops: AsyncLocalStorage propagates the
				// correct value through async/await for each independent execution.
				const loopStore = loopContextStorage.getStore();
				const effectiveCtx: CommandContext = loopStore
					? {
							...context,
							threadId: loopStore.threadId ?? context.threadId,
							taskId: loopStore.taskId ?? context.taskId,
						}
					: context;

				return await def.handler(args, effectiveCtx);
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
