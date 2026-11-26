import type { Database } from "bun:sqlite";
import { getOne, queryBuilder } from "../../query-builder";

/**
 * A live infrastructure binding that references a task: either a `webhooks` row
 * or a `connector_handles` row whose `task_id` points at the task and which has
 * not been soft-deleted.
 */
export type TaskInfraBinding =
	{ kind: "webhook"; label: string } | { kind: "connector"; label: string };

/**
 * Returns the live infrastructure binding that references the given task, or
 * `null` if none does.
 *
 * This is the application-level equivalent of a foreign-key constraint. Webhook
 * handlers and connector subscriptions each own a backing `type: "event"` task
 * (`webhooks.task_id` / `connector_handles.task_id`). Those tasks are not their
 * own task type — they share `"event"` with ordinary user-scheduled `--on`
 * tasks — so a guard cannot key off `task.type` the way the heartbeat guard
 * does. It keys off the binding instead: while a live binding row points at the
 * task, the task must not be cancelled out from under it (which orphans the
 * binding and silently darks the event stream).
 *
 * The `deleted = 0` filter is load-bearing: the sanctioned teardown paths
 * (webhook deregister, connector detach) soft-delete the binding first, which
 * releases the now-genuinely-orphaned task for normal cancellation. A live
 * binding blocks; a retired binding does not. (We can't express this with a
 * real FK — see invariant #20: synced tables carry no FK clauses because replay
 * inserts rows out of order. This is enforced at interactive-cancel time, where
 * replay ordering is not a concern.)
 */
export function findTaskInfraBinding(db: Database, taskId: string): TaskInfraBinding | null {
	const webhook = getOne(
		db,
		queryBuilder
			.selectFrom("webhooks")
			.select("name")
			.where("task_id", "=", taskId)
			.where("deleted", "=", 0),
	);
	if (webhook) return { kind: "webhook", label: webhook.name };

	const handle = getOne(
		db,
		queryBuilder
			.selectFrom("connector_handles")
			.select(["server_name", "event_name"])
			.where("task_id", "=", taskId)
			.where("deleted", "=", 0),
	);
	if (handle) return { kind: "connector", label: `${handle.server_name}:${handle.event_name}` };

	return null;
}
