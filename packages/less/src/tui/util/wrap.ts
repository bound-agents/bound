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
 * Wrap each line in `lines` to `width` and return the flattened sequence
 * of visual rows. Order is preserved; an N-line input that produces M
 * visual rows after wrapping returns those M rows in order.
 */
export function wrapLinesAtWidth(lines: readonly string[], width: number): string[] {
	const out: string[] = [];
	for (const line of lines) {
		for (const chunk of wrapLineAtWidth(line, width)) {
			out.push(chunk);
		}
	}
	return out;
}
