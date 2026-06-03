/**
 * Shared string-matching helper for the edit tool family.
 *
 * Both `boundless_edit` (occurrence count + multi-match context) and the ACP
 * `toolCallLocations` follow-along mapping need to know where a search string
 * occurs in a file. This is the single source of truth for that: it reports
 * every non-overlapping occurrence and the 1-based line on which each begins.
 *
 * Correct for multi-line search strings — the reported line is where the
 * match's first character sits, computed from the character offset rather than
 * a per-line substring scan (which silently misses matches that span lines).
 */

export interface StringOccurrence {
	/** 1-based line number where this occurrence begins. */
	line: number;
	/** Text of the line where the occurrence begins, for context display. */
	lineText: string;
}

export interface OccurrenceResult {
	/** Number of non-overlapping occurrences of the search string. */
	count: number;
	/** Each occurrence's starting position, in document order. */
	occurrences: StringOccurrence[];
}

/**
 * Finds all non-overlapping occurrences of `search` in `content`, reporting the
 * 1-based line on which each occurrence begins. An empty search string matches
 * nothing.
 */
export function findStringOccurrences(content: string, search: string): OccurrenceResult {
	if (search.length === 0) {
		return { count: 0, occurrences: [] };
	}

	const lines = content.split("\n");
	const occurrences: StringOccurrence[] = [];

	// Walk occurrences left-to-right, counting newlines incrementally so the
	// whole pass is O(content length) rather than O(content × matches).
	let from = 0;
	let scannedUpTo = 0;
	let line = 1;
	while (true) {
		const idx = content.indexOf(search, from);
		if (idx === -1) break;
		for (let i = scannedUpTo; i < idx; i++) {
			if (content.charCodeAt(i) === 10 /* \n */) line++;
		}
		scannedUpTo = idx;
		occurrences.push({ line, lineText: lines[line - 1] ?? "" });
		from = idx + search.length;
	}

	return { count: occurrences.length, occurrences };
}
