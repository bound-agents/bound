import type { Database } from "bun:sqlite";

const WEBHOOK_RESPONSE_SELECT = `SELECT
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

export function findWebhookResponseById(db: Database, id: string): Record<string, unknown> | null {
	return db.prepare(`${WEBHOOK_RESPONSE_SELECT} WHERE w.id = ?`).get(id) as Record<
		string,
		unknown
	> | null;
}
