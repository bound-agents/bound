import type { Database } from "bun:sqlite";

/**
 * The symbolic model hint for "no task or thread hint". Model resolution maps
 * it to the configured cluster `default` role, or to the host's bootstrap
 * backend default only when that role is unset. Pass this — never a concrete
 * backend id such as `ModelRouter.getDefaultId()` — as `nodeDefault`, or the
 * cluster default is bypassed.
 */
export const DEFAULT_MODEL_HINT = "default";

/**
 * Resolve the model a loop should run on: task hint, then thread hint, then
 * `nodeDefault` (normally {@link DEFAULT_MODEL_HINT}).
 *
 * The task hint is read independently of the thread row. A live task bound to
 * `threadId` keeps its hint even when the thread row is soft-deleted or does
 * not exist yet (scheduler-created threads are inserted lazily). The task must
 * still be live (`deleted = 0`) and bound to this thread (`thread_id =
 * threadId`); a task bound elsewhere contributes nothing.
 *
 * The thread hint is a fallback only for live threads: a soft-deleted thread
 * never contributes its hint.
 */
export function resolveEffectiveModelHint(
	db: Database,
	threadId: string,
	nodeDefault: string,
	taskId?: string,
): string {
	const row = db
		.query(
			`SELECT
				(SELECT task.model_hint FROM tasks AS task
				 WHERE task.id = ? AND task.thread_id = ? AND task.deleted = 0) AS task_model_hint,
				(SELECT thread.model_hint FROM threads AS thread
				 WHERE thread.id = ? AND thread.deleted = 0) AS thread_model_hint`,
		)
		.get(taskId ?? null, threadId, threadId) as {
		task_model_hint: string | null;
		thread_model_hint: string | null;
	} | null;
	return row?.task_model_hint ?? row?.thread_model_hint ?? nodeDefault;
}
