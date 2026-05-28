/**
 * Hard-wrap a single logical line into visual rows of at most `width`
 * code units each. No word-boundary search — long single-token strings
 * (URLs, JSON dumps, base64 blobs, etc.) get split deterministically at
 * exact column boundaries so each visual row is a separate string.
 *
 * Why deterministic hard-wrap rather than letting Ink/the terminal
 * soft-wrap:
 *
 * - **Truncation by visual rows (#74).** Counting `\n`-split logical
 *   lines lets a single 100KB line render as one "line" that soft-wraps
 *   into hundreds of physical rows, blowing past terminal height.
 *   Pre-wrapping lets the caller cap the visual row count.
 *
 * - **Border-left painting (#75).** When a `<Text>` inside a `Box` with
 *   `borderLeft` overflows its width, Ink/Yoga's measurement and the
 *   terminal's own soft-wrap can disagree by a column or two; the
 *   continuation rows escape the Box's logical layout and the stripe
 *   glyph (`│`) doesn't paint on them. If each visual row is its own
 *   `<Text>` element, every row is a known logical row and the stripe
 *   paints deterministically.
 *
 * Width semantics: code-unit count, not display columns. ASCII works
 * exactly. Wide chars (CJK) are not handled — they'd take 2 cols each
 * but are counted as 1 here. ANSI escape sequences are not handled
 * either; pre-wrapped chunks must be plain text. Tool stdout is almost
 * always ASCII so this is acceptable for the issues at hand; a future
 * version can switch to `string-width` + `wrap-ansi` if needed.
 *
 * Edge cases:
 * - `width <= 0` → returns `[line]` unchanged (defensive against
 *   absurdly narrow stripeWidth math).
 * - empty string → returns `[""]` so callers can rely on at least one
 *   row per logical line.
 * - line shorter than width → returns `[line]` (no chunking).
 */
export function wrapToVisualRows(line: string, width: number): string[] {
	if (width <= 0) return [line];
	if (line.length <= width) return [line];

	const rows: string[] = [];
	for (let i = 0; i < line.length; i += width) {
		rows.push(line.slice(i, i + width));
	}
	return rows;
}
