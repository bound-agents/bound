import type { Database } from "bun:sqlite";
import type { Webhook } from "@bound/shared";
import { getOne, queryBuilder } from "../query-builder";

/** Live (`deleted = 0`) webhook rows. */
function liveWebhooks() {
	return queryBuilder.selectFrom("webhooks").where("deleted", "=", 0);
}

export function findWebhookByName(db: Database, name: string): Webhook | null {
	return getOne(db, liveWebhooks().selectAll().$castTo<Webhook>().where("name", "=", name));
}

export function findWebhookIdByName(db: Database, name: string): { id: string } | null {
	return getOne(db, liveWebhooks().select("id").where("name", "=", name));
}

/** Like {@link findWebhookIdByName} but also returns the backing event task's id, for callers that need to touch both rows (e.g. deregistering a webhook and its task together). */
export function findWebhookIdAndTaskIdByName(
	db: Database,
	name: string,
): { id: string; task_id: string } | null {
	return getOne(db, liveWebhooks().select(["id", "task_id"]).where("name", "=", name));
}

export function findWebhookIdsByName(
	db: Database,
	name: string,
): { id: string; task_id: string; thread_id: string } | null {
	return getOne(db, liveWebhooks().select(["id", "task_id", "thread_id"]).where("name", "=", name));
}

export function findWebhookIdsById(
	db: Database,
	id: string,
): { id: string; task_id: string; thread_id: string } | null {
	return getOne(db, liveWebhooks().select(["id", "task_id", "thread_id"]).where("id", "=", id));
}

export function findWebhookIdById(db: Database, id: string): { id: string } | null {
	return getOne(db, liveWebhooks().select("id").where("id", "=", id));
}

export function findWebhookNameById(db: Database, id: string): { name: string } | null {
	return getOne(db, liveWebhooks().select("name").where("id", "=", id));
}

export function findWebhookTaskIdById(db: Database, id: string): { task_id: string } | null {
	return getOne(db, liveWebhooks().select("task_id").where("id", "=", id));
}

/**
 * Finds the live (non-soft-deleted) webhook bound to a handler thread, or null.
 *
 * Webhook intake rows are written with `ref_id = webhook.thread_id`
 * (packages/web/src/server/webhook-handler.ts), and they only drain when a task
 * whose `thread_id` matches that `ref_id` runs. The dead-letter reconciler uses
 * this to decide whether undrained intake is RECOVERABLE (a live binding still
 * owns the thread, so reviving the handler will drain the backlog) or ORPHANED
 * (the webhook was deregistered / never existed, so the intake can never drain
 * and must be dead-lettered instead of perpetually advised).
 */
export function findActiveWebhookByThreadId(
	db: Database,
	threadId: string,
): { id: string; name: string; task_id: string } | null {
	return getOne(
		db,
		liveWebhooks().select(["id", "name", "task_id"]).where("thread_id", "=", threadId),
	);
}

/**
 * Read-back that intentionally OMITS the `deleted = 0` filter — used by the
 * deterministic-id restore path, which must see a previously soft-deleted row.
 */
export function findWebhookDeletedFlagById(db: Database, id: string): { deleted: number } | null {
	return getOne(db, queryBuilder.selectFrom("webhooks").select("deleted").where("id", "=", id));
}
