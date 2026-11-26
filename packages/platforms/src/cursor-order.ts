/**
 * Orders two event cursors. BigInt comparison keeps Discord snowflakes (~1.4e18)
 * exact above 2^53; non-numeric cursors (legacy or opaque MCP cursors) fall back
 * to lexicographic order.
 */
export function compareCursors(a: string, b: string): number {
	try {
		const aBig = BigInt(a);
		const bBig = BigInt(b);
		if (aBig < bBig) return -1;
		if (aBig > bBig) return 1;
		return 0;
	} catch {
		return a.localeCompare(b);
	}
}
