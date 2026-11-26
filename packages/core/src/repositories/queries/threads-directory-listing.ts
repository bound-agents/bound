import type { Database } from "bun:sqlite";
import type { Thread } from "@bound/shared";
import { type ExpressionBuilder, sql } from "kysely";
import type { BoundDatabase } from "../../db-types";
import { getAll, getOne, queryBuilder } from "../../query-builder";
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

type ThreadsAliased = BoundDatabase & { t: BoundDatabase["threads"] };

/**
 * Directory filter shared by {@link listThreadsDirectory} and
 * {@link countThreadsDirectory} so the "N threads" total always agrees with the
 * visible list.
 */
function threadsDirectoryFilter(userId: string, includeEmpty: boolean) {
	return (eb: ExpressionBuilder<ThreadsAliased, "t">) =>
		eb.and([
			eb("t.deleted", "=", 0),
			eb("t.user_id", "=", userId),
			eb("t.agent_id", "is", null),
			eb.or([
				eb(eb.val(includeEmpty ? 1 : 0), "=", 1),
				eb.exists(
					eb
						.selectFrom("messages as m")
						.select(eb.lit(1).as("one"))
						.whereRef("m.thread_id", "=", "t.id")
						.where("m.role", "=", "user")
						.where("m.deleted", "=", 0),
				),
			]),
		]);
}

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

	const query = queryBuilder
		.selectFrom("threads as t")
		.selectAll("t")
		.select((eb) => [
			eb
				.selectFrom("messages as m")
				.select(eb.fn.countAll<number>().as("n"))
				.whereRef("m.thread_id", "=", "t.id")
				.where("m.deleted", "=", 0)
				.$asScalar()
				.$notNull()
				.as("messageCount"),
			eb
				.selectFrom("turns as tu")
				.select("tu.model_id")
				.whereRef("tu.thread_id", "=", "t.id")
				.orderBy("tu.created_at", "desc")
				.limit(1)
				.$asScalar()
				.as("lastModel"),
			sql<string | null>`(
				SELECT COALESCE(json_group_array(label), '[]')
				FROM (${sql.raw(attachedSessionLabelsSql("t.id"))})
			)`.as("attachedSessionHostsJson"),
			eb
				.exists(
					eb
						.selectFrom("tasks")
						.select(eb.lit(1).as("one"))
						.whereRef("tasks.thread_id", "=", "t.id")
						.where("tasks.status", "=", "running")
						.where("tasks.deleted", "=", 0),
				)
				.$castTo<number>()
				.as("hasRunningTask"),
		])
		.where(threadsDirectoryFilter(userId, includeEmpty))
		.$if(beforeTs !== null && beforeId !== null, (qb) =>
			qb.where((eb) =>
				eb.or([
					eb("t.last_message_at", "<", beforeTs as string),
					eb.and([
						eb("t.last_message_at", "=", beforeTs as string),
						eb("t.id", "<", beforeId as string),
					]),
				]),
			),
		)
		.orderBy("t.last_message_at", "desc")
		.orderBy("t.id", "desc")
		.$if(limit !== null, (qb) => qb.limit(limit as number))
		.$narrowType<{ color: number; deleted: number }>();

	return getAll(db, query);
}

/** Count of threads matching {@link listThreadsDirectory}'s filter, ignoring cursor and limit. */
export function countThreadsDirectory(
	db: Database,
	args: { userId: string; includeEmpty: boolean },
): { total: number } | null {
	return getOne(
		db,
		queryBuilder
			.selectFrom("threads as t")
			.select((eb) => eb.fn.countAll<number>().as("total"))
			.where(threadsDirectoryFilter(args.userId, args.includeEmpty)),
	);
}
