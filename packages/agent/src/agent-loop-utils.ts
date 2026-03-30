import type { Database } from "bun:sqlite";

/**
 * Finds the first user message in a thread that arrived after the last
 * assistant response — i.e., a message that was likely skipped because
 * the agent loop was already active when it was delivered.
 *
 * Used by the start.ts event handler in its `finally` block: after a loop
 * completes, call this to detect queue-skipped messages and re-trigger.
 */
export function findPendingUserMessage(
	db: Database,
	threadId: string,
): { id: string; content: string; role: "user" } | null {
	const lastAssistant = db
		.prepare<{ created_at: string }, [string]>(
			"SELECT created_at FROM messages WHERE thread_id = ? AND role = 'assistant' AND deleted = 0 ORDER BY created_at DESC LIMIT 1",
		)
		.get(threadId);

	const cutoff = lastAssistant?.created_at ?? "1970-01-01T00:00:00.000Z";

	return (
		(db
			.prepare<{ id: string; content: string; role: "user" }, [string, string]>(
				"SELECT id, content, role FROM messages WHERE thread_id = ? AND role = 'user' AND deleted = 0 AND created_at > ? ORDER BY created_at ASC LIMIT 1",
			)
			.get(threadId, cutoff) as { id: string; content: string; role: "user" } | null) ?? null
	);
}
