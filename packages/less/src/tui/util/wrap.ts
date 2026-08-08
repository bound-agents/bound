/**
 * Hard-break a single logical line into visual chunks of at most `width`
 * codepoints. Returns at least one chunk; an empty input returns [""] so a
 * blank line still occupies one visual row.
 *
 * Used by the tool_result renderer to pre-wrap long content before handing
 * it to Ink — Ink's `<Text>`-with-`borderLeft` combination drops the left
 * stripe on the first wrapped continuation when an unbreakable string is
 * one codepoint over the available width (issue #75), and the renderer's
 * line-truncation logic counts logical newlines, so a single 50,000-char
 * line registers as one truncated line and blows out the terminal (issue
 * #74). Pre-wrapping fixes both: every visual row is its own `<Text>` of
 * known length, so Ink never wraps mid-string and truncation can count
 * visual rows.
 *
 * Codepoint-aware via the spread operator so emoji and other supplementary
 * characters are not split between chunks. Width measurement is codepoint
 * count, not east-asian display width — an acceptable approximation for
 * the targeted regressions, which involve ASCII-heavy JSON/code fragments.
 */
export function wrapLineAtWidth(line: string, width: number): string[] {
	if (width <= 0) {
		return [line];
	}
	if (line.length === 0) {
		return [""];
	}

	// Spread iterates by codepoint, so we don't slice surrogate pairs in half.
	const codepoints = [...line];
	if (codepoints.length <= width) {
		return [line];
	}

	const chunks: string[] = [];
	for (let i = 0; i < codepoints.length; i += width) {
		chunks.push(codepoints.slice(i, i + width).join(""));
	}
	return chunks;
}

/**
 * Wrap a pipe-delimited table row while retaining its final value column's
 * horizontal anchor. Generic hard-wrapping turns a coverage-table continuation
 * into a new left-edge fragment (and can split a number between digits); this
 * preserves the row's fixed columns and starts every continuation beneath the
 * final cell instead.
 */
function wrapTableLineAtWidth(line: string, width: number): string[] | null {
	const separators = line.match(/ \| /g)?.length ?? 0;
	if (separators < 2) return null;

	const lastSeparator = line.lastIndexOf(" | ");
	const prefix = line.slice(0, lastSeparator + 3);
	const prefixWidth = [...prefix].length;
	const available = width - prefixWidth;
	if (available <= 0) return null;

	const value = [...line.slice(lastSeparator + 3)];
	if (value.length <= available) return [line];

	const rows: string[] = [];
	let remaining = value;
	while (remaining.length > available) {
		// Prefer a delimiter inside the available cell width. Keeping the comma
		// with the preceding range makes coverage reports read as a list rather
		// than a number broken in half.
		let breakAt = -1;
		for (let i = available - 1; i >= 0; i--) {
			if (remaining[i] === "," || remaining[i] === " ") {
				breakAt = i + 1;
				break;
			}
		}
		if (breakAt <= 0) breakAt = available;
		rows.push(remaining.slice(0, breakAt).join(""));
		remaining = remaining.slice(breakAt);
	}
	rows.push(remaining.join(""));

	return rows.map((row, index) => (index === 0 ? prefix + row : " ".repeat(prefixWidth) + row));
}

/**
 * Wrap each line in `lines` to `width` and return the flattened sequence
 * of visual rows. Order is preserved; an N-line input that produces M
 * visual rows after wrapping returns those M rows in order. Pipe-delimited
 * table rows use a hanging final column so their continuations stay legible.
 */
export function wrapLinesAtWidth(lines: readonly string[], width: number): string[] {
	const out: string[] = [];
	for (const line of lines) {
		const tableRows = wrapTableLineAtWidth(line, width);
		for (const chunk of tableRows ?? wrapLineAtWidth(line, width)) {
			out.push(chunk);
		}
	}
	return out;
}

/**
 * Expand tab characters to spaces for width-measured rendering.
 *
 * A literal `\t` is ONE character to every measuring layer in this stack
 * (string-width, breakLines, wrapLineAtWidth's codepoint count) but the
 * terminal advances to the next 8-column tab stop when it draws one — so any
 * tab-bearing line is under-measured, wraps past its computed break point,
 * and (in the input field) desyncs Ink's logical line count from the
 * physical row count, making log-update under-erase and re-emit rows on
 * every keystroke. Substituting a fixed run of spaces makes rendered width
 * equal measured width; visual fidelity to the terminal's own tab stops is
 * secondary to the accounting being right.
 */
export function expandTabs(s: string, tabWidth = 4): string {
	if (!s.includes("\t")) return s;
	return s.replaceAll("\t", " ".repeat(tabWidth));
}
