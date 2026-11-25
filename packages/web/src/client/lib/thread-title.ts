/** Longest title `PATCH /api/threads/:id` accepts. */
export const MAX_THREAD_TITLE_LENGTH = 256;

/**
 * Resolve an inline-edit draft into the title to save, or `null` when the edit
 * should close without a request: blank, over the server's limit, or equal to
 * the current title once trimmed.
 */
export function resolveTitleEdit(draft: string, current: string | null | undefined): string | null {
	const title = draft.trim();
	if (!title || title.length > MAX_THREAD_TITLE_LENGTH) return null;
	if (title === current?.trim()) return null;
	return title;
}
