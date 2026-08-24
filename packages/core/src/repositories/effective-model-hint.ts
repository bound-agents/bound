import type { Database } from "bun:sqlite";

export function resolveEffectiveModelHint(
	db: Database,
	threadId: string,
	nodeDefault: string,
	taskId?: string,
): string {
	const row = db
		.query(
			`SELECT task.model_hint AS task_model_hint, thread.model_hint AS thread_model_hint
			 FROM threads AS thread
			 LEFT JOIN tasks AS task ON task.id = ? AND task.thread_id = thread.id AND task.deleted = 0
			 WHERE thread.id = ? AND thread.deleted = 0`,
		)
		.get(taskId ?? null, threadId) as {
		task_model_hint: string | null;
		thread_model_hint: string | null;
	} | null;
	return row?.task_model_hint ?? row?.thread_model_hint ?? nodeDefault;
}
