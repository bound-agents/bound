/**
 * Determines whether a message should clear the waiting indicator.
 * The waiting indicator should be cleared when assistant or alert messages arrive.
 */
export function shouldClearWaiting(role: string): boolean {
	return role === "assistant" || role === "alert";
}
