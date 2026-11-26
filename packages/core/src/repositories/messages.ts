import type { Database } from "bun:sqlite";
import type { Message, MessageRole } from "@bound/shared";
import { sql } from "kysely";
import { getAll, getOne, queryBuilder } from "../query-builder";

/**
 * `SELECT *` over `messages`, narrowed to the `Message` domain shape: `role` is
 * the `MessageRole` union and `deleted` is declared non-null on `Message`.
 */
function selectMessageRow() {
	return queryBuilder
		.selectFrom("messages")
		.selectAll()
		.$narrowType<{ role: MessageRole; deleted: number }>();
}

export function findMessageById(db: Database, id: string): Message | null {
	return getOne(db, selectMessageRow().where("id", "=", id));
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
		const rows = getAll(
			db,
			queryBuilder
				.selectFrom("change_log")
				.select((eb) => ["row_id", eb.fn.max("hlc").as("hlc")])
				.where("table_name", "=", "messages")
				.where("row_id", "in", chunk)
				.groupBy("row_id"),
		);
		for (const r of rows) out.set(r.row_id, r.hlc);
	}
	return out;
}

export function listMessagesByThread(db: Database, threadId: string): Message[] {
	return getAll(
		db,
		selectMessageRow()
			.where("thread_id", "=", threadId)
			.where("deleted", "=", 0)
			.orderBy("created_at", "asc"),
	);
}

export function findLiveMessageByIdAndThread(
	db: Database,
	id: string,
	threadId: string,
): Message | null {
	return getOne(
		db,
		selectMessageRow()
			.where("id", "=", id)
			.where("thread_id", "=", threadId)
			.where("deleted", "=", 0),
	);
}

export function countLiveMessagesByThread(db: Database, threadId: string): number {
	const row = getOne(
		db,
		queryBuilder
			.selectFrom("messages")
			.select((eb) => eb.fn.countAll<number>().as("count"))
			.where("thread_id", "=", threadId)
			.where("deleted", "=", 0),
	);
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
	const row = getOne(
		db,
		queryBuilder
			.selectFrom("messages")
			.select((eb) => eb.fn.countAll<number>().as("count"))
			.where("thread_id", "=", threadId)
			.where("role", "=", "tool_result")
			.where("deleted", "=", 0)
			.where(sql`json_extract(metadata, '$.background')`, "=", 1),
	);
	return row?.count ?? 0;
}

export function countLiveAssistantMessagesByThread(db: Database, threadId: string): number {
	const row = getOne(
		db,
		queryBuilder
			.selectFrom("messages")
			.select((eb) => eb.fn.countAll<number>().as("count"))
			.where("thread_id", "=", threadId)
			.where("role", "=", "assistant")
			.where("deleted", "=", 0),
	);
	return row?.count ?? 0;
}

export function countAssistantMessages(db: Database): number {
	const row = getOne(
		db,
		queryBuilder
			.selectFrom("messages")
			.select((eb) => eb.fn.countAll<number>().as("count"))
			.where("role", "=", "assistant"),
	);
	return row?.count ?? 0;
}

/** Newest N live messages for a thread, returned in chronological (ASC) order. */
export function listLiveMessagesByThreadNewestFirst(
	db: Database,
	threadId: string,
	limit: number,
): Message[] {
	return getAll(
		db,
		queryBuilder
			.selectFrom(
				selectMessageRow()
					.where("thread_id", "=", threadId)
					.where("deleted", "=", 0)
					.orderBy("created_at", "desc")
					.limit(limit)
					.as("sub"),
			)
			.selectAll()
			.orderBy("created_at", "asc"),
	);
}

export function findFirstMessageContentByThreadAndRole(
	db: Database,
	threadId: string,
	role: string,
): { content: string } | null {
	return getOne(
		db,
		queryBuilder
			.selectFrom("messages")
			.select("content")
			.where("thread_id", "=", threadId)
			.where("role", "=", role)
			.orderBy("created_at")
			.limit(1),
	);
}

export function listMessageRoleContentByThreadSince(
	db: Database,
	threadId: string,
	since: string,
): Array<{ role: string; content: string }> {
	return getAll(
		db,
		queryBuilder
			.selectFrom("messages")
			.select(["role", "content"])
			.where("thread_id", "=", threadId)
			.where("created_at", ">", since)
			.orderBy("created_at"),
	);
}

export function findLatestLiveUserMessageCreatedAtByThread(
	db: Database,
	threadId: string,
): { created_at: string } | null {
	return getOne(db, latestLiveCreatedAt(threadId).where("role", "=", "user"));
}

export function listRecentLiveMessageContentByThread(
	db: Database,
	threadId: string,
	limit: number,
): Array<{ content: string }> {
	return getAll(
		db,
		queryBuilder
			.selectFrom("messages")
			.select("content")
			.where("thread_id", "=", threadId)
			.where("deleted", "=", 0)
			.orderBy("created_at", "desc")
			.limit(limit),
	);
}

export function findLatestLiveAssistantMessageCreatedAtByThread(
	db: Database,
	threadId: string,
): { created_at: string } | null {
	return getOne(db, latestLiveCreatedAt(threadId).where("role", "=", "assistant"));
}

export function findFirstLiveUserMessageByThreadSince(
	db: Database,
	threadId: string,
	since: string,
): { id: string; content: string; role: "user" } | null {
	return getOne(
		db,
		queryBuilder
			.selectFrom("messages")
			.select(["id", "content", "role"])
			.where("thread_id", "=", threadId)
			.where("role", "=", "user")
			.where("deleted", "=", 0)
			.where("created_at", ">", since)
			.orderBy("created_at", "asc")
			.limit(1)
			.$narrowType<{ role: "user" }>(),
	);
}

export function findLatestLiveMessageCreatedAtByThread(
	db: Database,
	threadId: string,
): { created_at: string } | null {
	return getOne(db, latestLiveCreatedAt(threadId));
}

/** Newest live `created_at` on a thread; callers add a `role` filter as needed. */
function latestLiveCreatedAt(threadId: string) {
	return queryBuilder
		.selectFrom("messages")
		.select("created_at")
		.where("thread_id", "=", threadId)
		.where("deleted", "=", 0)
		.orderBy("created_at", "desc")
		.limit(1);
}

/**
 * Columns the delta/projection readers select. They omit `exit_code` and
 * `metadata` (and the projections omit `deleted`) yet are typed `Message[]`, so
 * those three readers keep a `$castTo<Message>()`.
 */
const MESSAGE_PROJECTION_COLUMNS = [
	"id",
	"thread_id",
	"role",
	"content",
	"model_id",
	"tool_name",
	"created_at",
	"modified_at",
	"host_origin",
] as const;

export function listLiveMessageDeltaByThreadSince(
	db: Database,
	threadId: string,
	since: string,
): Message[] {
	return getAll(
		db,
		queryBuilder
			.selectFrom("messages")
			.select([...MESSAGE_PROJECTION_COLUMNS, "deleted"])
			.where("thread_id", "=", threadId)
			.where("deleted", "=", 0)
			.where("created_at", ">", since)
			.orderBy("created_at", "asc")
			.orderBy(sql`rowid`, "asc")
			.$castTo<Message>(),
	);
}

export function listLiveMessageProjectionByThreadNewestFirst(
	db: Database,
	threadId: string,
	limit: number,
): Message[] {
	return getAll(
		db,
		queryBuilder
			.selectFrom("messages")
			.select(MESSAGE_PROJECTION_COLUMNS)
			.where("thread_id", "=", threadId)
			.where("deleted", "=", 0)
			.orderBy("created_at", "desc")
			.orderBy(sql`rowid`, "desc")
			.limit(limit)
			.$castTo<Message>(),
	);
}

export function listLiveMessageProjectionByThreadSince(
	db: Database,
	threadId: string,
	since: string,
): Message[] {
	return getAll(
		db,
		queryBuilder
			.selectFrom("messages")
			.select(MESSAGE_PROJECTION_COLUMNS)
			.where("thread_id", "=", threadId)
			.where("deleted", "=", 0)
			.where("created_at", ">=", since)
			.orderBy("created_at", "asc")
			.orderBy(sql`rowid`, "asc")
			.$castTo<Message>(),
	);
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
	return getOne(db, latestLiveToolResult(threadId, callId).select(["content", "exit_code"]));
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
	const row = getOne(
		db,
		queryBuilder
			.selectFrom("messages")
			.select([
				"content",
				sql<string>`json_extract(metadata, '$.background_parent.thread_id')`.as("parent_thread_id"),
				sql<string>`json_extract(metadata, '$.background_parent.call_id')`.as("parent_call_id"),
			])
			.where("thread_id", "=", threadId)
			.where("role", "=", "user")
			.where("deleted", "=", 0)
			.where(sql`json_extract(metadata, '$.background_parent.call_id')`, "is not", null)
			.orderBy("created_at", "asc")
			.limit(1),
	);
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
	return getOne(
		db,
		latestLiveToolResult(threadId, callId)
			.select("id")
			.where(sql`json_extract(metadata, '$.background')`, "=", 1),
	);
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
	const row = getOne(
		db,
		latestLiveToolResult(threadId, callId).select([
			"id",
			sql<number | null>`json_extract(metadata, '$.background_delivered')`.as("delivered"),
		]),
	);
	if (!row) return null;
	return { id: row.id, delivered: row.delivered === 1 };
}

/** Includes tombstones because sync notifications describe the row just applied. */
export function findMessageForSyncBroadcast<T>(db: Database, id: string): T | null {
	return getOne(
		db,
		queryBuilder.selectFrom("messages").selectAll().where("id", "=", id).$castTo<T>(),
	);
}

/**
 * Newest live `tool_result` row for `(thread, call_id)` — the WS layer stores a
 * client tool's `call_id` in `tool_name`. Callers choose the columns.
 */
function latestLiveToolResult(threadId: string, callId: string) {
	return queryBuilder
		.selectFrom("messages")
		.where("thread_id", "=", threadId)
		.where("role", "=", "tool_result")
		.where("tool_name", "=", callId)
		.where("deleted", "=", 0)
		.orderBy("created_at", "desc")
		.limit(1);
}
