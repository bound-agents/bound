import type { DecodedImage } from "./png";

/**
 * Render decoded RGBA pixels as ANSI half-block art.
 *
 * Each output line is one terminal row of `▀` cells: the glyph's foreground
 * carries the upper pixel, the background the lower — two pixels per cell
 * vertically. The escapes are pure SGR (colors only, no cursor movement),
 * so a rendered line is an ordinary text row to Ink: its width is the cell
 * count (string-width ignores SGR), it wraps nowhere, and it erases like any
 * other row. That's the ghost-card invariant honored by construction —
 * unlike the iTerm2/kitty image protocols, which paint N physical rows
 * behind a 1-row escape string and desync log-update's erase math.
 *
 * Transparency blends against the terminal-ish dark backdrop rather than
 * emitting default-background cells, so screenshots with alpha keep their
 * shape without striping.
 */

/** Backdrop for alpha blending (roughly a dark terminal theme). */
const BACKDROP = { r: 30, g: 30, b: 30 };

export interface HalfBlockOptions {
	/** Maximum output width in terminal cells (columns). */
	maxCols: number;
	/** Maximum output height in terminal rows (each row = 2 pixels). */
	maxRows: number;
}

function blend(c: number, a: number, back: number): number {
	// Straight alpha over the backdrop; a in [0,255].
	return Math.round((c * a + back * (255 - a)) / 255);
}

/**
 * Box-sample `img` down to exactly (cols × rows*2) pixels and emit one
 * SGR-colored string per terminal row.
 *
 * Box sampling (average of the covered source region) rather than
 * nearest-neighbor: screenshots are text-heavy, and nearest produces
 * shimmer/aliasing that makes the preview read as noise.
 */
export function renderHalfBlocks(img: DecodedImage, opts: HalfBlockOptions): string[] {
	const { width, height, pixels } = img;
	if (width <= 0 || height <= 0) return [];

	// Fit within (maxCols × maxRows) preserving aspect. A cell is 1 px wide
	// and 2 px tall in sample space; assume roughly square terminal cells at
	// 1:2 width:height, which makes the pixel aspect ratio work out to 1:1.
	const maxPxW = Math.max(1, opts.maxCols);
	const maxPxH = Math.max(1, opts.maxRows) * 2;
	const scale = Math.min(maxPxW / width, maxPxH / height, 1);
	const outW = Math.max(1, Math.round(width * scale));
	const outH = Math.max(2, Math.round(height * scale) & ~1); // even, ≥2

	// Average the source rectangle covering each output pixel.
	const sample = (ox: number, oy: number): { r: number; g: number; b: number } => {
		const x0 = Math.floor((ox * width) / outW);
		const x1 = Math.max(x0 + 1, Math.floor(((ox + 1) * width) / outW));
		const y0 = Math.floor((oy * height) / outH);
		const y1 = Math.max(y0 + 1, Math.floor(((oy + 1) * height) / outH));
		let r = 0;
		let g = 0;
		let b = 0;
		let n = 0;
		for (let y = y0; y < y1; y++) {
			for (let x = x0; x < x1; x++) {
				const i = (y * width + x) * 4;
				const a = pixels[i + 3];
				r += blend(pixels[i], a, BACKDROP.r);
				g += blend(pixels[i + 1], a, BACKDROP.g);
				b += blend(pixels[i + 2], a, BACKDROP.b);
				n++;
			}
		}
		return { r: Math.round(r / n), g: Math.round(g / n), b: Math.round(b / n) };
	};

	const lines: string[] = [];
	for (let row = 0; row < outH / 2; row++) {
		let line = "";
		let prevKey = "";
		for (let col = 0; col < outW; col++) {
			const top = sample(col, row * 2);
			const bot = sample(col, row * 2 + 1);
			// Elide repeated SGR params for adjacent identical cells — keeps
			// a solid-color region from bloating the string 20x.
			const key = `${top.r},${top.g},${top.b};${bot.r},${bot.g},${bot.b}`;
			if (key !== prevKey) {
				line += `\u001b[38;2;${top.r};${top.g};${top.b}m\u001b[48;2;${bot.r};${bot.g};${bot.b}m`;
				prevKey = key;
			}
			line += "▀";
		}
		line += "\u001b[0m";
		lines.push(line);
	}
	return lines;
}
