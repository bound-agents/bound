import type { Database } from "bun:sqlite";
import type { Message } from "@bound/shared";

export function findMessageById(db: Database, id: string): Message | null {
	return db.query("SELECT * FROM messages WHERE id = ?").get(id) as Message | null;
}

/**
 * Map each given message row id to the HIGHEST `change_log` HLC recorded for it
 * (its latest write — insert or edit). Rows with no change_log entry (e.g. a
 * locally-originated row whose changelog batch hasn't flushed, or a non-synced
 * test row) are absent from the map. Used by the delegation segmenter to decide
 * which rows are confirmed-synced to a consumer: a row is range-coverable only
 * if its latest HLC is <= the consumer's confirmed watermark (R-UD6). Reading
 * `change_log` here keeps this single cross-table read in the repository layer
 * rather than inlined in feature code.
 */
export function getLatestChangeLogHlcForRows(
	db: Database,
	rowIds: readonly string[],
): Map<string, string> {
	const out = new Map<string, string>();
	if (rowIds.length === 0) return out;
	// Chunk to stay well under SQLite's parameter limit for very long threads.
	const CHUNK = 500;
	for (let i = 0; i < rowIds.length; i += CHUNK) {
		const chunk = rowIds.slice(i, i + CHUNK);
		const placeholders = chunk.map(() => "?").join(", ");
		const rows = db
			.query(
				`SELECT row_id, MAX(hlc) AS hlc FROM change_log
				WHERE table_name = 'messages' AND row_id IN (${placeholders})
				GROUP BY row_id`,
			)
			.all(...chunk) as Array<{ row_id: string; hlc: string }>;
		for (const r of rows) out.set(r.row_id, r.hlc);
	}
	return out;
}

export function listMessagesByThread(db: Database, threadId: string): Message[] {
	return db
		.query("SELECT * FROM messages WHERE thread_id = ? AND deleted = 0 ORDER BY created_at ASC")
		.all(threadId) as Message[];
}

export function findLiveMessageByIdAndThread(
	db: Database,
	id: string,
	threadId: string,
): Message | null {
	return db
		.query("SELECT * FROM messages WHERE id = ? AND thread_id = ? AND deleted = 0")
		.get(id, threadId) as Message | null;
}

export function countLiveMessagesByThread(db: Database, threadId: string): number {
	const row = db
		.query("SELECT COUNT(*) as count FROM messages WHERE thread_id = ? AND deleted = 0")
		.get(threadId) as { count: number } | null;
	return row?.count ?? 0;
}

/**
 * Count live background (deferred, #76) tool calls in flight on a thread.
 *
 * A deferred tool's placeholder `tool_result` carries `metadata.background =
 * true`; `resolveDeferredToolResult` strips the key when the real result lands.
 * So the count of rows still carrying it IS the in-flight count — derived from
 * state, never tallied, which is what lets a reconnecting client resync instead
 * of drifting.
 */
export function countBackgroundToolCallsByThread(db: Database, threadId: string): number {
	const row = db
		.query(
			`SELECT COUNT(*) as count FROM messages
			 WHERE thread_id = ? AND role = 'tool_result' AND deleted = 0
			   AND json_extract(metadata, '$.background') = 1`,
		)
		.get(threadId) as { count: number } | null;
	return row?.count ?? 0;
}

export function countLiveAssistantMessagesByThread(db: Database, threadId: string): number {
	const row = db
		.query(
			"SELECT COUNT(*) as count FROM messages WHERE thread_id = ? AND role = 'assistant' AND deleted = 0",
		)
		.get(threadId) as { count: number } | null;
	return row?.count ?? 0;
}

export function countAssistantMessages(db: Database): number {
	const row = db.query("SELECT COUNT(*) as count FROM messages WHERE role = 'assistant'").get() as {
		count: number;
	} | null;
	return row?.count ?? 0;
}

/** Newest N live messages for a thread, returned in chronological (ASC) order. */
export function listLiveMessagesByThreadNewestFirst(
	db: Database,
	threadId: string,
	limit: number,
): Message[] {
	return db
		.query(
			`SELECT * FROM (
				SELECT * FROM messages
				WHERE thread_id = ? AND deleted = 0
				ORDER BY created_at DESC
				LIMIT ?
			) sub ORDER BY created_at ASC`,
		)
		.all(threadId, limit) as Message[];
}

export function findFirstMessageContentByThreadAndRole(
	db: Database,
	threadId: string,
	role: string,
): { content: string } | null {
	return db
		.query(
			"SELECT content FROM messages WHERE thread_id = ? AND role = ? ORDER BY created_at LIMIT 1",
		)
		.get(threadId, role) as { content: string } | null;
}

export function listMessageRoleContentByThreadSince(
	db: Database,
	threadId: string,
	since: string,
): Array<{ role: string; content: string }> {
	return db
		.query(
			"SELECT role, content FROM messages WHERE thread_id = ? AND created_at > ? ORDER BY created_at",
		)
		.all(threadId, since) as Array<{ role: string; content: string }>;
}

export function findLatestLiveUserMessageCreatedAtByThread(
	db: Database,
	threadId: string,
): { created_at: string } | null {
	return db
		.query(
			"SELECT created_at FROM messages WHERE thread_id = ? AND role = 'user' AND deleted = 0 ORDER BY created_at DESC LIMIT 1",
		)
		.get(threadId) as { created_at: string } | null;
}

export function listRecentLiveMessageContentByThread(
	db: Database,
	threadId: string,
	limit: number,
): Array<{ content: string }> {
	return db
		.query(
			`SELECT content FROM messages
			 WHERE thread_id = ? AND deleted = 0
			 ORDER BY created_at DESC LIMIT ?`,
		)
		.all(threadId, limit) as Array<{ content: string }>;
}

export function findLatestLiveAssistantMessageCreatedAtByThread(
	db: Database,
	threadId: string,
): { created_at: string } | null {
	return db
		.query(
			"SELECT created_at FROM messages WHERE thread_id = ? AND role = 'assistant' AND deleted = 0 ORDER BY created_at DESC LIMIT 1",
		)
		.get(threadId) as { created_at: string } | null;
}

export function findFirstLiveUserMessageByThreadSince(
	db: Database,
	threadId: string,
	since: string,
): { id: string; content: string; role: "user" } | null {
	return db
		.query(
			"SELECT id, content, role FROM messages WHERE thread_id = ? AND role = 'user' AND deleted = 0 AND created_at > ? ORDER BY created_at ASC LIMIT 1",
		)
		.get(threadId, since) as { id: string; content: string; role: "user" } | null;
}

export function findLatestLiveMessageCreatedAtByThread(
	db: Database,
	threadId: string,
): { created_at: string } | null {
	return db
		.query(
			"SELECT created_at FROM messages WHERE thread_id = ? AND deleted = 0 ORDER BY created_at DESC LIMIT 1",
		)
		.get(threadId) as { created_at: string } | null;
}

export function listLiveMessageDeltaByThreadSince(
	db: Database,
	threadId: string,
	since: string,
): Message[] {
	return db
		.query(
			"SELECT id, thread_id, role, content, model_id, tool_name, created_at, modified_at, host_origin, deleted FROM messages WHERE thread_id = ? AND deleted = 0 AND created_at > ? ORDER BY created_at ASC, rowid ASC",
		)
		.all(threadId, since) as Message[];
}

export function listLiveMessageProjectionByThreadNewestFirst(
	db: Database,
	threadId: string,
	limit: number,
): Message[] {
	return db
		.query(
			"SELECT id, thread_id, role, content, model_id, tool_name, created_at, modified_at, host_origin FROM messages WHERE thread_id = ? AND deleted = 0 ORDER BY created_at DESC, rowid DESC LIMIT ?",
		)
		.all(threadId, limit) as Message[];
}

export function listLiveMessageProjectionByThreadSince(
	db: Database,
	threadId: string,
	since: string,
): Message[] {
	return db
		.query(
			"SELECT id, thread_id, role, content, model_id, tool_name, created_at, modified_at, host_origin FROM messages WHERE thread_id = ? AND deleted = 0 AND created_at >= ? ORDER BY created_at ASC, rowid ASC",
		)
		.all(threadId, since) as Message[];
}

/**
 * Read a client tool's persisted result for one `(thread_id, call_id)`.
 *
 * The WS layer persists a client tool result as a `tool_result` row with
 * `tool_name = call_id` (host-parity with the native dispatch return), so this
 * is the durable handoff a caller polls when it dispatched a client tool and
 * needs the answer inline rather than via a loop re-wake. Newest row wins:
 * `call_id`s are only unique within a turn, not across a thread's lifetime.
 */
export function findToolResultByThreadAndCallId(
	db: Database,
	threadId: string,
	callId: string,
): { content: string; exit_code: number | null } | null {
	return db
		.query(
			`SELECT content, exit_code FROM messages
			 WHERE thread_id = ? AND role = 'tool_result' AND tool_name = ? AND deleted = 0
			 ORDER BY created_at DESC LIMIT 1`,
		)
		.get(threadId, callId) as { content: string; exit_code: number | null } | null;
}

/**
 * #76: durable correlation for a dispatcher-owned background aux invocation.
 *
 * A background `aux.invoke` stamps `metadata.background_parent` (parent thread
 * id + placeholder call_id) on the child thread's seed message. Server dispatch
 * reads it back to decide ownership: a seed WITH the correlation marks the
 * thread as dispatcher-owned (run an AuxAgentLoop, resolve the parent's
 * placeholder on completion); a seed without it belongs to a foreground nested
 * loop and must never be claimed by the dispatcher.
 */
export function findBackgroundAuxSeed(
	db: Database,
	threadId: string,
): { parentThreadId: string; parentCallId: string; instructions: string } | null {
	const row = db
		.query(
			`SELECT content,
				json_extract(metadata, '$.background_parent.thread_id') AS parent_thread_id,
				json_extract(metadata, '$.background_parent.call_id') AS parent_call_id
			 FROM messages
			 WHERE thread_id = ? AND role = 'user' AND deleted = 0
				AND json_extract(metadata, '$.background_parent.call_id') IS NOT NULL
			 ORDER BY created_at ASC LIMIT 1`,
		)
		.get(threadId) as {
		content: string;
		parent_thread_id: string;
		parent_call_id: string;
	} | null;
	if (!row) return null;
	return {
		parentThreadId: row.parent_thread_id,
		parentCallId: row.parent_call_id,
		instructions: row.content,
	};
}

/**
 * #76: the placeholder row for (thread, call_id) IF it still carries the
 * `background` metadata marker — i.e. the deferred call is still unresolved.
 * `resolveDeferredToolResult` drops the marker on resolution, so this guards a
 * completed aux thread's spurious re-wake from clobbering a delivered result.
 */
export function findUnresolvedBackgroundPlaceholder(
	db: Database,
	threadId: string,
	callId: string,
): { id: string } | null {
	return db
		.query(
			`SELECT id FROM messages
			 WHERE thread_id = ? AND role = 'tool_result' AND tool_name = ? AND deleted = 0
				AND json_extract(metadata, '$.background') = 1
			 ORDER BY created_at DESC LIMIT 1`,
		)
		.get(threadId, callId) as { id: string } | null;
}

/**
 * #220: delivery state of the newest background placeholder for (thread, call_id).
 *
 * `resolveDeferredToolResult` stamps `background_delivered` when it lands the
 * real result on the placeholder, so delivery is provable from the row itself.
 * The dispatcher's clobber guard keys on THIS marker — not on the in-flight
 * `background` marker — because the in-flight stamp has been observed missing
 * (#220 defect 1), and requiring it inverted the guard into dropping the only
 * delivery. Legacy placeholders resolved before the marker existed read as
 * undelivered; the fail-safe direction is to deliver.
 */
export function findBackgroundPlaceholderDeliveryState(
	db: Database,
	threadId: string,
	callId: string,
): { id: string; delivered: boolean } | null {
	const row = db
		.query(
			`SELECT id, json_extract(metadata, '$.background_delivered') AS delivered
			 FROM messages
			 WHERE thread_id = ? AND role = 'tool_result' AND tool_name = ? AND deleted = 0
			 ORDER BY created_at DESC LIMIT 1`,
		)
		.get(threadId, callId) as { id: string; delivered: number | null } | null;
	if (!row) return null;
	return { id: row.id, delivered: row.delivered === 1 };
}

/** Includes tombstones because sync notifications describe the row just applied. */
export function findMessageForSyncBroadcast<T>(db: Database, id: string): T | null {
	return db.query("SELECT * FROM messages WHERE id = ?").get(id) as T | null;
}
