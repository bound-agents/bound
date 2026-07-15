import type { Database } from "bun:sqlite";

/**
 * Cross-table reads joining `rss_feeds` to the linked event `tasks` row.
 * Mirrors ./get-webhook-with-task.ts: the feed's custom prompt, model hint,
 * and `no_history` flag live on the task, so list/detail responses LEFT JOIN
 * tasks and surface them on the feed row.
 *
 * Shared by `packages/web/src/server/routes/rss.ts`. Reads only.
 */

/**
 * Feed row decorated with its linked task's prompt/model_hint/no_history.
 * `no_history` is the raw INTEGER (0/1) from the task row — callers coerce to
 * a boolean.
 */
export interface RssFeedWithTaskRow {
	id: string;
	name: string;
	url: string;
	description: string | null;
	poll_interval_seconds: number;
	task_id: string | null;
	thread_id: string | null;
	created_at: string;
	modified_at: string;
	/** task.system_prompt_addition (null when no task or unset). */
	prompt: string | null;
	/** task.model_hint (null when no task or unset). */
	model_hint: string | null;
	/** 1 when the linked task has no_history = 1, else 0. */
	no_history: number;
}

/**
 * The shared SELECT projection. LEFT JOIN tasks so a feed with a soft-deleted
 * task still returns, with null prompt/model_hint and no_history coerced to 0.
 * `seen_guids` is deliberately not projected — it's poller-internal dedup
 * state, not part of the API response shape.
 */
const RSS_FEED_WITH_TASK_SELECT = `SELECT
		r.id,
		r.name,
		r.url,
		r.description,
		r.poll_interval_seconds,
		r.task_id,
		r.thread_id,
		r.created_at,
		r.modified_at,
		t.system_prompt_addition AS prompt,
		t.model_hint AS model_hint,
		CASE WHEN t.no_history = 1 THEN 1 ELSE 0 END AS no_history
	FROM rss_feeds r
	LEFT JOIN tasks t ON t.id = r.task_id AND t.deleted = 0`;

/** List all live feeds with their linked task fields, ordered `r.created_at DESC`. */
export function listRssFeedsWithTask(db: Database): RssFeedWithTaskRow[] {
	return db
		.prepare(`${RSS_FEED_WITH_TASK_SELECT} WHERE r.deleted = 0 ORDER BY r.created_at DESC`)
		.all() as RssFeedWithTaskRow[];
}

/** Fetch a single live feed by id with its linked task fields, or null. */
export function getRssFeedWithTaskById(db: Database, id: string): RssFeedWithTaskRow | null {
	return db
		.prepare(`${RSS_FEED_WITH_TASK_SELECT} WHERE r.id = ? AND r.deleted = 0`)
		.get(id) as RssFeedWithTaskRow | null;
}
