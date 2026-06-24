import type { Database } from "bun:sqlite";
import type { Webhook } from "@bound/shared";

/**
 * Read repository for the `webhooks` table. See ./index.ts for conventions.
 */

export function findWebhookByName(db: Database, name: string): Webhook | null {
	return db
		.query("SELECT * FROM webhooks WHERE name = ? AND deleted = 0")
		.get(name) as Webhook | null;
}

export function findWebhookIdByName(db: Database, name: string): { id: string } | null {
	return db.query("SELECT id FROM webhooks WHERE name = ? AND deleted = 0").get(name) as {
		id: string;
	} | null;
}

export function findWebhookIdAndTaskIdByName(
	db: Database,
	name: string,
): { id: string; task_id: string } | null {
	return db.query("SELECT id, task_id FROM webhooks WHERE name = ? AND deleted = 0").get(name) as {
		id: string;
		task_id: string;
	} | null;
}

export function findWebhookIdsByName(
	db: Database,
	name: string,
): { id: string; task_id: string; thread_id: string } | null {
	return db
		.query("SELECT id, task_id, thread_id FROM webhooks WHERE name = ? AND deleted = 0")
		.get(name) as { id: string; task_id: string; thread_id: string } | null;
}

export function findWebhookIdsById(
	db: Database,
	id: string,
): { id: string; task_id: string; thread_id: string } | null {
	return db
		.query("SELECT id, task_id, thread_id FROM webhooks WHERE id = ? AND deleted = 0")
		.get(id) as { id: string; task_id: string; thread_id: string } | null;
}

export function findWebhookIdById(db: Database, id: string): { id: string } | null {
	return db.query("SELECT id FROM webhooks WHERE id = ? AND deleted = 0").get(id) as {
		id: string;
	} | null;
}

export function findWebhookNameById(db: Database, id: string): { name: string } | null {
	return db.query("SELECT name FROM webhooks WHERE id = ? AND deleted = 0").get(id) as {
		name: string;
	} | null;
}

export function findWebhookTaskIdById(db: Database, id: string): { task_id: string } | null {
	return db.query("SELECT task_id FROM webhooks WHERE id = ? AND deleted = 0").get(id) as {
		task_id: string;
	} | null;
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
): { id: string; name: string } | null {
	return db
		.query("SELECT id, name FROM webhooks WHERE thread_id = ? AND deleted = 0")
		.get(threadId) as { id: string; name: string } | null;
}

/**
 * Read-back that intentionally OMITS the `deleted = 0` filter — used by the
 * deterministic-id restore path, which must see a previously soft-deleted row.
 */
export function findWebhookDeletedFlagById(db: Database, id: string): { deleted: number } | null {
	return db.query("SELECT deleted FROM webhooks WHERE id = ?").get(id) as {
		deleted: number;
	} | null;
}
