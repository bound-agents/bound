/**
 * Session-local preview cache for pasted images.
 *
 * The transcript is `<Static>` — committed once, never repainted — so a
 * committed user message can't asynchronously fetch its image bytes back
 * from the files table to draw a preview. But a PASTED image's bytes are in
 * hand before send. So: at paste time we render the half-block preview and
 * park it here under a content hash; the hash is stamped into the image
 * block's `description`, which the server PRESERVES when it rewrites inline
 * base64 to a file_ref. When the committed message arrives back over the WS
 * and renders, MessageBlock parses the hash out of the description and finds
 * the preview synchronously. Messages from other sessions (history, other
 * hosts) miss the cache and degrade to a text placeholder — correct: their
 * bytes were never on this terminal's clipboard.
 */

const cache = new Map<string, string[]>();
/** Parallel cache: the graphics-protocol escape for a hash, when the terminal
 *  supports one. Populated at paste time only if detectGraphicsProtocol() hit;
 *  the committed render prefers it over half-blocks. Same bound + eviction. */
const graphicsCache = new Map<string, GraphicsPreview>();
/** Bounded: a session pastes a handful of screenshots, not thousands. */
const CACHE_CAP = 32;

export interface GraphicsPreview {
	/** The full protocol escape (kitty or iTerm2) — emitted verbatim into a
	 *  <Static>-committed row. */
	escape: string;
	/** Terminal rows the image occupies — the layout engine must reserve
	 *  exactly this many (explicit-height Box) so pixels and accounting agree. */
	rows: number;
	/** Terminal columns the image occupies. */
	cols: number;
}

/** FNV-1a 32-bit over the raw bytes, hex-encoded. Identity, not security. */
export function hashImageBytes(bytes: Uint8Array): string {
	let h = 0x811c9dc5;
	for (let i = 0; i < bytes.length; i++) {
		h ^= bytes[i];
		h = Math.imul(h, 0x01000193);
	}
	return (h >>> 0).toString(16).padStart(8, "0");
}

export function storeImagePreview(hash: string, lines: string[]): void {
	if (cache.size >= CACHE_CAP) {
		// Drop the oldest entry (Map preserves insertion order).
		const first = cache.keys().next();
		if (!first.done) cache.delete(first.value);
	}
	cache.set(hash, lines);
}

export function getImagePreview(hash: string): string[] | undefined {
	return cache.get(hash);
}

export function storeImageGraphics(hash: string, preview: GraphicsPreview): void {
	if (graphicsCache.size >= CACHE_CAP) {
		const first = graphicsCache.keys().next();
		if (!first.done) graphicsCache.delete(first.value);
	}
	graphicsCache.set(hash, preview);
}

export function getImageGraphics(hash: string): GraphicsPreview | undefined {
	return graphicsCache.get(hash);
}

/** Test seam. */
export function clearImagePreviews(): void {
	cache.clear();
	graphicsCache.clear();
}

/**
 * Description stamped on a pasted image block: human-readable dimensions
 * plus the machine-readable preview key. Survives the server's base64 →
 * file_ref rewrite, so it's the one field that travels from paste to
 * committed render.
 */
export function stampImageDescription(width: number, height: number, hash: string): string {
	return `pasted image ${width}×${height} · pv:${hash}`;
}

/** Parse the preview key back out of a (possibly foreign) description. */
export function parseImageDescription(description: string | undefined): {
	label: string;
	hash: string | null;
} {
	if (!description) return { label: "image", hash: null };
	const m = description.match(/^(.*?)\s*·\s*pv:([0-9a-f]{8})$/);
	if (!m) return { label: description, hash: null };
	return { label: m[1], hash: m[2] };
}
