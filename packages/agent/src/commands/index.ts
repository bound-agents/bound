import type { CommandDefinition } from "@bound/sandbox";
import { archive } from "./archive";
import { awaitCmd } from "./await-cmd";
import { cacheEvict } from "./cache-evict";
import { cachePin } from "./cache-pin";
import { cacheUnpin } from "./cache-unpin";
import { cacheWarm } from "./cache-warm";
import { cancel } from "./cancel";
import { emit } from "./emit";
import { forget } from "./forget";
import { help, setCommandRegistry } from "./help";
import { hostinfo } from "./hostinfo";
import { memorize } from "./memorize";
import { modelHint } from "./model-hint";
import { purge } from "./purge";
import { query } from "./query";
import { schedule } from "./schedule";

/**
 * Get all built-in commands.
 * MCP-generated commands are merged in start.ts after generateMCPCommands.
 */
export function getAllCommands(): CommandDefinition[] {
	return [
		help,
		query,
		memorize,
		forget,
		schedule,
		cancel,
		emit,
		purge,
		awaitCmd,
		cacheWarm,
		cachePin,
		cacheUnpin,
		cacheEvict,
		modelHint,
		archive,
		hostinfo,
	];
}

export { setCommandRegistry };

/**
 * Add MCP-generated commands to the command list
 * Import generateMCPCommands from mcp-bridge where needed to avoid circular dependencies
 */
export function addMCPCommands(
	commands: CommandDefinition[],
	mcpCommands: CommandDefinition[],
): CommandDefinition[] {
	return [...commands, ...mcpCommands];
}

export {
	query,
	memorize,
	forget,
	schedule,
	cancel,
	emit,
	purge,
	awaitCmd,
	cacheWarm,
	cachePin,
	cacheUnpin,
	cacheEvict,
	modelHint,
	archive,
	hostinfo,
};
