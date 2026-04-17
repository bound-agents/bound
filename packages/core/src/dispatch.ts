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

// Event type constants
export const CLIENT_TOOL_CALL = "client_tool_call";
export const TOOL_RESULT = "tool_result";

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
 * Enqueue a client tool call for dispatch. The call waits on the client to execute and return a result.
 * Returns the generated entry ID.
 */
export function enqueueClientToolCall(
	db: Database,
	threadId: string,
	payload: { call_id: string; tool_name: string; arguments: Record<string, unknown> },
	connectionId: string,
): string {
	const messageId = randomUUID();
	const now = new Date().toISOString();
	db.prepare(
		`INSERT INTO dispatch_queue (message_id, thread_id, status, event_type, event_payload, claimed_by, created_at, modified_at)
		 VALUES (?, ?, 'pending', ?, ?, ?, ?, ?)`,
	).run(messageId, threadId, CLIENT_TOOL_CALL, JSON.stringify(payload), connectionId, now, now);
	return messageId;
}

/**
 * Enqueue a tool result entry to trigger agent loop resume.
 * Returns the generated entry ID.
 */
export function enqueueToolResult(db: Database, threadId: string, callId: string): string {
	const messageId = randomUUID();
	const now = new Date().toISOString();
	db.prepare(
		`INSERT INTO dispatch_queue (message_id, thread_id, status, event_type, event_payload, created_at, modified_at)
		 VALUES (?, ?, 'pending', ?, ?, ?, ?)`,
	).run(messageId, threadId, TOOL_RESULT, JSON.stringify({ call_id: callId }), now, now);
	return messageId;
}

/**
 * Mark a single client tool call entry as acknowledged.
 */
export function acknowledgeClientToolCall(db: Database, entryId: string): void {
	const now = new Date().toISOString();
	db.prepare(
		`UPDATE dispatch_queue
		 SET status = 'acknowledged', modified_at = ?
		 WHERE message_id = ?`,
	).run(now, entryId);
}

/**
 * Claim all pending messages for a thread. Returns the claimed entries and marks
 * them as 'processing' with the given host site ID.
 * Skips client_tool_call entries — they wait for client execution.
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
				 WHERE thread_id = ? AND status = 'pending' AND event_type != ?
				 ORDER BY created_at ASC`,
			)
			.all(threadId, CLIENT_TOOL_CALL) as DispatchEntry[];

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
 * Excludes client_tool_call entries — they're handled separately.
 */
export function resetProcessing(db: Database): number {
	const now = new Date().toISOString();
	db.prepare(
		`UPDATE dispatch_queue
		 SET status = 'pending', claimed_by = NULL, modified_at = ?
		 WHERE status = 'processing' AND event_type != ?`,
	).run(now, CLIENT_TOOL_CALL);
	const row = db.query("SELECT changes() as c").get() as { c: number } | null;
	return row?.c ?? 0;
}

/**
 * Reset 'processing' entries for a specific thread back to 'pending'.
 * Used when the drain loop yields cooperatively — only resets the yielding
 * thread's messages, not other threads' in-flight work.
 * Excludes client_tool_call entries — they're handled separately.
 */
export function resetProcessingForThread(db: Database, threadId: string): number {
	const now = new Date().toISOString();
	db.prepare(
		`UPDATE dispatch_queue
		 SET status = 'pending', claimed_by = NULL, modified_at = ?
		 WHERE status = 'processing' AND thread_id = ? AND event_type != ?`,
	).run(now, threadId, CLIENT_TOOL_CALL);
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
 * Check if a thread has any unresolved client tool calls (pending or processing).
 */
export function hasPendingClientToolCalls(db: Database, threadId: string): boolean {
	const row = db
		.prepare(
			`SELECT COUNT(*) as c FROM dispatch_queue
			 WHERE thread_id = ? AND event_type = ? AND status IN ('pending', 'processing')`,
		)
		.get(threadId, CLIENT_TOOL_CALL) as { c: number };
	return row.c > 0;
}

/**
 * Get all pending/processing client tool calls for a thread.
 * Returns the entries (event_payload is JSON-encoded).
 */
export function getPendingClientToolCalls(db: Database, threadId: string): DispatchEntry[] {
	return db
		.prepare(
			`SELECT * FROM dispatch_queue
			 WHERE thread_id = ? AND event_type = ? AND status IN ('pending', 'processing')
			 ORDER BY created_at ASC`,
		)
		.all(threadId, CLIENT_TOOL_CALL) as DispatchEntry[];
}

/**
 * Expire stale client tool calls that exceeded TTL.
 * Returns the list of expired entries.
 * Atomic SELECT + UPDATE inside BEGIN IMMEDIATE to prevent TOCTOU races.
 */
export function expireClientToolCalls(
	db: Database,
	ttlMs: number,
	threadId?: string,
): DispatchEntry[] {
	const now = new Date().toISOString();
	const cutoff = new Date(Date.now() - ttlMs).toISOString();

	// Atomic SELECT + UPDATE inside BEGIN IMMEDIATE to prevent TOCTOU races
	// in multi-process deployments. IMMEDIATE acquires a write lock before the
	// SELECT, so no other process can modify the same entries concurrently.
	db.exec("BEGIN IMMEDIATE");
	try {
		// Get the entries that will expire
		const expired = threadId
			? (db
					.prepare(
						`SELECT * FROM dispatch_queue
					 WHERE event_type = ? AND status IN ('pending', 'processing') AND created_at < ? AND thread_id = ?`,
					)
					.all(CLIENT_TOOL_CALL, cutoff, threadId) as DispatchEntry[])
			: (db
					.prepare(
						`SELECT * FROM dispatch_queue
					 WHERE event_type = ? AND status IN ('pending', 'processing') AND created_at < ?`,
					)
					.all(CLIENT_TOOL_CALL, cutoff) as DispatchEntry[]);

		// Update the entries to expired status
		if (expired.length > 0) {
			if (threadId) {
				db.prepare(
					`UPDATE dispatch_queue
				 SET status = 'expired', modified_at = ?
				 WHERE event_type = ? AND status IN ('pending', 'processing') AND created_at < ? AND thread_id = ?`,
				).run(now, CLIENT_TOOL_CALL, cutoff, threadId);
			} else {
				db.prepare(
					`UPDATE dispatch_queue
				 SET status = 'expired', modified_at = ?
				 WHERE event_type = ? AND status IN ('pending', 'processing') AND created_at < ?`,
				).run(now, CLIENT_TOOL_CALL, cutoff);
			}
		}

		db.exec("COMMIT");
		return expired;
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
 * Cancel all pending client tool calls for a specific thread.
 * Returns the count of cancelled entries.
 */
export function cancelClientToolCalls(db: Database, threadId: string): number {
	const now = new Date().toISOString();
	db.prepare(
		`UPDATE dispatch_queue
		 SET status = 'expired', modified_at = ?
		 WHERE thread_id = ? AND event_type = ? AND status IN ('pending', 'processing')`,
	).run(now, threadId, CLIENT_TOOL_CALL);
	const row = db.query("SELECT changes() as c").get() as { c: number } | null;
	return row?.c ?? 0;
}

/**
 * Update the claimed_by and status fields of a dispatch_queue entry.
 * Used when re-delivering tool calls on reconnect.
 */
export function updateClaimedBy(db: Database, entryId: string, connectionId: string): void {
	const now = new Date().toISOString();
	db.prepare(
		`UPDATE dispatch_queue
		 SET claimed_by = ?, status = 'processing', modified_at = ?
		 WHERE message_id = ?`,
	).run(connectionId, now, entryId);
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
