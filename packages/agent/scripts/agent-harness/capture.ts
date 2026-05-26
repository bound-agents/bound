/**
 * Wire-body capture + provider-agnostic cache-marker scanner.
 *
 * The harness injects a capturing fetch into the AI SDK provider via
 * `createModelRouter({fetchByBackendId})`. Each outgoing request body is
 * recorded into the active turn's array; diagnostics consume the array
 * post-turn.
 *
 * The scanner identifies cache markers by JSON key name without knowing
 * which provider produced the body. Bedrock Converse uses `cachePoint`,
 * Anthropic Messages uses `cache_control`. New providers register here
 * (one-line addition to `KNOWN_CACHE_MARKER_KEYS`); no per-provider
 * dispatch.
 */

/**
 * One captured outgoing request. The harness reuses a single mutable array
 * per turn — `clear()` between turns, `entries` snapshotted into the turn
 * record.
 */
export interface CapturedRequest {
	url: string;
	body: string;
}

export interface CapturingFetch {
	/** The fetch function passed to the AI SDK provider. */
	fetch: typeof globalThis.fetch;
	/** Captured requests since the last `clear()`. */
	entries: CapturedRequest[];
	/** Reset the buffer at the start of each turn. */
	clear(): void;
}

/**
 * Build a fetch that records outgoing request bodies and forwards through
 * to `globalThis.fetch`. Body extraction mirrors `fetch-logger.ts` —
 * supports string / Uint8Array / ArrayBuffer / URLSearchParams; unknown
 * shapes record a placeholder (the AI SDK does not use them for inference
 * calls in practice).
 */
export function createCapturingFetch(): CapturingFetch {
	const entries: CapturedRequest[] = [];
	const fetchImpl = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
		const url = extractUrl(input);
		const body = readBody(init?.body);
		entries.push({ url, body });
		return globalThis.fetch(input, init);
	};
	return {
		fetch: fetchImpl as typeof globalThis.fetch,
		entries,
		clear: () => {
			entries.length = 0;
		},
	};
}

function extractUrl(input: RequestInfo | URL): string {
	if (typeof input === "string") return input;
	if (input instanceof URL) return input.toString();
	return (input as Request).url;
}

function readBody(body: BodyInit | null | undefined): string {
	if (body === null || body === undefined) return "";
	if (typeof body === "string") return body;
	if (body instanceof URLSearchParams) return body.toString();
	if (body instanceof Uint8Array) {
		try {
			return new TextDecoder().decode(body);
		} catch {
			return `[binary body: Uint8Array length=${body.byteLength}]`;
		}
	}
	if (body instanceof ArrayBuffer) {
		try {
			return new TextDecoder().decode(new Uint8Array(body));
		} catch {
			return `[binary body: ArrayBuffer byteLength=${body.byteLength}]`;
		}
	}
	const ctor = (body as object).constructor?.name ?? typeof body;
	return `[non-string body: ${ctor}]`;
}

// ---------------------------------------------------------------------------
// Cache-marker scanner (provider-agnostic)
// ---------------------------------------------------------------------------

/**
 * Object keys that, when present anywhere in the wire body, indicate a
 * cache breakpoint. Disjoint set across providers — each provider uses
 * exactly one. Add new providers here.
 */
const KNOWN_CACHE_MARKER_KEYS: ReadonlySet<string> = new Set(["cachePoint", "cache_control"]);

export interface WireMarkerInspection {
	/** Markers attached to system blocks (top-level `system` array). */
	systemMarkers: number;
	/** Markers attached to messages (anywhere under `messages[]`). */
	messageMarkers: number;
	/**
	 * Byte offsets of message-level markers in the raw body string. Used by
	 * diagnostics to compute `wire_diff_vs_prev` — when two consecutive
	 * cold turns produce wire bodies that diverge at a specific byte, we
	 * can correlate the divergence with marker placement.
	 */
	messageMarkerByteOffsets: number[];
}

/**
 * Scan a raw outgoing wire body for cache-marker JSON keys. Provider-
 * agnostic — the scanner does not know whether the body is a Bedrock
 * Converse request or an Anthropic Messages request; it only counts
 * occurrences of well-known marker keys.
 *
 * Returns counts split between "system" markers (those reachable under the
 * top-level `system` array) and "message" markers (everything else,
 * typically reachable under `messages[]`). Byte offsets are recovered by
 * scanning the raw string for the matched key with a quoted-key regex.
 */
export function scanWireBodyForCacheMarkers(rawBody: string): WireMarkerInspection {
	let parsed: unknown;
	try {
		parsed = JSON.parse(rawBody);
	} catch {
		return { systemMarkers: 0, messageMarkers: 0, messageMarkerByteOffsets: [] };
	}

	let systemMarkers = 0;
	let messageMarkers = 0;
	if (parsed && typeof parsed === "object") {
		const root = parsed as Record<string, unknown>;
		// System markers — count occurrences of any KNOWN key under the
		// top-level `system` value.
		systemMarkers = countMarkersIn(root.system);
		// Message markers — count under `messages` (Bedrock + OpenAI shape)
		// AND any other top-level field that isn't `system` (defensive for
		// future providers that nest differently).
		messageMarkers = countMarkersIn(root.messages);
	}

	// Byte offsets in the raw body. Match `"key":` for each known marker
	// key; aggregate and sort. Includes BOTH system + message marker
	// offsets because the offsets are useful for byte-diff regardless of
	// which scope they belong to.
	const offsets: number[] = [];
	for (const key of KNOWN_CACHE_MARKER_KEYS) {
		const pattern = new RegExp(`"${escapeRegex(key)}"\\s*:`, "g");
		let m: RegExpExecArray | null;
		// biome-ignore lint/suspicious/noAssignInExpressions: stdlib regex iter pattern
		while ((m = pattern.exec(rawBody)) !== null) {
			offsets.push(m.index);
		}
	}
	offsets.sort((a, b) => a - b);

	return { systemMarkers, messageMarkers, messageMarkerByteOffsets: offsets };
}

function countMarkersIn(value: unknown): number {
	if (value === null || value === undefined) return 0;
	if (Array.isArray(value)) {
		let total = 0;
		for (const v of value) total += countMarkersIn(v);
		return total;
	}
	if (typeof value === "object") {
		let total = 0;
		for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
			if (KNOWN_CACHE_MARKER_KEYS.has(k)) total += 1;
			else total += countMarkersIn(v);
		}
		return total;
	}
	return 0;
}

function escapeRegex(s: string): string {
	return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Compute the first byte index where `b` differs from `a`. Returns `-1`
 * when the two strings are byte-equal, or the length of the shorter when
 * one is a prefix of the other. Used by the cache diagnostic to surface
 * "wire diverged at byte N" so operators can pinpoint which content
 * change broke the cumulative cache.
 */
export function firstByteDiff(a: string, b: string): number {
	const len = Math.min(a.length, b.length);
	for (let i = 0; i < len; i++) {
		if (a.charCodeAt(i) !== b.charCodeAt(i)) return i;
	}
	if (a.length === b.length) return -1;
	return len;
}
