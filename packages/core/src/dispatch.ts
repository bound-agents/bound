import type { Database } from "bun:sqlite";

export interface DispatchEntry {
	message_id: string;
	thread_id: string;
	status: string;
	claimed_by: string | null;
	created_at: string;
	modified_at: string;
}

/**
 * Enqueue a user message for dispatch. Idempotent — duplicate message_id is ignored.
 */
export function enqueueMessage(db: Database, messageId: string, threadId: string): void {
	const now = new Date().toISOString();
	db.prepare(
		`INSERT OR IGNORE INTO dispatch_queue (message_id, thread_id, status, created_at, modified_at)
		 VALUES (?, ?, 'pending', ?, ?)`,
	).run(messageId, threadId, now, now);
}

/**
 * Claim all pending messages for a thread. Returns the claimed entries and marks
 * them as 'processing' with the given host site ID.
 */
export function claimPending(
	db: Database,
	threadId: string,
	claimedBy: string,
): DispatchEntry[] {
	const now = new Date().toISOString();

	const pending = db
		.prepare(
			`SELECT * FROM dispatch_queue
			 WHERE thread_id = ? AND status = 'pending'
			 ORDER BY created_at ASC`,
		)
		.all(threadId) as DispatchEntry[];

	if (pending.length === 0) return [];

	const ids = pending.map((r) => r.message_id);
	const placeholders = ids.map(() => "?").join(",");
	db.prepare(
		`UPDATE dispatch_queue
		 SET status = 'processing', claimed_by = ?, modified_at = ?
		 WHERE message_id IN (${placeholders})`,
	).run(claimedBy, now, ...ids);

	return pending;
}

/**
 * Mark a batch of message IDs as acknowledged (dispatch complete).
 */
export function acknowledgeBatch(db: Database, messageIds: string[]): void {
	if (messageIds.length === 0) return;
	const now = new Date().toISOString();
	const placeholders = messageIds.map(() => "?").join(",");
	db.prepare(
		`UPDATE dispatch_queue
		 SET status = 'acknowledged', modified_at = ?
		 WHERE message_id IN (${placeholders})`,
	).run(now, ...messageIds);
}

/**
 * Reset all 'processing' entries back to 'pending'. Used at startup to recover
 * from interrupted inference. Returns the number of entries reset.
 */
export function resetProcessing(db: Database): number {
	const now = new Date().toISOString();
	db.prepare(
		`UPDATE dispatch_queue
		 SET status = 'pending', claimed_by = NULL, modified_at = ?
		 WHERE status = 'processing'`,
	).run(now);
	const row = db.query("SELECT changes() as c").get() as { c: number } | null;
	return row?.c ?? 0;
}

/**
 * Check if a thread has any pending (unclaimed) messages in the dispatch queue.
 */
export function hasPending(db: Database, threadId: string): boolean {
	const row = db
		.prepare(
			"SELECT COUNT(*) as c FROM dispatch_queue WHERE thread_id = ? AND status = 'pending'",
		)
		.get(threadId) as { c: number };
	return row.c > 0;
}

/**
 * Prune acknowledged entries older than the given ISO cutoff timestamp.
 * Returns the number of entries pruned.
 */
export function pruneAcknowledged(db: Database, cutoff: string): number {
	db.prepare(
		`DELETE FROM dispatch_queue
		 WHERE status = 'acknowledged' AND modified_at < ?`,
	).run(cutoff);
	const row = db.query("SELECT changes() as c").get() as { c: number } | null;
	return row?.c ?? 0;
}
