import type Database from "bun:sqlite";
import { AsyncLocalStorage } from "node:async_hooks";

import type { ThreadExecutor } from "@bound/core";
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
	threadExecutor?: ThreadExecutor;
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

			// Detect if argv uses --key value or key=value format.
			// Use a strict regex: a key=value token must start with an identifier
			// (no whitespace before "="). This prevents SQL strings like
			// "SELECT … WHERE deleted=0" from triggering key=value parsing — those
			// tokens contain spaces before "=", so they fail /^[^\s=]+=/
			const hasFlags = argv.some((a) => a.startsWith("--") || /^[^\s=]+=/.test(a));

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
					if (arg.startsWith("--") && i + 1 < argv.length) {
						args[arg.slice(2)] = argv[++i];
					} else if (/^[^\s=]+=/.test(arg)) {
						const eqIdx = arg.indexOf("=");
						args[arg.slice(0, eqIdx)] = arg.slice(eqIdx + 1);
					} else if (!arg.startsWith("--") && positionalCount < def.args.length) {
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
