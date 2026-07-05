import type { Database } from "bun:sqlite";
import type { Task } from "@bound/shared";

/** Read repository for the `tasks` table. See ./index.ts for conventions. */

export function findTaskById(db: Database, id: string): Task | null {
	return db.query("SELECT * FROM tasks WHERE id = ?").get(id) as Task | null;
}

export function findActiveTaskById(db: Database, id: string): Task | null {
	return db.query("SELECT * FROM tasks WHERE id = ? AND deleted = 0").get(id) as Task | null;
}

export function listRunningTasksForHost(db: Database, claimedBy: string): Task[] {
	return db
		.query("SELECT * FROM tasks WHERE status = 'running' AND claimed_by = ?")
		.all(claimedBy) as Task[];
}

export function findTaskExistenceById(
	db: Database,
	id: string,
): { id: string; deleted: number } | null {
	return db.query("SELECT id, deleted FROM tasks WHERE id = ?").get(id) as {
		id: string;
		deleted: number;
	} | null;
}

export function findTaskStatusById(
	db: Database,
	id: string,
): { status: string; deleted: number; consecutive_failures: number | null } | null {
	return db
		.query("SELECT status, deleted, consecutive_failures FROM tasks WHERE id = ?")
		.get(id) as {
		status: string;
		deleted: number;
		consecutive_failures: number | null;
	} | null;
}

export function findTaskLeaseById(db: Database, id: string): { lease_id: string | null } | null {
	return db.query("SELECT lease_id FROM tasks WHERE id = ?").get(id) as {
		lease_id: string | null;
	} | null;
}

export function findTaskIdAndStatusById(
	db: Database,
	id: string,
): { id: string; status: string } | null {
	return db.query("SELECT id, status FROM tasks WHERE id = ?").get(id) as {
		id: string;
		status: string;
	} | null;
}

export function findTaskClaimById(
	db: Database,
	id: string,
): {
	claimed_by: string | null;
	lease_id: string | null;
	status: string;
	deleted: number;
} | null {
	return db
		.query("SELECT claimed_by, lease_id, status, deleted FROM tasks WHERE id = ?")
		.get(id) as {
		claimed_by: string | null;
		lease_id: string | null;
		status: string;
		deleted: number;
	} | null;
}

export function findTaskIdById(db: Database, id: string): { id: string } | null {
	return db.query("SELECT id FROM tasks WHERE id = ?").get(id) as { id: string } | null;
}

export function findActiveTaskThreadId(db: Database, id: string): { thread_id: string } | null {
	return db.query("SELECT thread_id FROM tasks WHERE id = ? AND deleted = 0").get(id) as {
		thread_id: string;
	} | null;
}

export function findActiveTaskIdAndType(
	db: Database,
	id: string,
): { id: string; type: string } | null {
	return db.query("SELECT id, type FROM tasks WHERE id = ? AND deleted = 0").get(id) as {
		id: string;
		type: string;
	} | null;
}

export function findActiveTaskIdById(db: Database, id: string): { id: string } | null {
	return db.query("SELECT id FROM tasks WHERE id = ? AND deleted = 0").get(id) as {
		id: string;
	} | null;
}

export function findTaskClaimedAtById(
	db: Database,
	id: string,
): { claimed_at: string | null } | null {
	return db.query("SELECT claimed_at FROM tasks WHERE id = ?").get(id) as {
		claimed_at: string | null;
	} | null;
}

export function findActiveTaskPayloadById(
	db: Database,
	id: string,
): { payload: string | null } | null {
	return db.query("SELECT payload FROM tasks WHERE id = ? AND deleted = 0").get(id) as {
		payload: string | null;
	} | null;
}

export function findTaskRunTimestampsById(
	db: Database,
	id: string,
): { last_run_at: string | null; created_at: string } | null {
	return db.prepare("SELECT last_run_at, created_at FROM tasks WHERE id = ?").get(id) as {
		last_run_at: string | null;
		created_at: string;
	} | null;
}

export function findActiveTaskSummaryById(
	db: Database,
	id: string,
): { id: string; name: string; thread_id: string | null } | null {
	return db.query("SELECT id, name, thread_id FROM tasks WHERE id = ? AND deleted = 0").get(id) as {
		id: string;
		name: string;
		thread_id: string | null;
	} | null;
}

export function listStuckRecoverableTasks(
	db: Database,
	stuckThreshold: string,
	deferredMaxRetries: number,
): Task[] {
	return db
		.query(
			`SELECT * FROM tasks
			WHERE deleted = 0
			  AND claimed_by IS NOT NULL
			  AND claimed_at < ?
			  AND (
			    (type = 'heartbeat' AND status IN ('failed', 'cancelled', 'completed'))
			    OR (type IN ('cron', 'event') AND status = 'failed')
			    OR (type = 'deferred' AND status = 'failed' AND consecutive_failures < ?)
			  )`,
		)
		.all(stuckThreshold, deferredMaxRetries) as Task[];
}

export function listSchedulablePendingTasks(db: Database, now: string): Task[] {
	return db
		.query(
			`SELECT * FROM tasks WHERE status = 'pending' AND deleted = 0 AND next_run_at IS NOT NULL AND next_run_at <= ?
			 ORDER BY next_run_at ASC LIMIT 100`,
		)
		.all(now) as Task[];
}

export function listClaimedTasksForHost(db: Database, claimedBy: string): Task[] {
	return db
		.query(
			`SELECT * FROM tasks WHERE status = 'claimed' AND claimed_by = ?
			 ORDER BY created_at ASC LIMIT 10`,
		)
		.all(claimedBy) as Task[];
}

export function listStaleClaimedTasks(db: Database, leaseExpiry: string): Task[] {
	return db
		.query("SELECT * FROM tasks WHERE status = 'claimed' AND deleted = 0 AND claimed_at < ?")
		.all(leaseExpiry) as Task[];
}

/** Pending `event`-type tasks listening on `triggerSpec` (`connector:event:<handleId>`) — the scheduler's routing lookup when a connector event fires. */
export function listPendingEventTasksByTrigger(db: Database, triggerSpec: string): Task[] {
	return db
		.query(
			"SELECT * FROM tasks WHERE type = 'event' AND status = 'pending' AND deleted = 0 AND trigger_spec = ?",
		)
		.all(triggerSpec) as Task[];
}

export function countPendingNoQuiescenceTasks(db: Database): { count: number } | null {
	return db
		.query("SELECT COUNT(*) as count FROM tasks WHERE status = 'pending' AND no_quiescence = 1")
		.get() as { count: number } | null;
}

export function listRecentTaskCompletions(
	db: Database,
	cutoff: string,
): { trigger_spec: string; status: string; error: string | null; last_run_at: string }[] {
	return db
		.prepare(
			`SELECT trigger_spec, status, error, last_run_at
			 FROM tasks
			 WHERE status IN ('completed', 'failed')
			   AND last_run_at > ?
			   AND deleted = 0
			 ORDER BY last_run_at DESC
			 LIMIT 5`,
		)
		.all(cutoff) as {
		trigger_spec: string;
		status: string;
		error: string | null;
		last_run_at: string;
	}[];
}

/** For every thread driven by a `no_history` cron task that ran since `activeCutoff`, the most recent `last_run_at` — the recency anchor those threads use in place of a real user message. */
export function listNoHistoryCronThreadAnchors(
	db: Database,
	activeCutoff: string,
): { thread_id: string; anchor: string }[] {
	return db
		.query(
			`SELECT thread_id, MAX(last_run_at) AS anchor
			 FROM tasks
			 WHERE no_history = 1 AND deleted = 0 AND thread_id IS NOT NULL
			       AND last_run_at IS NOT NULL AND last_run_at > ?
			 GROUP BY thread_id`,
		)
		.all(activeCutoff) as { thread_id: string; anchor: string }[];
}

export function listPendingTaskStatsByHost(
	db: Database,
): { claimed_by: string; total: number; failing: number }[] {
	return db
		.prepare(
			`SELECT claimed_by,
					COUNT(*) as total,
					SUM(CASE WHEN consecutive_failures > 0 THEN 1 ELSE 0 END) as failing
				 FROM tasks
				 WHERE status = 'pending' AND deleted = 0
				 GROUP BY claimed_by`,
		)
		.all() as { claimed_by: string; total: number; failing: number }[];
}

export function listRunningTaskIdsForHost(db: Database, claimedBy: string): { id: string }[] {
	return db
		.query(
			`SELECT id FROM tasks
				 WHERE status = 'running'
				   AND claimed_by = ?`,
		)
		.all(claimedBy) as { id: string }[];
}

export function listRunningTaskIdAndStatus(db: Database): { id: string; status: string }[] {
	return db.query("SELECT id, status FROM tasks WHERE status = 'running'").all() as {
		id: string;
		status: string;
	}[];
}

export function listActiveTasks(db: Database, status?: string): Task[] {
	let query = "SELECT * FROM tasks WHERE deleted = 0";
	const params: string[] = [];
	if (status) {
		query += " AND status = ?";
		params.push(status);
	}
	query += " ORDER BY created_at DESC";
	return db.query(query).all(...params) as Task[];
}

export function countRunningTasks(db: Database): { count: number } | null {
	return db
		.query("SELECT COUNT(*) as count FROM tasks WHERE status = 'running' AND deleted = 0")
		.get() as { count: number } | null;
}

export function findRunningTaskIdForThread(db: Database, threadId: string): { id: string } | null {
	return db
		.query(
			"SELECT id FROM tasks WHERE thread_id = ? AND status = 'running' AND deleted = 0 LIMIT 1",
		)
		.get(threadId) as { id: string } | null;
}

/** Most recently created `event`-type task bound to `threadId`, if any. */
export function findLatestEventTaskIdForThread(
	db: Database,
	threadId: string,
): { id: string } | null {
	return db
		.query(
			"SELECT id FROM tasks WHERE thread_id = ? AND type = 'event' AND deleted = 0 ORDER BY created_at DESC LIMIT 1",
		)
		.get(threadId) as { id: string } | null;
}

/** Most recently created task's type/no_history/system_prompt_addition for `threadId` — used to inherit those settings for a follow-up wakeup on the same thread. */
export function findLatestTaskSettingsForThread(
	db: Database,
	threadId: string,
): {
	id: string;
	type: string;
	no_history: number;
	system_prompt_addition: string | null;
} | null {
	return db
		.query(
			"SELECT id, type, no_history, system_prompt_addition FROM tasks WHERE thread_id = ? AND deleted = 0 ORDER BY created_at DESC LIMIT 1",
		)
		.get(threadId) as {
		id: string;
		type: string;
		no_history: number;
		system_prompt_addition: string | null;
	} | null;
}

/** Non-heartbeat, still-pending-or-claimed task ids whose payload matches `payloadPattern` (a SQL LIKE pattern) — the `cancel --payload-match` lookup. */
export function listCancellableTaskIdsByPayload(
	db: Database,
	payloadPattern: string,
): { id: string }[] {
	return db
		.prepare(
			"SELECT id FROM tasks WHERE payload LIKE ? AND type != 'heartbeat' AND status IN ('pending', 'claimed') AND deleted = 0",
		)
		.all(payloadPattern) as { id: string }[];
}

export function listActiveTasksWithPayload(
	db: Database,
): { id: string; payload: string; thread_id: string | null }[] {
	return db
		.prepare("SELECT id, payload, thread_id FROM tasks WHERE deleted = 0 AND payload IS NOT NULL")
		.all() as { id: string; payload: string; thread_id: string | null }[];
}
