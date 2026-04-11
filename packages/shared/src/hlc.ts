/**
 * Hybrid Logical Clock (HLC) implementation.
 *
 * Format: {ISO-8601 timestamp}_{4-digit hex counter}_{site_id}
 * String comparison preserves causal order.
 */

/** Sentinel for "no events seen" — compares less than any real HLC. */
export const HLC_ZERO = "0000-00-00T00:00:00.000Z_0000_0000";

/**
 * Parse an HLC string into its three components.
 * Splits on the last two underscores.
 */
export function parseHlc(hlc: string): [timestamp: string, counter: string, siteId: string] {
	const lastUnderscore = hlc.lastIndexOf("_");
	const siteId = hlc.substring(lastUnderscore + 1);
	const rest = hlc.substring(0, lastUnderscore);
	const secondUnderscore = rest.lastIndexOf("_");
	const counter = rest.substring(secondUnderscore + 1);
	const timestamp = rest.substring(0, secondUnderscore);
	return [timestamp, counter, siteId];
}

/**
 * Generate a new HLC value.
 *
 * - If wall clock advanced past lastHlc's timestamp, resets counter to 0000.
 * - Otherwise, keeps the higher timestamp and increments counter.
 */
export function generateHlc(wallClock: string, lastHlc: string | null, siteId: string): string {
	if (!lastHlc) {
		return `${wallClock}_0000_${siteId}`;
	}

	const [lastTs, lastCounter] = parseHlc(lastHlc);

	if (wallClock > lastTs) {
		return `${wallClock}_0000_${siteId}`;
	}

	// Wall clock hasn't advanced (equal or behind) — increment counter
	const newCounter = (Number.parseInt(lastCounter, 16) + 1).toString(16).padStart(4, "0");
	return `${lastTs}_${newCounter}_${siteId}`;
}

/**
 * Merge a local HLC with a received remote HLC to produce a value
 * greater than both, preserving causal ordering.
 */
export function mergeHlc(localHlc: string, remoteHlc: string, siteId: string): string {
	const now = new Date().toISOString();
	const [localTs, localCounter] = parseHlc(localHlc);
	const [remoteTs, remoteCounter] = parseHlc(remoteHlc);

	const maxTs = [now, localTs, remoteTs].sort().pop() as string;

	if (maxTs === now && now > localTs && now > remoteTs) {
		return `${now}_0000_${siteId}`;
	}

	const maxCounter = Math.max(
		Number.parseInt(localCounter, 16),
		Number.parseInt(remoteCounter, 16),
	);
	const newCounter = (maxCounter + 1).toString(16).padStart(4, "0");
	return `${maxTs}_${newCounter}_${siteId}`;
}

/** Extract the wall clock component as a Date. */
export function hlcToDate(hlc: string): Date {
	const [timestamp] = parseHlc(hlc);
	return new Date(timestamp);
}
