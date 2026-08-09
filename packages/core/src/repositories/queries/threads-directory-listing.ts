import type { Database } from "bun:sqlite";
import type { Thread } from "@bound/shared";

/**
 * Cross-table read queries powering the web threads directory
 * (`packages/web/src/server/routes/threads.ts`).
 *
 * These JOIN/aggregate across `threads`, `messages`, `turns`, `client_sessions`,
 * and `hosts`, so they cannot live in a single per-table module. See ../index.ts
 * for conventions. Reads only; bun:sqlite `.get()` returns `null` on empty reads.
 */

/**
 * One row of the threads directory listing. Extends the base `threads` row
 * (`t.*`) with derived aggregates:
 *  - `messageCount` — live messages in the thread.
 *  - `lastModel` — model_id of the most recent turn (or null).
 *  - `attachedSessionHostsJson` — JSON array string of distinct holding-host
 *    labels (host_name, falling back to site_id) for live client_sessions.
 *  - `hasRunningTask` — 1 if any live task on the thread is `running`, else 0.
 *
 * Field names mirror exactly what the route destructures.
 */
export interface ThreadsDirectoryRow extends Thread {
	messageCount: number;
	lastModel: string | null;
	attachedSessionHostsJson: string | null;
	hasRunningTask: number;
}

/**
 * List threads for a user, decorated with message count, last model, attached
 * client-session hosts, and a running-task flag.
 *
 * Semantics preserved exactly from the route:
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
 *
 * The conditional cursor/limit SQL is built inside the finder, toggled by the
 * presence of the cursor pair and a non-null limit, so callers pay nothing for
 * branches they don't use.
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
				FROM (
					SELECT COALESCE(h.host_name, cs.site_id) as label
					FROM client_sessions cs
					LEFT JOIN hosts h ON h.site_id = cs.site_id AND h.deleted = 0
					WHERE cs.thread_id = t.id AND cs.deleted = 0
					GROUP BY cs.site_id, label
					ORDER BY label ASC
				)
			) as attachedSessionHostsJson,
			EXISTS(
				SELECT 1 FROM tasks
				WHERE thread_id = t.id AND status = 'running' AND deleted = 0
			) as hasRunningTask
		FROM threads t
		WHERE t.deleted = 0 AND t.user_id = ? AND t.agent_id IS NULL
			AND (
				? = 1
				OR EXISTS(
					SELECT 1 FROM messages m
					WHERE m.thread_id = t.id AND m.role = 'user' AND m.deleted = 0
				)
			)
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

/**
 * Total count of threads matching the same filter as {@link listThreadsDirectory},
 * independent of the cursor/limit window — including the aux-thread exclusion
 * (`agent_id IS NULL`), so the directory's "N threads" total always agrees with
 * the visible list. Drives the `X-Total-Count` header.
 *
 * Returns `null` only if the aggregate yields no row (never, in practice — a
 * COUNT(*) always returns one row).
 */
export function countThreadsDirectory(
	db: Database,
	args: { userId: string; includeEmpty: boolean },
): { total: number } | null {
	return db
		.query(`
			SELECT COUNT(*) as total
			FROM threads t
			WHERE t.deleted = 0 AND t.user_id = ? AND t.agent_id IS NULL
				AND (
					? = 1
					OR EXISTS(
						SELECT 1 FROM messages m
						WHERE m.thread_id = t.id AND m.role = 'user' AND m.deleted = 0
					)
				)
		`)
		.get(args.userId, args.includeEmpty ? 1 : 0) as { total: number } | null;
}
