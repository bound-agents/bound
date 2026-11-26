import type { Database } from "bun:sqlite";

/**
 * Cross-table reads joining `webhooks` to its linked event `tasks` row. The
 * webhook's custom prompt, model hint, and `no_history` flag live on the task,
 * so list/detail responses LEFT JOIN tasks and surface them on the webhook.
 */

/**
 * Webhook row decorated with its linked task's prompt/model_hint/no_history.
 * `no_history` is the raw INTEGER (0/1) from the task row — callers coerce to
 * a boolean.
 */
export interface WebhookWithTaskRow {
	id: string;
	name: string;
	signature_format: string;
	description: string | null;
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
 * LEFT JOIN tasks so a webhook with no/soft-deleted task still returns, with
 * null prompt/model_hint and no_history coerced to 0.
 */
const WEBHOOK_WITH_TASK_SELECT = `SELECT
		w.id,
		w.name,
		w.signature_format,
		w.description,
		w.task_id,
		w.thread_id,
		w.created_at,
		w.modified_at,
		t.system_prompt_addition AS prompt,
		t.model_hint AS model_hint,
		CASE WHEN t.no_history = 1 THEN 1 ELSE 0 END AS no_history
	FROM webhooks w
	LEFT JOIN tasks t ON t.id = w.task_id AND t.deleted = 0`;

export function listWebhooksWithTask(db: Database): WebhookWithTaskRow[] {
	return db
		.prepare(`${WEBHOOK_WITH_TASK_SELECT} WHERE w.deleted = 0 ORDER BY w.created_at DESC`)
		.all() as WebhookWithTaskRow[];
}

export function getWebhookWithTaskById(db: Database, id: string): WebhookWithTaskRow | null {
	return db
		.prepare(`${WEBHOOK_WITH_TASK_SELECT} WHERE w.id = ? AND w.deleted = 0`)
		.get(id) as WebhookWithTaskRow | null;
}

/**
 * Same projection as {@link getWebhookWithTaskById} without the `w.deleted`
 * filter: the create/update routes re-read the row they just wrote.
 */
export function findWebhookResponseById(db: Database, id: string): Record<string, unknown> | null {
	return db.prepare(`${WEBHOOK_WITH_TASK_SELECT} WHERE w.id = ?`).get(id) as Record<
		string,
		unknown
	> | null;
}

/**
 * Compact webhook-list projection: raw INTEGER `no_history` from the task row,
 * nullable when no task is linked.
 */
export interface WebhookListItemRow {
	name: string;
	signature_format: string;
	description: string | null;
	created_at: string;
	model_hint: string | null;
	no_history: number | null;
}

export function listWebhooksForCli(db: Database): WebhookListItemRow[] {
	return db
		.prepare(
			`SELECT w.name AS name,
			        w.signature_format AS signature_format,
			        w.description AS description,
			        w.created_at AS created_at,
			        t.model_hint AS model_hint,
			        t.no_history AS no_history
			 FROM webhooks w
			 LEFT JOIN tasks t ON t.id = w.task_id AND t.deleted = 0
			 WHERE w.deleted = 0
			 ORDER BY w.created_at DESC`,
		)
		.all() as WebhookListItemRow[];
}
