/**
 * Thread interface tags — taxonomy and gates.
 *
 * The `threads.interface` column carries a short tag (`web`, `boundless`,
 * `discord`, `discord-interaction`, `scheduler`, `mcp`, `webhook`, etc.)
 * identifying the surface that opened the thread. Some surfaces are
 * user-facing (their threads appear in the web UI directory and the
 * agent's volatile context shows a `platform: <name>` line); some are
 * system-driven (cron wakeups, MCP proxy threads, webhook intake) and
 * should be invisible to the operator and to cosmetic concerns like
 * the thread-color cycle.
 *
 * This module is the single source of truth for that distinction.
 */

/**
 * Interface tags that represent system-driven, non-user-facing surfaces.
 * Threads with these tags should be hidden from the directory and excluded
 * from cosmetic distributions (color cycle, etc.).
 */
export const NON_USER_FACING_INTERFACES = ["scheduler", "mcp", "webhook"] as const;

/**
 * Returns true when a thread interface tag represents a user-facing surface.
 * Returns false for `scheduler`, `mcp`, `webhook`, and for null/undefined/empty.
 *
 * Used by:
 *   - cli/src/commands/start/server.ts (volatile-context platform tag)
 *   - web/src/server/routes/threads.ts (color cycle source set)
 *   - web/src/server/routes/mcp.ts (color cycle source set)
 */
export function isUserFacingInterface(threadInterface: string | null | undefined): boolean {
	if (!threadInterface) return false;
	return !(NON_USER_FACING_INTERFACES as readonly string[]).includes(threadInterface);
}
