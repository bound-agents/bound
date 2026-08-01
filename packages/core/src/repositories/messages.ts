import type { Database } from "bun:sqlite";
import type { Message } from "@bound/shared";

/** Read repository for the `messages` table. See ./index.ts for conventions. */

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

/** `SELECT * FROM messages WHERE id = ? AND thread_id = ? AND deleted = 0` — live only. */
export function findLiveMessageByIdAndThread(
	db: Database,
	id: string,
	threadId: string,
): Message | null {
	return db
		.query("SELECT * FROM messages WHERE id = ? AND thread_id = ? AND deleted = 0")
		.get(id, threadId) as Message | null;
}

/** `SELECT role FROM messages WHERE id = ?` — ignores deleted flag. */
export function findMessageRoleById(db: Database, id: string): { role: string } | null {
	return db.query("SELECT role FROM messages WHERE id = ?").get(id) as { role: string } | null;
}

/** `SELECT metadata FROM messages WHERE id = ?` — ignores deleted flag. */
export function findMessageMetadataById(
	db: Database,
	id: string,
): { metadata: string | null } | null {
	return db.query("SELECT metadata FROM messages WHERE id = ?").get(id) as {
		metadata: string | null;
	} | null;
}

/** `SELECT COUNT(*) FROM messages WHERE thread_id = ? AND deleted = 0` — live count. */
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

/** `SELECT COUNT(*) FROM messages WHERE thread_id = ?` — count including soft-deleted rows. */
export function countMessagesByThread(db: Database, threadId: string): number {
	const row = db
		.query("SELECT COUNT(*) as count FROM messages WHERE thread_id = ?")
		.get(threadId) as { count: number } | null;
	return row?.count ?? 0;
}

/**
 * `SELECT COUNT(*) FROM messages WHERE thread_id = ? AND role = 'assistant' AND
 * deleted = 0` — live assistant-turn count for a thread.
 */
export function countLiveAssistantMessagesByThread(db: Database, threadId: string): number {
	const row = db
		.query(
			"SELECT COUNT(*) as count FROM messages WHERE thread_id = ? AND role = 'assistant' AND deleted = 0",
		)
		.get(threadId) as { count: number } | null;
	return row?.count ?? 0;
}

/**
 * `SELECT COUNT(*) FROM messages WHERE role = 'assistant'` — assistant-message
 * count across all threads, ignoring the deleted flag. Used by the agent harness.
 */
export function countAssistantMessages(db: Database): number {
	const row = db.query("SELECT COUNT(*) as count FROM messages WHERE role = 'assistant'").get() as {
		count: number;
	} | null;
	return row?.count ?? 0;
}

/**
 * Newest N live messages for a thread, returned in chronological (ASC) order.
 * `SELECT * FROM (SELECT * ... ORDER BY created_at DESC LIMIT ?) ORDER BY created_at ASC`.
 */
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

/**
 * `SELECT content FROM messages WHERE thread_id = ? AND role = ? ORDER BY
 * created_at LIMIT 1` — content of the first message of a given role, ignoring
 * the deleted flag. Used by title generation.
 */
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

/**
 * `SELECT content FROM messages WHERE thread_id = ? AND role = 'tool_call' AND
 * deleted = 0 ORDER BY created_at ASC, rowid ASC` — content of every live
 * tool_call message in a thread, oldest first.
 */
export function listLiveToolCallContentByThread(
	db: Database,
	threadId: string,
): Array<{ content: string }> {
	return db
		.query(
			"SELECT content FROM messages WHERE thread_id = ? AND role = 'tool_call' AND deleted = 0 ORDER BY created_at ASC, rowid ASC",
		)
		.all(threadId) as Array<{ content: string }>;
}

/**
 * `SELECT role, content FROM messages WHERE thread_id = ? AND created_at > ?
 * ORDER BY created_at` — role+content of messages after a cutoff, ignoring the
 * deleted flag. Used by summary delta extraction.
 */
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

/**
 * `SELECT created_at FROM messages WHERE thread_id = ? AND role = 'user' AND
 * deleted = 0 ORDER BY created_at DESC LIMIT 1` — timestamp of the latest live
 * user message in a thread.
 */
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

/**
 * `SELECT tool_name, COUNT(*) ... GROUP BY tool_name ORDER BY MAX(created_at)
 * DESC LIMIT ?` — tool-call counts for a thread, most-recently-used first.
 * Ignores the deleted flag.
 */
export function listToolNameCountsByThread(
	db: Database,
	threadId: string,
	limit: number,
): Array<{ tool_name: string; count: number }> {
	return db
		.query(
			`SELECT tool_name, COUNT(*) as count
			 FROM messages
			 WHERE thread_id = ? AND tool_name IS NOT NULL
			 GROUP BY tool_name
			 ORDER BY MAX(created_at) DESC
			 LIMIT ?`,
		)
		.all(threadId, limit) as Array<{ tool_name: string; count: number }>;
}

/**
 * `SELECT content FROM messages WHERE thread_id = ? AND deleted = 0 ORDER BY
 * created_at DESC LIMIT ?` — content of the most recent N live messages,
 * newest first.
 */
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

/**
 * `SELECT id FROM messages WHERE thread_id = ? ORDER BY created_at DESC LIMIT ?`
 * — ids of the newest N messages in a thread, ignoring the deleted flag.
 */
export function listMessageIdsByThreadNewestFirst(
	db: Database,
	threadId: string,
	limit: number,
): Array<{ id: string }> {
	return db
		.query("SELECT id FROM messages WHERE thread_id = ? ORDER BY created_at DESC LIMIT ?")
		.all(threadId, limit) as Array<{ id: string }>;
}

/**
 * `SELECT id, role FROM messages WHERE id IN (...)` — id+role for a set of
 * message ids, ignoring the deleted flag. The id list is bound as parameters.
 */
export function listMessageIdRoleByIds(
	db: Database,
	ids: readonly string[],
): Array<{ id: string; role: string }> {
	if (ids.length === 0) return [];
	const placeholders = ids.map(() => "?").join(", ");
	return db
		.query(`SELECT id, role FROM messages WHERE id IN (${placeholders})`)
		.all(...ids) as Array<{ id: string; role: string }>;
}

/**
 * `SELECT id FROM messages WHERE thread_id = (SELECT thread_id FROM messages
 * WHERE id = ?) AND role = 'tool_result' AND created_at > (SELECT created_at
 * FROM messages WHERE id = ?) ORDER BY created_at ASC LIMIT 1` — the
 * tool_result that immediately follows the given tool_call message in its thread.
 */
export function findPairedToolResultId(db: Database, toolCallId: string): { id: string } | null {
	return db
		.query(
			`SELECT id FROM messages
			 WHERE thread_id = (SELECT thread_id FROM messages WHERE id = ?)
			   AND role = 'tool_result'
			   AND created_at > (SELECT created_at FROM messages WHERE id = ?)
			 ORDER BY created_at ASC LIMIT 1`,
		)
		.get(toolCallId, toolCallId) as { id: string } | null;
}

/**
 * `SELECT DISTINCT tool_name FROM messages WHERE thread_id = ? AND role = 'tool'
 * AND tool_name IS NOT NULL LIMIT 50` — distinct tool names used in a thread.
 */
export function listDistinctToolNamesByThread(
	db: Database,
	threadId: string,
): Array<{ tool_name: string }> {
	return db
		.query(
			`SELECT DISTINCT tool_name
			 FROM messages
			 WHERE thread_id = ? AND role = 'tool' AND tool_name IS NOT NULL
			 LIMIT 50`,
		)
		.all(threadId) as Array<{ tool_name: string }>;
}

/**
 * `SELECT id, content, metadata FROM messages WHERE thread_id = ? AND role =
 * 'assistant' AND metadata IS NOT NULL AND created_at >= ? AND deleted = 0` —
 * live assistant messages carrying metadata since a cutoff.
 */
export function listLiveAssistantMessagesWithMetadataByThreadSince(
	db: Database,
	threadId: string,
	since: string,
): Array<{ id: string; content: string; metadata: string }> {
	return db
		.query(
			"SELECT id, content, metadata FROM messages WHERE thread_id = ? AND role = 'assistant' AND metadata IS NOT NULL AND created_at >= ? AND deleted = 0",
		)
		.all(threadId, since) as Array<{ id: string; content: string; metadata: string }>;
}

/**
 * `SELECT id, metadata FROM messages WHERE thread_id = ? AND role = 'developer'
 * AND created_at >= ? AND metadata IS NOT NULL AND deleted = 0` — live developer
 * messages carrying metadata since a cutoff.
 */
export function listLiveDeveloperMessageMetadataByThreadSince(
	db: Database,
	threadId: string,
	since: string,
): Array<{ id: string; metadata: string }> {
	return db
		.query(
			"SELECT id, metadata FROM messages WHERE thread_id = ? AND role = 'developer' AND created_at >= ? AND metadata IS NOT NULL AND deleted = 0",
		)
		.all(threadId, since) as Array<{ id: string; metadata: string }>;
}

/**
 * `SELECT id FROM messages WHERE thread_id = ? AND role = 'assistant' AND
 * created_at >= ? AND deleted = 0 ORDER BY created_at DESC LIMIT 1` — id of the
 * latest live assistant message since a cutoff.
 */
export function findLatestLiveAssistantMessageIdByThreadSince(
	db: Database,
	threadId: string,
	since: string,
): { id: string } | null {
	return db
		.query(
			"SELECT id FROM messages WHERE thread_id = ? AND role = 'assistant' AND created_at >= ? AND deleted = 0 ORDER BY created_at DESC LIMIT 1",
		)
		.get(threadId, since) as { id: string } | null;
}

/**
 * `SELECT host_origin, COUNT(*) as count, MAX(created_at) as latest FROM
 * messages WHERE created_at > ? AND host_origin IS NOT NULL AND host_origin !=
 * '' GROUP BY host_origin` — per-host message counts since a cutoff. Ignores
 * the deleted flag and is not scoped to a thread.
 */
export function listMessageHostOriginCountsSince(
	db: Database,
	since: string,
): Array<{ host_origin: string; count: number; latest: string }> {
	return db
		.query(
			`SELECT host_origin,
					COUNT(*) as count,
					MAX(created_at) as latest
				 FROM messages
				 WHERE created_at > ?
					AND host_origin IS NOT NULL
					AND host_origin != ''
				 GROUP BY host_origin`,
		)
		.all(since) as Array<{ host_origin: string; count: number; latest: string }>;
}

/**
 * `SELECT created_at FROM messages WHERE thread_id = ? AND role = 'assistant'
 * AND deleted = 0 ORDER BY created_at DESC LIMIT 1` — timestamp of the latest
 * live assistant message in a thread.
 */
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

/**
 * `SELECT id, content, role FROM messages WHERE thread_id = ? AND role = 'user'
 * AND deleted = 0 AND created_at > ? ORDER BY created_at ASC LIMIT 1` — the
 * earliest live user message after a cutoff timestamp.
 */
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

/**
 * `SELECT created_at FROM messages WHERE thread_id = ? AND deleted = 0 ORDER BY
 * created_at DESC LIMIT 1` — timestamp of the latest live message in a thread
 * (any role).
 */
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

/**
 * `SELECT id, thread_id, role, content, model_id, tool_name, created_at,
 * modified_at, host_origin, deleted FROM messages WHERE thread_id = ? AND
 * deleted = 0 AND created_at > ? ORDER BY created_at ASC, rowid ASC` — live
 * message delta after a cutoff (warm-path delta fetch). Includes the `deleted`
 * column projection.
 */
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

/**
 * `SELECT id, thread_id, role, content, model_id, tool_name, created_at,
 * modified_at, host_origin FROM messages WHERE thread_id = ? AND deleted = 0
 * ORDER BY created_at DESC, rowid DESC LIMIT ?` — newest-first projection of
 * live messages used by context-assembly Stage 1. Caller reverses to ASC.
 */
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

/**
 * `SELECT id, thread_id, role, content, model_id, tool_name, created_at,
 * modified_at, host_origin FROM messages WHERE thread_id = ? AND deleted = 0
 * AND created_at >= ? ORDER BY created_at ASC, rowid ASC` — live message
 * projection since a cutoff (context-assembly noHistory-task setup).
 */
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
 * `SELECT content FROM messages WHERE role = 'assistant' ORDER BY created_at
 * DESC, rowid DESC LIMIT 1` — content of the most recent assistant message
 * across all threads, ignoring the deleted flag. Used by the agent harness.
 */
export function findLatestAssistantMessageContent(db: Database): { content: string } | null {
	return db
		.query(
			"SELECT content FROM messages WHERE role = 'assistant' ORDER BY created_at DESC, rowid DESC LIMIT 1",
		)
		.get() as { content: string } | null;
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
