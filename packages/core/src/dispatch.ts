import type { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import type { TypedEventEmitter } from "@bound/shared";
import { readMessageMetadata, updateRow } from "./change-log";
import {
	LOCAL_WORK_TARGET,
	acknowledgeDurableWork,
	consumePendingDispatchByIdempotencyKey,
	insertDurableWork,
} from "./durable-work";
import { countBackgroundToolCallsByThread } from "./repositories/messages";

/** Set BOUND_DURABLE_DISPATCH=0 or false before startup to route new enqueues to legacy dispatch_queue. */
export let DURABLE_DISPATCH_ENQUEUE_ENABLED = !["0", "false"].includes(
	process.env.BOUND_DURABLE_DISPATCH?.toLowerCase() ?? "",
);

/** Test seam for exercising the rollback route without changing production defaults. */
export function setDurableDispatchEnqueueEnabledForTesting(enabled: boolean): void {
	DURABLE_DISPATCH_ENQUEUE_ENABLED = enabled;
}

export interface DispatchEntry {
	message_id: string;
	thread_id: string;
	status: string;
	claimed_by: string | null;
	event_type: string;
	event_payload: string | null;
	created_at: string;
	modified_at: string;
	durable_work_id?: string;
	durable_claim_token?: string | null;
}

// Event type constants
export const CLIENT_TOOL_CALL = "client_tool_call";
export const TOOL_RESULT = "tool_result";

/** Dispatch wakeups share one durable kind; the event type stays in the payload. */
function enqueueDurableDispatch(
	db: Database,
	threadId: string,
	messageId: string,
	eventType: string,
	eventPayload: string | null,
	idempotencyKey: string,
): void {
	insertDurableWork(db, {
		id: randomUUID(),
		target_site_id: LOCAL_WORK_TARGET,
		kind: "dispatch_message",
		payload: JSON.stringify({
			message_id: messageId,
			thread_id: threadId,
			event_type: eventType,
			event_payload: eventPayload,
		}),
		idempotency_key: idempotencyKey,
	});
}

/** Enqueue a user message for dispatch. Idempotent on its message id. */
export function enqueueMessage(db: Database, messageId: string, threadId: string): void {
	if (DURABLE_DISPATCH_ENQUEUE_ENABLED) {
		enqueueDurableDispatch(db, threadId, messageId, "user_message", null, messageId);
		return;
	}
	const now = new Date().toISOString();
	db.prepare(
		`INSERT OR IGNORE INTO dispatch_queue (message_id, thread_id, status, created_at, modified_at) VALUES (?, ?, 'pending', ?, ?)`,
	).run(messageId, threadId, now, now);
}

/** Enqueue a notification for dispatch. */
export function enqueueNotification(
	db: Database,
	threadId: string,
	payload: Record<string, unknown>,
	idempotencyKey?: string,
): string {
	const entryId = idempotencyKey ?? randomUUID();
	if (DURABLE_DISPATCH_ENQUEUE_ENABLED) {
		enqueueDurableDispatch(
			db,
			threadId,
			entryId,
			"notification",
			JSON.stringify(payload),
			idempotencyKey ?? `notify:${entryId}`,
		);
		return entryId;
	}
	const now = new Date().toISOString();
	db.prepare(
		`INSERT OR IGNORE INTO dispatch_queue (message_id, thread_id, status, event_type, event_payload, created_at, modified_at) VALUES (?, ?, 'pending', 'notification', ?, ?, ?)`,
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
 *
 * IDEMPOTENT on `(thread_id, call_id)` (R-UD9) WHILE THE RE-DRIVE IS IN FLIGHT:
 * re-driving the same tool result — e.g. a relayed `client_result` retried after
 * a held/duplicated delivery — is a no-op that returns the EXISTING entry's id
 * rather than inserting a second row. Without this guard a relay retry would
 * double-enqueue and risk double-execution / a duplicate tool-result row.
 *
 * The dedup is scoped to rows still `pending`/`processing`. `call_id` is only
 * unique within one turn, NOT across a thread's lifetime — clients (boundless)
 * reuse `call_1, call_2, …` every turn. A guard that also matched already-
 * `acknowledged` rows would drop a legitimate NEW turn's re-drive for a reused
 * call_id, so the loop never gets its wakeup and the thread stalls one message
 * per turn (this was a real regression). Once the prior re-drive is
 * consumed (acknowledged), the same call_id is free to enqueue a fresh row; a
 * genuine retry arrives while the original is still in flight and is deduped.
 * The match is scoped to the canonical `{"call_id":"…"}` payload this function
 * writes, so it is stable across calls.
 *
 * Returns the (existing or newly-created) entry id.
 */
export function enqueueToolResult(db: Database, threadId: string, callId: string): string {
	const payload = JSON.stringify({ call_id: callId });
	if (DURABLE_DISPATCH_ENQUEUE_ENABLED) {
		const messageId = randomUUID();
		enqueueDurableDispatch(
			db,
			threadId,
			messageId,
			TOOL_RESULT,
			payload,
			`tool-result:${threadId}:${callId}`,
		);
		const existing = db
			.query(
				"SELECT payload FROM durable_work WHERE kind = 'dispatch_message' AND idempotency_key = ?",
			)
			.get(`tool-result:${threadId}:${callId}`) as { payload: string } | null;
		return existing
			? (JSON.parse(existing.payload) as { message_id: string }).message_id
			: messageId;
	}
	const existing = db
		.prepare(
			`SELECT message_id FROM dispatch_queue
			 WHERE thread_id = ? AND event_type = ? AND event_payload = ?
			   AND status IN ('pending', 'processing')
			 LIMIT 1`,
		)
		.get(threadId, TOOL_RESULT, payload) as { message_id: string } | null;
	if (existing) {
		// Already enqueued for this (thread_id, call_id) — re-drive is a no-op.
		return existing.message_id;
	}

	const messageId = randomUUID();
	const now = new Date().toISOString();
	db.prepare(
		`INSERT INTO dispatch_queue (message_id, thread_id, status, event_type, event_payload, created_at, modified_at)
		 VALUES (?, ?, 'pending', ?, ?, ?, ?)`,
	).run(messageId, threadId, TOOL_RESULT, payload, now, now);
	return messageId;
}

/**
 * Resolve a deferred tool result by updating the placeholder tool_result message
 * with the real content and re-waking the loop via `enqueueToolResult`.
 *
 * The placeholder was written by the loop when the tool returned a
 * `DeferredToolResult`. This function finds it by `(thread_id, tool_name=callId,
 * role='tool_result')`, updates the content, clears the `background` marker so
 * the row stops counting as in-flight, and enqueues a dispatch entry to re-wake
 * the loop.
 *
 * If the placeholder is not found (race: background work completed before the
 * loop persisted the placeholder), this is a no-op beyond the enqueue — the
 * loop will write the placeholder on its current iteration and the model will
 * see it then.
 *
 * Pass `eventBus` to push the recomputed in-flight count to subscribers
 * (`background:count`). The count is always re-derived from `messages`, never
 * decremented, so a client that missed a frame resyncs rather than drifting.
 */
export function resolveDeferredToolResult(
	db: Database,
	threadId: string,
	callId: string,
	content: string,
	isError: boolean,
	siteId: string,
	eventBus?: TypedEventEmitter,
): void {
	const row = db
		.prepare(
			`SELECT id FROM messages
			 WHERE thread_id = ? AND tool_name = ? AND role = 'tool_result' AND deleted = 0
			 ORDER BY created_at DESC LIMIT 1`,
		)
		.get(threadId, callId) as { id: string } | null;

	if (row) {
		// Drop the `background` key rather than setting it false: the in-flight
		// query counts rows that CARRY the marker, and writeMessageMetadata merges
		// (so it could never remove a key). Stamp `background_delivered` in its
		// place so delivery is durable on the row itself — the dispatcher's
		// clobber guard keys on proof-of-delivery, not on the in-flight marker
		// having been present (#220: a placeholder that missed its stamp must
		// still be resolvable). Any sibling metadata is preserved.
		const { background: _wasBackground, ...rest } = readMessageMetadata(db, row.id) ?? {};
		const remaining = JSON.stringify({ ...rest, background_delivered: true });

		updateRow(
			db,
			"messages",
			row.id,
			{
				content,
				exit_code: isError ? 1 : 0,
				metadata: remaining,
			},
			siteId,
		);
	}

	enqueueToolResult(db, threadId, callId);

	if (eventBus) {
		eventBus.emit("background:count", {
			thread_id: threadId,
			count: countBackgroundToolCallsByThread(db, threadId),
		});
	}
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
	db.exec("BEGIN IMMEDIATE");
	try {
		// Durable first: this establishes the new-store fence before legacy rows are considered.
		const durable = db
			.query(
				`SELECT * FROM durable_work WHERE target_site_id = ? AND kind = 'dispatch_message' AND claim_state = 'pending' AND json_extract(payload, '$.thread_id') = ? ORDER BY created_at`,
			)
			.all(LOCAL_WORK_TARGET, threadId) as Array<{
			id: string;
			payload: string;
			claim_token: string | null;
			created_at: string;
		}>;
		const entries: DispatchEntry[] = [];
		for (const row of durable) {
			const token = randomUUID();
			db.prepare(
				"UPDATE durable_work SET claim_state = 'processing', claim_token = ?, claimed_at = ?, attempt_count = attempt_count + 1 WHERE id = ? AND claim_state = 'pending'",
			).run(token, now, row.id);
			const payload = JSON.parse(row.payload) as Pick<
				DispatchEntry,
				"message_id" | "thread_id" | "event_type" | "event_payload"
			>;
			entries.push({
				...payload,
				status: "processing",
				claimed_by: claimedBy,
				created_at: row.created_at,
				modified_at: now,
				durable_work_id: row.id,
				durable_claim_token: token,
			});
		}
		const pending = db
			.prepare(
				`SELECT * FROM dispatch_queue WHERE thread_id = ? AND status = 'pending' AND event_type != ? ORDER BY created_at ASC`,
			)
			.all(threadId, CLIENT_TOOL_CALL) as DispatchEntry[];
		// Every durable state remains a bridge fence. In particular, allowing a
		// legacy twin after a durable dead letter would silently bypass the durable
		// failure decision; consumed rows retain the same fence during their TTL.
		const durableFenceRows = db
			.query(
				`SELECT payload FROM durable_work
				 WHERE target_site_id = ? AND kind = 'dispatch_message'
				   AND json_extract(payload, '$.thread_id') = ?`,
			)
			.all(LOCAL_WORK_TARGET, threadId) as Array<{ payload: string }>;
		const fenced = new Set(
			durableFenceRows.map(({ payload }) => {
				const entry = JSON.parse(payload) as Pick<
					DispatchEntry,
					"message_id" | "thread_id" | "event_type" | "event_payload"
				>;
				return entry.event_type === "tool_result"
					? `tool-result:${entry.thread_id}:${JSON.parse(entry.event_payload ?? "{}").call_id}`
					: entry.message_id;
			}),
		);
		const legacy = pending.filter((entry) => {
			const identity =
				entry.event_type === "tool_result"
					? `tool-result:${entry.thread_id}:${JSON.parse(entry.event_payload ?? "{}").call_id}`
					: entry.message_id;
			return !fenced.has(identity);
		});
		const suppressed = pending.filter((entry) => !legacy.includes(entry));
		if (suppressed.length) {
			const ids = suppressed.map((row) => row.message_id);
			db.prepare(
				`UPDATE dispatch_queue SET status = 'acknowledged', modified_at = ? WHERE message_id IN (${ids.map(() => "?").join(",")})`,
			).run(now, ...ids);
		}
		if (legacy.length) {
			const ids = legacy.map((r) => r.message_id);
			const placeholders = ids.map(() => "?").join(",");
			db.prepare(
				`UPDATE dispatch_queue SET status = 'processing', claimed_by = ?, modified_at = ? WHERE message_id IN (${placeholders})`,
			).run(claimedBy, now, ...ids);
		}
		db.exec("COMMIT");
		return [...entries, ...legacy];
	} catch (error) {
		try {
			db.exec("ROLLBACK");
		} catch {}
		throw error;
	}
}

/**
 * Mark a batch of message IDs as acknowledged (dispatch complete).
 */
export function acknowledgeBatch(db: Database, entries: DispatchEntry[] | string[]): void {
	if (entries.length > 0 && typeof entries[0] === "string") {
		const now = new Date().toISOString();
		const ids = entries as string[];
		const placeholders = ids.map(() => "?").join(",");
		db.prepare(
			`UPDATE dispatch_queue SET status = 'acknowledged', modified_at = ? WHERE message_id IN (${placeholders})`,
		).run(now, ...ids);
		return;
	}
	const dispatchEntries = entries as DispatchEntry[];
	const legacyIds = dispatchEntries
		.filter((entry) => !entry.durable_work_id)
		.map((entry) => entry.message_id);
	if (legacyIds.length) {
		const now = new Date().toISOString();
		const placeholders = legacyIds.map(() => "?").join(",");
		db.prepare(
			`UPDATE dispatch_queue SET status = 'acknowledged', modified_at = ? WHERE message_id IN (${placeholders})`,
		).run(now, ...legacyIds);
	}
	for (const entry of dispatchEntries)
		if (entry.durable_work_id && entry.durable_claim_token)
			acknowledgeDurableWork(db, entry.durable_work_id, entry.durable_claim_token);
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

/** Release only this thread's abandoned durable dispatch claims after a yielded or failed loop. */
export function resetProcessingDurableDispatchForThread(db: Database, threadId: string): number {
	const row = db
		.prepare(
			`UPDATE durable_work
			 SET claim_state = 'pending', claim_token = NULL, claimed_at = NULL
			 WHERE target_site_id = ?
			   AND kind = 'dispatch_message'
			   AND claim_state = 'processing'
			   AND json_extract(payload, '$.thread_id') = ?`,
		)
		.run(LOCAL_WORK_TARGET, threadId) as { changes: number };
	return row.changes;
}

/**
 * Check if a thread has any pending (unclaimed) messages in the dispatch queue
 * that the executor should drain. Excludes client_tool_call entries — those are
 * waiting for client execution, not executor work, and would otherwise cause the
 * drain loop to spin (claimPending skips them, but the loop re-enters while
 * hasPending still reports true). See hasPendingClientToolCalls for the client
 * side of the queue.
 */
export function hasPending(db: Database, threadId: string): boolean {
	const row = db
		.prepare(
			`SELECT COUNT(*) as c FROM dispatch_queue WHERE thread_id = ? AND status = 'pending' AND event_type != ?`,
		)
		.get(threadId, CLIENT_TOOL_CALL) as { c: number };
	const durable = db
		.prepare(
			`SELECT COUNT(*) as c FROM durable_work WHERE target_site_id = ? AND kind = 'dispatch_message' AND claim_state = 'pending' AND json_extract(payload, '$.thread_id') = ?`,
		)
		.get(LOCAL_WORK_TARGET, threadId) as { c: number };
	return row.c + durable.c > 0;
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
 * True if a connection is holding any in-flight (pending|processing) client
 * tool call. Used by the WS liveness sweep to scope its blast radius: a
 * connection is only force-closed when it has an actual wedged call to free,
 * so a silent-but-idle client (nothing outstanding) is never disturbed.
 */
export function hasInFlightClientToolCallsForConnection(
	db: Database,
	connectionId: string,
): boolean {
	const row = db
		.prepare(
			`SELECT COUNT(*) as c FROM dispatch_queue
			 WHERE claimed_by = ? AND event_type = ? AND status IN ('pending', 'processing')`,
		)
		.get(connectionId, CLIENT_TOOL_CALL) as { c: number };
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
 *
 * `excludeThreadIds` skips entries whose thread is in the set. The TTL clock
 * starts at enqueue and does not reset, so a call that legitimately holds for a
 * passenger — a human deliberating at a permission gate, a slow local exec —
 * burns the same window as a genuinely stuck call. The expiry scan passes the
 * threads that still have a live client session here so those calls aren't
 * reaped out from under a connected client; a dead connection has no entry in
 * the set and expires as before. Liveness is defined in `delegation.ts`
 * (`getClientSessions`), which lives above `core` in the dep graph, so the
 * caller resolves the set and hands it down rather than core reaching up for it.
 */
export function expireClientToolCalls(
	db: Database,
	ttlMs: number,
	threadId?: string,
	excludeThreadIds?: readonly string[],
): DispatchEntry[] {
	const now = new Date().toISOString();
	const cutoff = new Date(Date.now() - ttlMs).toISOString();

	const conditions = ["event_type = ?", "status IN ('pending', 'processing')", "created_at < ?"];
	const params: string[] = [CLIENT_TOOL_CALL, cutoff];
	if (threadId) {
		conditions.push("thread_id = ?");
		params.push(threadId);
	}
	const excluded = excludeThreadIds?.filter((t) => t.length > 0) ?? [];
	if (excluded.length > 0) {
		conditions.push(`thread_id NOT IN (${excluded.map(() => "?").join(", ")})`);
		params.push(...excluded);
	}
	const whereClause = conditions.join(" AND ");

	// Atomic SELECT + UPDATE inside BEGIN IMMEDIATE to prevent TOCTOU races
	// in multi-process deployments. IMMEDIATE acquires a write lock before the
	// SELECT, so no other process can modify the same entries concurrently.
	db.exec("BEGIN IMMEDIATE");
	try {
		// Get the entries that will expire
		const expired = db
			.prepare(`SELECT * FROM dispatch_queue WHERE ${whereClause}`)
			.all(...params) as DispatchEntry[];

		// Update the entries to expired status
		if (expired.length > 0) {
			db.prepare(
				`UPDATE dispatch_queue SET status = 'expired', modified_at = ? WHERE ${whereClause}`,
			).run(now, ...params);
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
 * Expire all in-flight (pending|processing) client tool calls claimed by a
 * specific connection, returning the affected entries.
 *
 * Used on WS close: a connection that just died can never deliver results for
 * the calls it was handling, so they move to a terminal 'expired' state and the
 * caller synthesizes paired error tool_results + clears the resume barrier. The
 * connection scope is the right invariant here — unlike the TTL scan, which has
 * to exclude live sessions (1c0027f6) because a held call may belong to a
 * passenger still deliberating at a permission gate, a *closed* connection has
 * no one left to complete its calls regardless of TTL. Atomic SELECT + UPDATE
 * inside BEGIN IMMEDIATE to prevent TOCTOU races, matching expireClientToolCalls.
 */
export function expireClientToolCallsForConnection(
	db: Database,
	connectionId: string,
): DispatchEntry[] {
	const now = new Date().toISOString();
	const whereClause = "event_type = ? AND status IN ('pending', 'processing') AND claimed_by = ?";
	const params = [CLIENT_TOOL_CALL, connectionId];

	db.exec("BEGIN IMMEDIATE");
	try {
		const expired = db
			.prepare(`SELECT * FROM dispatch_queue WHERE ${whereClause}`)
			.all(...params) as DispatchEntry[];

		if (expired.length > 0) {
			db.prepare(
				`UPDATE dispatch_queue SET status = 'expired', modified_at = ? WHERE ${whereClause}`,
			).run(now, ...params);
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

/**
 * Acknowledge any pending/processing `tool_result` dispatch entries for one
 * `(thread_id, call_id)`.
 *
 * The normal client-tool track leaves this to the generic dispatcher: the loop
 * stops, `enqueueToolResult` queues a re-wake, and `claimPending` consumes it.
 * A NESTED loop (an aux invocation, #201) has no re-wake path — it resolves the
 * tool inline and keeps running — so nothing would ever claim the row. Left
 * pending it becomes a phantom wakeup that crash-recovery re-dispatches on the
 * next boot. The inline resolver calls this to close the entry it will never use.
 *
 * Closes the entry in BOTH stores: the legacy `dispatch_queue` twin AND, under
 * durable dispatch (the production default), the `durable_work` row
 * `enqueueToolResult` wrote. Without the durable arm the durable wakeup orphaned
 * as `pending` forever — `dispatch_message` carries a null TTL, so nothing
 * expired it — accumulating one row per inline tool call for the aux thread's
 * lifetime (#253).
 */
export function acknowledgeToolResultForCall(db: Database, threadId: string, callId: string): void {
	const now = new Date().toISOString();
	db.prepare(
		`UPDATE dispatch_queue
		 SET status = 'acknowledged', modified_at = ?
		 WHERE thread_id = ? AND event_type = ? AND event_payload = ?
		   AND status IN ('pending', 'processing')`,
	).run(now, threadId, TOOL_RESULT, JSON.stringify({ call_id: callId }));
	if (DURABLE_DISPATCH_ENQUEUE_ENABLED) {
		consumePendingDispatchByIdempotencyKey(db, `tool-result:${threadId}:${callId}`, now);
	}
}
