/**
 * Line-level diffing utility for `edit` tool call rendering.
 *
 * The `boundless_edit` tool's args carry an `old_string`/`new_string` pair —
 * usually short snippets of code — and we want to render that as a unified
 * diff (red removed lines, green added lines, dim context) inline with the
 * tool call header.
 *
 * Implementation: classic O(m·n) LCS DP table over line arrays, walked
 * backwards to produce a unified diff. For the typical input sizes here
 * (tens of lines, occasionally hundreds) the cost is negligible and not
 * worth pulling in a dependency. If a pathological multi-thousand-line
 * edit ever shows up, hunking caps the rendered output anyway.
 */

export type DiffLine =
	| { kind: "same"; text: string }
	| { kind: "remove"; text: string }
	| { kind: "add"; text: string };

export type HunkedDiffEntry = DiffLine | { kind: "ellipsis"; count: number };

/**
 * Compute a line-level unified diff between two texts.
 *
 * Lines are split on `\n`. Returns an interleaved sequence where unchanged
 * lines appear once (kind: "same"), removed lines appear with kind:
 * "remove", and added lines appear with kind: "add". By convention,
 * removed lines come BEFORE added lines within a contiguous change run.
 */
export function computeLineDiff(oldText: string, newText: string): DiffLine[] {
	const oldLines = oldText === "" ? [] : oldText.split("\n");
	const newLines = newText === "" ? [] : newText.split("\n");

	const m = oldLines.length;
	const n = newLines.length;

	if (m === 0 && n === 0) return [];
	if (m === 0) return newLines.map((t) => ({ kind: "add", text: t }) as const);
	if (n === 0) return oldLines.map((t) => ({ kind: "remove", text: t }) as const);

	// LCS DP table
	const dp: number[][] = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
	for (let i = 1; i <= m; i++) {
		for (let j = 1; j <= n; j++) {
			if (oldLines[i - 1] === newLines[j - 1]) {
				dp[i][j] = dp[i - 1][j - 1] + 1;
			} else {
				dp[i][j] = Math.max(dp[i - 1][j], dp[i][j - 1]);
			}
		}
	}

	// Walk back through the DP table, emitting in reverse order. The
	// tiebreaker (strict `>` rather than `>=`) ensures that when both
	// directions yield equal LCS length, we step LEFT (j--) first, which
	// means after the final reverse, removes precede adds within a run.
	const reversed: DiffLine[] = [];
	let i = m;
	let j = n;
	while (i > 0 && j > 0) {
		if (oldLines[i - 1] === newLines[j - 1]) {
			reversed.push({ kind: "same", text: oldLines[i - 1] });
			i--;
			j--;
		} else if (dp[i - 1][j] > dp[i][j - 1]) {
			reversed.push({ kind: "remove", text: oldLines[i - 1] });
			i--;
		} else {
			reversed.push({ kind: "add", text: newLines[j - 1] });
			j--;
		}
	}
	while (i > 0) {
		reversed.push({ kind: "remove", text: oldLines[i - 1] });
		i--;
	}
	while (j > 0) {
		reversed.push({ kind: "add", text: newLines[j - 1] });
		j--;
	}

	return reversed.reverse();
}

/**
 * Collapse long runs of unchanged context into ellipsis markers, the way
 * `git diff` produces hunks. Each change is surrounded by `context` lines
 * of unchanged context on either side; longer "same" runs between changes
 * (or at the start/end of the diff) get collapsed into a single ellipsis
 * entry.
 *
 * If there are no changes at all, returns an empty array — a pure-context
 * diff has nothing to show.
 */
export function hunkDiff(diff: DiffLine[], context = 3): HunkedDiffEntry[] {
	const interesting: number[] = [];
	for (let k = 0; k < diff.length; k++) {
		if (diff[k].kind !== "same") interesting.push(k);
	}
	if (interesting.length === 0) return [];

	// Compute merged ranges of indices to keep.
	const ranges: Array<{ start: number; end: number }> = [];
	for (const idx of interesting) {
		const start = Math.max(0, idx - context);
		const end = Math.min(diff.length - 1, idx + context);
		const last = ranges[ranges.length - 1];
		if (last && start <= last.end + 1) {
			last.end = Math.max(last.end, end);
		} else {
			ranges.push({ start, end });
		}
	}

	const out: HunkedDiffEntry[] = [];
	let cursor = 0;
	for (const { start, end } of ranges) {
		if (start > cursor) {
			out.push({ kind: "ellipsis", count: start - cursor });
		}
		for (let k = start; k <= end; k++) {
			out.push(diff[k]);
		}
		cursor = end + 1;
	}
	if (cursor < diff.length) {
		out.push({ kind: "ellipsis", count: diff.length - cursor });
	}
	return out;
}
