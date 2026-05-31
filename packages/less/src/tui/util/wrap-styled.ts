import wrapAnsi from "wrap-ansi";

/**
 * A run of text carrying a single visual style. Mirrors the inline styles
 * the Markdown renderer can emit (bold/italic/underline/strikethrough/dim
 * and a foreground color). A paragraph of marked inline tokens flattens into
 * a sequence of these.
 */
export interface StyledRun {
	text: string;
	bold?: boolean;
	italic?: boolean;
	underline?: boolean;
	strikethrough?: boolean;
	dim?: boolean;
	color?: string;
}

/**
 * Wrap a sequence of styled runs to `width` columns, returning an array of
 * visual lines (each a list of styled runs). Leading whitespace on every
 * continuation line (index ≥ 1) is elided per issue #130; the first line's
 * leading whitespace is preserved so intentional indentation survives.
 *
 * Break positions are computed by `wrap-ansi` over the concatenated PLAIN
 * text. ANSI styling is zero-width, so the break points of the plain text are
 * identical to those of the styled text — which lets us avoid emitting raw
 * SGR codes (and the chalk color-level detection that comes with them) and
 * instead re-apply styling by slicing the original runs at the wrap
 * boundaries. Ink then styles each sub-run natively via `<Text>`.
 *
 * `wrap-ansi` with `{ hard: true, trim: false }` preserves every input
 * character (it only inserts `\n` at break points), so the concatenation of
 * the returned lines equals the input. That invariant is what makes the
 * char-offset → run-slice mapping below exact.
 */
export function wrapStyledRuns(runs: StyledRun[], width: number): StyledRun[][] {
	const plain = runs.map((r) => r.text).join("");
	if (plain.length === 0) {
		return [[]];
	}
	if (width <= 0) {
		return [runs];
	}

	const wrapped = wrapAnsi(plain, width, { hard: true, trim: false });
	const lineStrings = wrapped.split("\n");

	const out: StyledRun[][] = [];
	let cursor = 0;
	for (let li = 0; li < lineStrings.length; li++) {
		let start = cursor;
		const end = cursor + lineStrings[li].length;
		cursor = end;
		// Elide leading whitespace on continuation lines (issue #130). The
		// first line keeps any leading whitespace (intentional indentation).
		if (li > 0) {
			while (start < end && (plain[start] === " " || plain[start] === "\t")) {
				start++;
			}
		}
		out.push(sliceRuns(runs, start, end));
	}
	return out;
}

/**
 * Slice the run sequence to the half-open character range [start, end) in the
 * concatenated plain text, preserving each run's style on the overlapping
 * portion. Empty slices are dropped so a line carries only runs with content.
 */
function sliceRuns(runs: StyledRun[], start: number, end: number): StyledRun[] {
	const out: StyledRun[] = [];
	let pos = 0;
	for (const run of runs) {
		const runStart = pos;
		const runEnd = pos + run.text.length;
		pos = runEnd;
		// Intersect [runStart, runEnd) with [start, end).
		const from = Math.max(runStart, start);
		const to = Math.min(runEnd, end);
		if (from < to) {
			out.push({ ...run, text: run.text.slice(from - runStart, to - runStart) });
		}
		if (runEnd >= end) {
			break;
		}
	}
	return out;
}
