import type { Database } from "bun:sqlite";

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
	thread_title: string | null;
}

export function listConnectorBindingsWithTask(db: Database): ConnectorBindingWithTaskRow[] {
	return db
		.prepare(
			`SELECT h.id,
			        h.server_name,
			        h.event_name,
			        h.event_args,
			        h.delivery_mode,
			        h.cursor,
			        h.task_id,
			        h.created_at,
			        h.modified_at,
			        t.status AS task_status,
			        t.thread_id AS task_thread_id,
			        t.trigger_spec AS task_trigger_spec,
			        th.title AS thread_title
			 FROM connector_handles h
			 LEFT JOIN tasks t ON t.id = h.task_id AND t.deleted = 0
			 LEFT JOIN threads th ON th.id = t.thread_id AND th.deleted = 0
			 WHERE h.deleted = 0
			 ORDER BY h.created_at DESC`,
		)
		.all() as ConnectorBindingWithTaskRow[];
}
