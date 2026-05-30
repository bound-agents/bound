// Cache-breakpoint tick state derivation for the context-debug breakdown bar.
//
// A turn carries up to two cache breakpoints (a `system` marker at the end of
// the stable system prefix, and a `message` marker further along after the
// history). The AI SDK reports cache_read / cache_write only as request-level
// totals — there is no per-breakpoint byte attribution on the wire — so this
// function infers each marker's display state from the two aggregate counts.
//
// Extracted from ContextBar.svelte so the state logic (the part that actually
// changes when we revisit the heuristic) is unit-testable without a DOM.

export type CacheMarkerState = "hit" | "write" | "disabled" | "idle";

export interface CacheMarkerStateInput {
	kind: "system" | "message";
	capabilityEnabled: boolean;
}

/**
 * Resolve a display state for every cache breakpoint on a turn.
 *
 * Returns one state per input marker, in input order.
 */
export function deriveCacheMarkerStates(
	markers: ReadonlyArray<CacheMarkerStateInput>,
	cacheReadTokens: number,
	cacheWriteTokens: number,
): CacheMarkerState[] {
	if (markers.length === 0) return [];

	// Capability is a per-backend gate that flips both breakpoints together; if
	// any is off, the whole bar reads disabled.
	if (markers.some((m) => !m.capabilityEnabled)) {
		return markers.map(() => "disabled");
	}

	const read = Math.max(0, cacheReadTokens);
	const write = Math.max(0, cacheWriteTokens);

	// Mixed turn: both a read AND a write happened. The AI SDK reports only
	// request-level totals, so we cannot attribute a byte count to a specific
	// breakpoint — but the presence of both lets us infer at least one served a
	// read and at least one served a write (#98). Assign by cache topology: the
	// durable system prefix is the side that gets re-read across turns, while the
	// growing message tail is the side this turn extended (wrote). Exactly one
	// marker is painted "hit" (the system breakpoint, or the first marker if a
	// turn somehow carries no system breakpoint); the rest read "write".
	if (read > 0 && write > 0) {
		const systemIdx = markers.findIndex((m) => m.kind === "system");
		const hitIdx = systemIdx >= 0 ? systemIdx : 0;
		return markers.map((_, i) => (i === hitIdx ? "hit" : "write"));
	}

	// Uniform turns: every breakpoint shares the single thing that happened. A
	// cold turn that only wrote (e.g. 162k seeded) paints BOTH "write" so neither
	// tick misleads an operator into thinking a breakpoint did nothing.
	if (read > 0) return markers.map(() => "hit");
	if (write > 0) return markers.map(() => "write");
	return markers.map(() => "idle");
}
