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
 * How the graphics escape and the layout engine split responsibility for the
 * image's vertical footprint. The two protocols advance the cursor
 * differently, and Ink can't see that an escape expands to N visual rows, so
 * the two ends have to agree on who reserves the space:
 *
 *   - "reserve": the escape moves the cursor a NET ZERO (kitty C=1; iTerm2
 *     bracketed in DECSC/DECRC), and GraphicsImage's explicit-height Box
 *     supplies the `rows` reservation AND the per-row card border.
 *   - "advance": the escape lets the TERMINAL advance the cursor by the
 *     image's own height, and GraphicsImage emits a single line so Ink adds no
 *     phantom rows for that advance to double against or overpaint.
 *
 * The default is `reserve` for BOTH protocols. `reserve` is the only mode
 * whose cursor nets to zero (kitty C=1; iTerm2 DECSC/DECRC bracket), which is
 * what keeps Ink's row-by-row emission aligned with the terminal — so the
 * StripeBox card border draws continuously down ALL of the image's rows. Under
 * `advance` the terminal walks the cursor N rows past where Ink thinks it is,
 * a one-way trapdoor: nothing Ink lays out afterward can land beside the image,
 * so the border comes up short (renders full-height BELOW the image instead of
 * to its left). A continuous left border is therefore structurally impossible
 * under `advance` and only available under `reserve`.
 *
 * The earlier iTerm2→advance default (403b8aa5) was justified by a claim that
 * reserve's height Box pads rows 2..N with spaces that overwrite the image.
 * A raw byte capture of Ink's <Static> output disproved that: the height Box
 * emits the border glyph then an immediate LF on those rows — no content-region
 * padding, and no ESC[K erase. So the space-fill the switch guarded never
 * existed, and reserve is the correct default on both substrates.
 * `BOUND_TERM_IMAGE_MODE=reserve|advance` forces either regardless of
 * protocol — a diagnostic seam, since real cursor+scroll behavior can't be
 * observed from ink-testing-library (it trims trailing whitespace and never
 * emulates a cursor), so the strategy is settled on the terminal.
 */
export type GraphicsCursorMode = "reserve" | "advance";

export function graphicsCursorMode(
	protocol: GraphicsProtocol,
	env: NodeJS.ProcessEnv = process.env,
): GraphicsCursorMode {
	const override = env.BOUND_TERM_IMAGE_MODE;
	if (override === "advance") return "advance";
	if (override === "reserve") return "reserve";
	// Protocol-aware default. kitty's C=1 nets the cursor to zero, so `reserve`
	// gives Ink a clean row-by-row footprint and the card border draws
	// continuously down the image's rows. iTerm2's OSC advances the cursor with no
	// net-zero mode Ink can rely on (DECSC/DECRC ignored; CUU arithmetic never
	// converged across the 43decaae→6b897787 arc), so `advance` is the only mode
	// that renders the full image without fighting Ink's flow — at the cost of a
	// continuous left border, which is structurally out of reach on that path.
	return protocol === "kitty" ? "reserve" : "advance";
}

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

	// iTerm2 (3.5+) and LC_TERMINAL=iTerm2 sessions use iTerm2's OWN inline-image
	// escape (ESC]1337 … OSC). We do NOT route iTerm2 through kitty: whatever the
	// exact cause — Ink measures text width via string-width→strip-ansi, and
	// strip-ansi's regex recognizes CSI and OSC but NOT APC (ESC _ … ESC\), so a
	// kitty payload can measure at full width and get line-wrapped/shattered; and
	// iTerm2's kitty support through this render path proved unreliable in the
	// field — the observed result was the raw base64 leaking as text instead of
	// rasterizing (the 1b4c6140 regression). iTerm2's OSC escape strips to zero
	// width, so Ink never touches it and it reaches the terminal intact. The cost
	// is iTerm2's OSC advances the cursor irreversibly (no net-zero mode), so a
	// continuous card border down the image's left edge is out of reach there —
	// but the image renders, which beats a clean border over leaked base64.
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
export function encodeKittyImage(
	pngBase64: string,
	box: CellBox,
	mode: GraphicsCursorMode = "reserve",
): string {
	const CHUNK = 4096;
	// reserve: C=1 suppresses kitty's cursor advance so GraphicsImage's
	// explicit-height Box owns the reservation. advance: omit it, letting kitty
	// move the cursor past the image so the terminal owns the reservation.
	const cursor = mode === "reserve" ? "C=1," : "";
	// q=2 suppresses BOTH the OK and error responses kitty terminals emit after a
	// transmit+display. We never read them, and in a raw-mode TUI an unread
	// `ESC_G…OK ESC\` reply lands on stdin where Ink's input parser would choke on
	// it (and it visibly leaks to the prompt — see the C=1 probe artifact).
	const controls = `a=T,f=100,q=2,${cursor}c=${box.cols},r=${box.rows}`;
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
 * aspect preserved.
 *
 * iTerm2 (unlike kitty's C=1) ADVANCES the cursor past the image, and does
 * NOT honor a DECSC/DECRC (ESC 7 … ESC 8) bracket around it: the image still
 * rasterizes, but the restore is a no-op, so the cursor ends `rows` below and
 * the card's `borderLeft` prints as a column BELOW the image instead of down
 * its left edge (the "border stops after the first row" symptom).
 *
 * The fix nets the cursor to zero the reliable way: cursor-up (CUU, ESC[{n}A)
 * IS honored universally, so we let the image advance its `rows` cells, then
 * move the cursor back UP `rows`. That restores the image's top row, and
 * GraphicsImage's height-`rows` Box then paints the border straight down over
 * the image's own rows — matching kitty's C=1 net-zero semantics without
 * relying on DECSC/DECRC. The up-count must be exact, so we pin
 * preserveAspectRatio=0 to force the paint to EXACTLY `rows` cells tall
 * (the box is already fitted to the image's aspect, so this is a negligible
 * stretch, never a squash) instead of letting iTerm2 pick a shorter height.
 */
export function encodeItermImage(
	pngBase64: string,
	box: CellBox,
	byteLength: number,
	mode: GraphicsCursorMode = "reserve",
): string {
	const args = `inline=1;width=${box.cols};height=${box.rows};preserveAspectRatio=0;size=${byteLength}`;
	const image = `${ESC}]1337;File=${args}:${pngBase64}${BEL}`;
	// advance: emit the bare escape and let iTerm2 advance the cursor by the
	// image's own height — GraphicsImage emits no phantom rows to fight it.
	if (mode === "advance") return image;
	// reserve: iTerm2 leaves the cursor on the image's LAST row (advance = rows-1,
	// NOT rows — measured directly: a height-N image starting on row R lands the
	// cursor on row R+N-1, not R+N). So CUU by rows-1 nets the cursor back to the
	// image's TOP row; the height Box's next line-break then steps to row 2 and the
	// border paints straight down all `rows`. A full `rows` CUU overshoots one row
	// ABOVE the top, which walks the per-row border one short at the bottom and
	// laps the label onto the image (the "stops after row 1, rest stacks below"
	// symptom). A 1-row image needs no CUU (ESC[0A would move up one, not zero).
	if (box.rows <= 1) return image;
	return `${image}${ESC}[${box.rows - 1}A`;
}
