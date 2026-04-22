import type { CommandDefinition } from "@bound/sandbox";

/**
 * Registry of all commands — populated at startup by start.ts.
 */
let commandRegistry: CommandDefinition[] = [];

export function setCommandRegistry(
	commands: CommandDefinition[],
	_serverNames?: Set<string>,
	_remoteServerNames?: Set<string>,
): void {
	commandRegistry = commands;
	// serverNames and remoteServerNames parameters accepted for backwards compatibility
	// but no longer used after the help command was removed.
}

/**
 * Return the command registry populated at boot by setCommandRegistry.
 * Used by context-assembly to render the orientation block's command list.
 * Returns [] before boot; context-assembly must run after setCommandRegistry.
 */
export function getCommandRegistry(): readonly CommandDefinition[] {
	return commandRegistry;
}
