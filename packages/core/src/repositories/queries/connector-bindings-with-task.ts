import type { Database } from "bun:sqlite";
import { getAll, queryBuilder } from "../../query-builder";

/**
 * Connector handles decorated with their backing event task and thread. The raw
 * event_args value remains a JSON string here; API clients parse it at the edge
 * so corrupt rows can still be listed and detached.
 */
export interface ConnectorBindingWithTaskRow {
	id: string;
	server_name: string;
	event_name: string;
	event_args: string;
	delivery_mode: string;
	cursor: string | null;
	task_id: string | null;
	created_at: string;
	modified_at: string;
	task_status: string | null;
	task_thread_id: string | null;
	task_trigger_spec: string | null;
	/**
	 * `tasks.model_hint` for the backing event task; null means "use the cluster
	 * default model". Lives on the task rather than the handle — `connector_handles`
	 * has no model column, matching how webhooks and RSS feeds carry theirs.
	 */
	model_hint: string | null;
	thread_title: string | null;
}

export function listConnectorBindingsWithTask(db: Database): ConnectorBindingWithTaskRow[] {
	return getAll(
		db,
		queryBuilder
			.selectFrom("connector_handles as h")
			.leftJoin("tasks as t", (join) =>
				join.onRef("t.id", "=", "h.task_id").on("t.deleted", "=", 0),
			)
			.leftJoin("threads as th", (join) =>
				join.onRef("th.id", "=", "t.thread_id").on("th.deleted", "=", 0),
			)
			.select([
				"h.id",
				"h.server_name",
				"h.event_name",
				"h.event_args",
				"h.delivery_mode",
				"h.cursor",
				"h.task_id",
				"h.created_at",
				"h.modified_at",
				"t.status as task_status",
				"t.thread_id as task_thread_id",
				"t.trigger_spec as task_trigger_spec",
				"t.model_hint as model_hint",
				"th.title as thread_title",
			])
			.where("h.deleted", "=", 0)
			.orderBy("h.created_at", "desc"),
	);
}
