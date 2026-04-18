/**
 * Format a file attachment reference for inclusion in a user message.
 * All attachment types (text, binary) get the same compact format
 * that points to where the file is stored in the VFS.
 */
export function formatFileAttachment(name: string, path: string, sizeBytes: number): string {
	return `[Attached file: ${name} — saved to ${path} (${sizeBytes} bytes)]`;
}

/**
 * Slice a string at a code-unit boundary without splitting surrogate pairs.
 * JavaScript strings are UTF-16; characters outside the BMP (emoji, CJK
 * Extension B, etc.) are stored as two code units (a surrogate pair).
 * A naive `.slice(0, n)` can cut between them, producing an orphaned
 * high surrogate that is invalid UTF-8 and therefore invalid JSON.
 */
export function safeSlice(str: string, start: number, end: number): string {
	// Clamp end to string length
	let clampedEnd = end > str.length ? str.length : end;

	// If the character just before `clampedEnd` is a high surrogate (U+D800–U+DBFF),
	// the character at `clampedEnd` would be its low surrogate — step back to keep
	// the pair intact (by excluding it) rather than splitting it.
	if (
		clampedEnd > start &&
		clampedEnd < str.length &&
		str.charCodeAt(clampedEnd - 1) >= 0xd800 &&
		str.charCodeAt(clampedEnd - 1) <= 0xdbff
	) {
		clampedEnd--;
	}

	return str.slice(start, clampedEnd);
}
