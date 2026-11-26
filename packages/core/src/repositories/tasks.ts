import type { Database } from "bun:sqlite";
import type { Task } from "@bound/shared";

export function findTaskById(db: Database, id: string): Task | null {
	return db.query("SELECT * FROM tasks WHERE id = ?").get(id) as Task | null;
}

export function findActiveTaskById(db: Database, id: string): Task | null {
	return db.query("SELECT * FROM tasks WHERE id = ? AND deleted = 0").get(id) as Task | null;
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

export function listActiveTasksWithPayload(
	db: Database,
): { id: string; payload: string; thread_id: string | null }[] {
	return db
		.prepare("SELECT id, payload, thread_id FROM tasks WHERE deleted = 0 AND payload IS NOT NULL")
		.all() as { id: string; payload: string; thread_id: string | null }[];
}
