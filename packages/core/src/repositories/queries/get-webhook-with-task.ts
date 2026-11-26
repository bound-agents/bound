import type { Database } from "bun:sqlite";
import { getAll, getOne, queryBuilder } from "../../query-builder";

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
function selectWebhookWithTask() {
	return queryBuilder
		.selectFrom("webhooks as w")
		.leftJoin("tasks as t", (join) => join.onRef("t.id", "=", "w.task_id").on("t.deleted", "=", 0))
		.select((eb) => [
			"w.id",
			"w.name",
			"w.signature_format",
			"w.description",
			"w.task_id",
			"w.thread_id",
			"w.created_at",
			"w.modified_at",
			"t.system_prompt_addition as prompt",
			"t.model_hint as model_hint",
			eb.case().when("t.no_history", "=", 1).then(1).else(0).end().as("no_history"),
		]);
}

export function listWebhooksWithTask(db: Database): WebhookWithTaskRow[] {
	return getAll(
		db,
		selectWebhookWithTask().where("w.deleted", "=", 0).orderBy("w.created_at", "desc"),
	);
}

export function getWebhookWithTaskById(db: Database, id: string): WebhookWithTaskRow | null {
	return getOne(db, selectWebhookWithTask().where("w.id", "=", id).where("w.deleted", "=", 0));
}

/**
 * Same projection as {@link getWebhookWithTaskById} without the `w.deleted`
 * filter: the create/update routes re-read the row they just wrote.
 */
export function findWebhookResponseById(db: Database, id: string): Record<string, unknown> | null {
	return getOne(db, selectWebhookWithTask().where("w.id", "=", id));
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
	return getAll(
		db,
		queryBuilder
			.selectFrom("webhooks as w")
			.leftJoin("tasks as t", (join) =>
				join.onRef("t.id", "=", "w.task_id").on("t.deleted", "=", 0),
			)
			.select([
				"w.name as name",
				"w.signature_format as signature_format",
				"w.description as description",
				"w.created_at as created_at",
				"t.model_hint as model_hint",
				"t.no_history as no_history",
			])
			.where("w.deleted", "=", 0)
			.orderBy("w.created_at", "desc"),
	);
}
