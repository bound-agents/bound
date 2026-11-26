import type { Database } from "bun:sqlite";
import type { Thread } from "@bound/shared";
import { attachedSessionLabelsSql } from "./sql-fragments";

/**
 * One row of the threads directory listing. Extends the base `threads` row
 * (`t.*`) with derived aggregates:
 *  - `messageCount` — live messages in the thread.
 *  - `lastModel` — model_id of the most recent turn (or null).
 *  - `attachedSessionHostsJson` — JSON array string of distinct holding-host
 *    labels (host_name, falling back to site_id) for live client_sessions.
 *  - `hasRunningTask` — 1 if any live task on the thread is `running`, else 0.
 */
export interface ThreadsDirectoryRow extends Thread {
	messageCount: number;
	lastModel: string | null;
	attachedSessionHostsJson: string | null;
	hasRunningTask: number;
}

/**
 * Directory filter shared by {@link listThreadsDirectory} and
 * {@link countThreadsDirectory} so the "N threads" total always agrees with the
 * visible list. Binds `userId, includeEmpty ? 1 : 0`.
 */
const THREADS_DIRECTORY_WHERE = `WHERE t.deleted = 0 AND t.user_id = ? AND t.agent_id IS NULL
			AND (
				? = 1
				OR EXISTS(
					SELECT 1 FROM messages m
					WHERE m.thread_id = t.id AND m.role = 'user' AND m.deleted = 0
				)
			)`;

/**
 * List threads for a user, decorated with message count, last model, attached
 * client-session hosts, and a running-task flag.
 *
 *  - Filters `t.deleted = 0 AND t.user_id = ?`.
 *  - Excludes auxiliary-agent child threads (`t.agent_id IS NOT NULL`) — aux
 *    invocations are internal errands dispatched by the main agent, not user
 *    conversations, so they never appear in the web directory. Keyed on
 *    `agent_id`, never the descriptive `interface` tag.
 *  - `includeEmpty = false` additionally requires the thread to have ≥ 1 live
 *    `role = 'user'` message.
 *  - Optional `(last_message_at, id)` keyset cursor: pass both `beforeTs` and
 *    `beforeId` (non-null) to page; either being null disables the cursor.
 *  - `ORDER BY t.last_message_at DESC, t.id DESC`.
 *  - Optional `limit` (when non-null) appends `LIMIT ?`.
 */
export function listThreadsDirectory(
	db: Database,
	args: {
		userId: string;
		includeEmpty: boolean;
		beforeTs: string | null;
		beforeId: string | null;
		limit: number | null;
	},
): ThreadsDirectoryRow[] {
	const { userId, includeEmpty, beforeTs, beforeId, limit } = args;
	const hasCursor = beforeTs !== null && beforeId !== null;

	const cursorClause = hasCursor
		? "AND (t.last_message_at < ? OR (t.last_message_at = ? AND t.id < ?))"
		: "";
	const limitClause = limit !== null ? "LIMIT ?" : "";

	const sql = `
		SELECT t.*,
			(SELECT COUNT(*) FROM messages m WHERE m.thread_id = t.id AND m.deleted = 0) as messageCount,
			(SELECT tu.model_id FROM turns tu WHERE tu.thread_id = t.id ORDER BY tu.created_at DESC LIMIT 1) as lastModel,
			(
				SELECT COALESCE(json_group_array(label), '[]')
				FROM (${attachedSessionLabelsSql("t.id")})
			) as attachedSessionHostsJson,
			EXISTS(
				SELECT 1 FROM tasks
				WHERE thread_id = t.id AND status = 'running' AND deleted = 0
			) as hasRunningTask
		FROM threads t
		${THREADS_DIRECTORY_WHERE}
			${cursorClause}
		ORDER BY t.last_message_at DESC, t.id DESC
		${limitClause}
	`;

	const params: Array<string | number> = [userId, includeEmpty ? 1 : 0];
	if (hasCursor) {
		params.push(beforeTs as string, beforeTs as string, beforeId as string);
	}
	if (limit !== null) {
		params.push(limit);
	}

	return db.query(sql).all(...params) as ThreadsDirectoryRow[];
}

/** Count of threads matching {@link listThreadsDirectory}'s filter, ignoring cursor and limit. */
export function countThreadsDirectory(
	db: Database,
	args: { userId: string; includeEmpty: boolean },
): { total: number } | null {
	return db
		.query(`SELECT COUNT(*) as total FROM threads t ${THREADS_DIRECTORY_WHERE}`)
		.get(args.userId, args.includeEmpty ? 1 : 0) as { total: number } | null;
}
