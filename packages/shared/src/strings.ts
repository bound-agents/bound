/**
 * Slice a string at a code-unit boundary without splitting surrogate pairs.
 * JavaScript strings are UTF-16; characters outside the BMP (emoji, CJK
 * Extension B, etc.) are stored as two code units (a surrogate pair).
 * A naive `.slice(0, n)` can cut between them, producing an orphaned
 * high surrogate that is invalid UTF-8 and therefore invalid JSON.
 */
export function safeSlice(str: string, start: number, end: number): string {
	// Clamp end to string length
	if (end > str.length) end = str.length;

	// If the character just before `end` is a high surrogate (U+D800–U+DBFF),
	// the character at `end` would be its low surrogate — step back to keep
	// the pair intact (by excluding it) rather than splitting it.
	if (
		end > start &&
		end < str.length &&
		str.charCodeAt(end - 1) >= 0xd800 &&
		str.charCodeAt(end - 1) <= 0xdbff
	) {
		end--;
	}

	return str.slice(start, end);
}
