import type { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";

export interface DispatchEntry {
	message_id: string;
	thread_id: string;
	status: string;
	claimed_by: string | null;
	event_type: string;
	event_payload: string | null;
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
 * Enqueue a notification for dispatch. Notifications are non-user events
 * (task completions, advisories, etc.) that trigger agent inference.
 * Returns the generated entry ID.
 */
export function enqueueNotification(
	db: Database,
	threadId: string,
	payload: Record<string, unknown>,
): string {
	const entryId = randomUUID();
	const now = new Date().toISOString();
	db.prepare(
		`INSERT INTO dispatch_queue (message_id, thread_id, status, event_type, event_payload, created_at, modified_at)
		 VALUES (?, ?, 'pending', 'notification', ?, ?, ?)`,
	).run(entryId, threadId, JSON.stringify(payload), now, now);
	return entryId;
}

/**
 * Claim all pending messages for a thread. Returns the claimed entries and marks
 * them as 'processing' with the given host site ID.
 */
export function claimPending(db: Database, threadId: string, claimedBy: string): DispatchEntry[] {
	const now = new Date().toISOString();

	// Atomic SELECT + UPDATE inside BEGIN IMMEDIATE to prevent TOCTOU races
	// in multi-process deployments. IMMEDIATE acquires a write lock before the
	// SELECT, so no other process can claim the same entries concurrently.
	db.exec("BEGIN IMMEDIATE");
	try {
		const pending = db
			.prepare(
				`SELECT * FROM dispatch_queue
				 WHERE thread_id = ? AND status = 'pending'
				 ORDER BY created_at ASC`,
			)
			.all(threadId) as DispatchEntry[];

		if (pending.length === 0) {
			db.exec("COMMIT");
			return [];
		}

		const ids = pending.map((r) => r.message_id);
		const placeholders = ids.map(() => "?").join(",");
		db.prepare(
			`UPDATE dispatch_queue
			 SET status = 'processing', claimed_by = ?, modified_at = ?
			 WHERE message_id IN (${placeholders})`,
		).run(claimedBy, now, ...ids);

		db.exec("COMMIT");
		return pending;
	} catch (error) {
		try {
			db.exec("ROLLBACK");
		} catch {
			// ROLLBACK may fail if transaction was already rolled back
		}
		throw error;
	}
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
 * Reset 'processing' entries for a specific thread back to 'pending'.
 * Used when the drain loop yields cooperatively — only resets the yielding
 * thread's messages, not other threads' in-flight work.
 */
export function resetProcessingForThread(db: Database, threadId: string): number {
	const now = new Date().toISOString();
	db.prepare(
		`UPDATE dispatch_queue
		 SET status = 'pending', claimed_by = NULL, modified_at = ?
		 WHERE status = 'processing' AND thread_id = ?`,
	).run(now, threadId);
	const row = db.query("SELECT changes() as c").get() as { c: number } | null;
	return row?.c ?? 0;
}

/**
 * Check if a thread has any pending (unclaimed) messages in the dispatch queue.
 */
export function hasPending(db: Database, threadId: string): boolean {
	const row = db
		.prepare("SELECT COUNT(*) as c FROM dispatch_queue WHERE thread_id = ? AND status = 'pending'")
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
