import type { Database } from "bun:sqlite";
import type { Task } from "@bound/shared";
import type { NotNull } from "kysely";
import { getAll, getOne, queryBuilder } from "../query-builder";

/** `SELECT *` over `tasks`, typed as the shared `Task` domain row (narrower unions than the schema's TEXT columns). */
function selectTaskRows() {
	return queryBuilder.selectFrom("tasks").selectAll().$castTo<Task>();
}

export function findTaskById(db: Database, id: string): Task | null {
	return getOne(db, selectTaskRows().where("id", "=", id));
}

export function findActiveTaskById(db: Database, id: string): Task | null {
	return getOne(db, selectTaskRows().where("id", "=", id).where("deleted", "=", 0));
}

export function findTaskExistenceById(
	db: Database,
	id: string,
): { id: string; deleted: number } | null {
	return getOne(
		db,
		queryBuilder
			.selectFrom("tasks")
			.select(["id", "deleted"])
			.where("id", "=", id)
			.$narrowType<{ deleted: NotNull }>(),
	);
}

export function findTaskIdAndStatusById(
	db: Database,
	id: string,
): { id: string; status: string } | null {
	return getOne(db, queryBuilder.selectFrom("tasks").select(["id", "status"]).where("id", "=", id));
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
	return getOne(
		db,
		queryBuilder
			.selectFrom("tasks")
			.select(["claimed_by", "lease_id", "status", "deleted"])
			.where("id", "=", id)
			.$narrowType<{ deleted: NotNull }>(),
	);
}

export function findTaskIdById(db: Database, id: string): { id: string } | null {
	return getOne(db, queryBuilder.selectFrom("tasks").select("id").where("id", "=", id));
}

export function findTaskClaimedAtById(
	db: Database,
	id: string,
): { claimed_at: string | null } | null {
	return getOne(db, queryBuilder.selectFrom("tasks").select("claimed_at").where("id", "=", id));
}

export function findActiveTaskPayloadById(
	db: Database,
	id: string,
): { payload: string | null } | null {
	return getOne(
		db,
		queryBuilder
			.selectFrom("tasks")
			.select("payload")
			.where("id", "=", id)
			.where("deleted", "=", 0),
	);
}

export function findTaskRunTimestampsById(
	db: Database,
	id: string,
): { last_run_at: string | null; created_at: string } | null {
	return getOne(
		db,
		queryBuilder.selectFrom("tasks").select(["last_run_at", "created_at"]).where("id", "=", id),
	);
}

export function listActiveTasks(db: Database, status?: string): Task[] {
	return getAll(
		db,
		selectTaskRows()
			.where("deleted", "=", 0)
			.$if(Boolean(status), (qb) => qb.where("status", "=", status as string))
			.orderBy("created_at", "desc"),
	);
}

export function countRunningTasks(db: Database): { count: number } | null {
	return getOne(
		db,
		queryBuilder
			.selectFrom("tasks")
			.select((eb) => eb.fn.countAll<number>().as("count"))
			.where("status", "=", "running")
			.where("deleted", "=", 0),
	);
}

export function findRunningTaskIdForThread(db: Database, threadId: string): { id: string } | null {
	return getOne(
		db,
		queryBuilder
			.selectFrom("tasks")
			.select("id")
			.where("thread_id", "=", threadId)
			.where("status", "=", "running")
			.where("deleted", "=", 0)
			.limit(1),
	);
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
	return getOne(
		db,
		queryBuilder
			.selectFrom("tasks")
			.select(["id", "type", "no_history", "system_prompt_addition"])
			.where("thread_id", "=", threadId)
			.where("deleted", "=", 0)
			.orderBy("created_at", "desc")
			.limit(1)
			.$narrowType<{ no_history: NotNull }>(),
	);
}

export function listActiveTasksWithPayload(
	db: Database,
): { id: string; payload: string; thread_id: string | null }[] {
	return getAll(
		db,
		queryBuilder
			.selectFrom("tasks")
			.select(["id", "payload", "thread_id"])
			.where("deleted", "=", 0)
			.where("payload", "is not", null)
			.$narrowType<{ payload: NotNull }>(),
	);
}
