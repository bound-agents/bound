const ELLIPSIS = "…";

/**
 * Collapse all whitespace (newlines, tabs, CR, runs of spaces) in a thread
 * title to single spaces so the label renders on exactly one terminal row.
 */
function collapseWhitespace(s: string): string {
	return s.replace(/\s+/g, " ").trim();
}

/**
 * Build the single-line label shown for a thread in `/attach`.
 *
 * Guarantees:
 *   1. No newlines — titles with embedded \n won't balloon the picker vertically.
 *   2. The full thread id is always present when it fits, so users can copy it.
 *   3. If the combined label overflows `columns`, the title is truncated with an
 *      ellipsis while the id remains intact.
 */
export function formatThreadPickerLabel(
	title: string | null | undefined,
	id: string,
	columns: number,
): string {
	const cleaned = title ? collapseWhitespace(title) : "";
	if (!cleaned) return id;

	const idSuffix = `  (${id})`;
	const full = `${cleaned}${idSuffix}`;
	if (full.length <= columns) return full;

	// Not enough room even for "…  (id)" — fall back to id only.
	const minWithEllipsis = ELLIPSIS.length + idSuffix.length;
	if (columns < minWithEllipsis) return id;

	const titleBudget = columns - idSuffix.length - ELLIPSIS.length;
	const truncated = cleaned.slice(0, Math.max(0, titleBudget));
	return `${truncated}${ELLIPSIS}${idSuffix}`;
}
