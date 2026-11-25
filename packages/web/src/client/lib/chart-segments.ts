/**
 * Split a series into runs of consecutive defined points so a `null` value
 * breaks the line instead of plotting as a false drop to zero.
 */
export function definedSegments<T>(points: readonly T[], isDefined: (p: T) => boolean): T[][] {
	const segments: T[][] = [];
	let current: T[] = [];
	for (const p of points) {
		if (isDefined(p)) {
			current.push(p);
		} else if (current.length > 0) {
			segments.push(current);
			current = [];
		}
	}
	if (current.length > 0) segments.push(current);
	return segments;
}

/** SVG line path over segments: each segment starts with its own `M`. */
export function segmentsLinePath<T>(
	segments: readonly T[][],
	xy: (p: T) => [number, number],
): string {
	return segments
		.map((seg) =>
			seg
				.map((p, i) => {
					const [x, y] = xy(p);
					return `${i === 0 ? "M" : "L"}${x},${y}`;
				})
				.join(" "),
		)
		.join(" ");
}

/** SVG area path over segments, each closed down to `baseline`. */
export function segmentsAreaPath<T>(
	segments: readonly T[][],
	xy: (p: T) => [number, number],
	baseline: number,
): string {
	return segments
		.map((seg) => {
			const line = segmentsLinePath([seg], xy);
			const first = seg[0];
			const last = seg[seg.length - 1];
			if (first === undefined || last === undefined) return "";
			return `${line} L${xy(last)[0]},${baseline} L${xy(first)[0]},${baseline} Z`;
		})
		.join(" ");
}
