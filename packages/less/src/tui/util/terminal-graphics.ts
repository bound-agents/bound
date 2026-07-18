/**
 * Terminal graphics protocol support — progressive enhancement over the
 * half-block fallback.
 *
 * Two protocols cover the terminals worth targeting:
 *   - kitty graphics protocol (kitty, Ghostty, Konsole, WezTerm)
 *   - iTerm2 inline images (iTerm2, WezTerm)
 * Everything else degrades to half-block art (util/half-blocks.ts), which
 * needs nothing but truecolor.
 *
 * THE GHOST-CARD BOUNDARY (non-negotiable): these escapes paint N physical
 * terminal rows behind what the line-layout engine sees as a short string.
 * That is exactly the desync that strands log-update's erase math — so a
 * graphics escape may ONLY be emitted into the <Static> transcript, which is
 * written once and never repainted. The dynamic region (in-flight card,
 * staged chip) stays on half-blocks forever. Callers enforce this by only
 * ever storing a graphics payload for the committed-render path.
 *
 * Detection is env-var based (synchronous, no terminal round-trip that could
 * hang the input loop). It can be forced or disabled with BOUND_TERM_GRAPHICS
 * = kitty | iterm2 | none | auto.
 */

const ESC = "\u001b";
const ST = "\u001b\\"; // string terminator
const BEL = "\u0007";

export type GraphicsProtocol = "kitty" | "iterm2";

/**
 * Decide which graphics protocol (if any) the current terminal speaks.
 * `env` is injectable for tests. Returns null when nothing is detected or
 * the user disabled it — callers then fall back to half-blocks.
 */
export function detectGraphicsProtocol(
	env: Record<string, string | undefined> = process.env,
): GraphicsProtocol | null {
	const override = env.BOUND_TERM_GRAPHICS?.toLowerCase();
	if (override === "kitty") return "kitty";
	if (override === "iterm2" || override === "iterm") return "iterm2";
	if (override === "none" || override === "off") return null;
	// override "auto" (or unset) falls through to sniffing.

	// kitty-protocol terminals. KITTY_WINDOW_ID is set inside kitty; Ghostty
	// and Konsole implement the same protocol.
	if (env.TERM === "xterm-kitty" || env.KITTY_WINDOW_ID) return "kitty";
	if (env.TERM_PROGRAM === "ghostty" || env.GHOSTTY_RESOURCES_DIR) return "kitty";
	if (env.KONSOLE_VERSION) return "kitty";

	// iTerm2 inline images.
	if (env.TERM_PROGRAM === "iTerm.app" || env.LC_TERMINAL === "iTerm2") return "iterm2";

	// WezTerm speaks both; the iTerm2 protocol is a single escape (no
	// chunking), so it's the simpler, more reliable choice there.
	if (env.TERM_PROGRAM === "WezTerm" || env.WEZTERM_EXECUTABLE) return "iterm2";

	return null;
}

export interface CellBox {
	/** Width in terminal columns (cells). */
	cols: number;
	/** Height in terminal rows (cells). */
	rows: number;
}

/**
 * Fit an image of `imgW`×`imgH` pixels into a `maxCols`×`maxRows` cell box,
 * preserving the image's aspect ratio and correcting for the terminal cell's
 * own aspect (a monospace cell is roughly twice as tall as it is wide, so a
 * square image needs about half as many rows as columns).
 */
export function fitCellBox(imgW: number, imgH: number, maxCols: number, maxRows: number): CellBox {
	if (imgW <= 0 || imgH <= 0) return { cols: 1, rows: 1 };
	const CELL_ASPECT = 2; // cell height ≈ 2× cell width
	const colsPerRow = (imgW / imgH) * CELL_ASPECT;
	// Width-constrained first.
	let cols = maxCols;
	let rows = Math.round(cols / colsPerRow);
	if (rows > maxRows) {
		rows = maxRows;
		cols = Math.round(rows * colsPerRow);
	}
	return {
		cols: Math.max(1, Math.min(maxCols, cols)),
		rows: Math.max(1, Math.min(maxRows, rows)),
	};
}

/**
 * kitty graphics protocol escape: transmit + display a PNG scaled into a
 * `cols`×`rows` cell box, WITHOUT moving the cursor (C=1). The no-move policy
 * is what lets the caller reserve exactly `rows` rows in the layout engine
 * (via an explicit-height Box) and have the image paint into that reserved
 * region — layout accounting and pixels agree, so <Static> stays honest.
 *
 * Payloads over 4096 base64 bytes are chunked per spec: the first chunk
 * carries all control keys, continuation chunks carry only m=1, the final
 * carries m=0.
 */
export function encodeKittyImage(pngBase64: string, box: CellBox): string {
	const CHUNK = 4096;
	const controls = `a=T,f=100,C=1,c=${box.cols},r=${box.rows}`;
	if (pngBase64.length <= CHUNK) {
		return `${ESC}_G${controls};${pngBase64}${ST}`;
	}
	const parts: string[] = [];
	let offset = 0;
	let first = true;
	while (offset < pngBase64.length) {
		const chunk = pngBase64.slice(offset, offset + CHUNK);
		offset += CHUNK;
		const more = offset < pngBase64.length ? 1 : 0;
		parts.push(
			first ? `${ESC}_G${controls},m=${more};${chunk}${ST}` : `${ESC}_Gm=${more};${chunk}${ST}`,
		);
		first = false;
	}
	return parts.join("");
}

/**
 * iTerm2 inline-image escape: draw a PNG scaled into `cols`×`rows` cells,
 * aspect preserved. iTerm2 has no cursor-suppression key — it advances the
 * cursor past the image — so the caller still reserves `rows` rows in layout;
 * the reservation and the advance line up on `rows`.
 */
export function encodeItermImage(pngBase64: string, box: CellBox, byteLength: number): string {
	const args = `inline=1;width=${box.cols};height=${box.rows};preserveAspectRatio=1;size=${byteLength}`;
	return `${ESC}]1337;File=${args}:${pngBase64}${BEL}`;
}
