import type { Database } from "bun:sqlite";
import type { Thread } from "@bound/shared";
import { getOne, queryBuilder } from "../query-builder";

/**
 * `SELECT *` over `threads`, narrowed to the `Thread` domain shape: the DDL
 * admits NULL in `color` and `deleted`, which `Thread` declares non-null.
 */
function selectThreadRow() {
	return queryBuilder
		.selectFrom("threads")
		.selectAll()
		.$narrowType<{ color: number; deleted: number }>();
}

export function findThreadById(db: Database, id: string): Thread | null {
	return getOne(db, selectThreadRow().where("id", "=", id));
}

export function findLiveThreadById(db: Database, id: string): Thread | null {
	return getOne(db, selectThreadRow().where("id", "=", id).where("deleted", "=", 0));
}

export function findThreadIdById(db: Database, id: string): { id: string } | null {
	return getOne(db, queryBuilder.selectFrom("threads").select("id").where("id", "=", id));
}

export function findLiveThreadIdById(db: Database, id: string): { id: string } | null {
	return getOne(
		db,
		queryBuilder.selectFrom("threads").select("id").where("id", "=", id).where("deleted", "=", 0),
	);
}

export function findThreadUserAndInterfaceById(
	db: Database,
	id: string,
): { user_id: string; interface: string } | null {
	return getOne(
		db,
		queryBuilder.selectFrom("threads").select(["user_id", "interface"]).where("id", "=", id),
	);
}

export function findThreadSummaryById(db: Database, id: string): { summary: string | null } | null {
	return getOne(db, queryBuilder.selectFrom("threads").select("summary").where("id", "=", id));
}

export function findThreadSummaryStateById(
	db: Database,
	id: string,
): {
	summary: string | null;
	summary_through: string | null;
	last_message_at: string | null;
} | null {
	return getOne(
		db,
		queryBuilder
			.selectFrom("threads")
			.select(["summary", "summary_through", "last_message_at"])
			.where("id", "=", id),
	);
}

export function findThreadTitleById(db: Database, id: string): Pick<Thread, "title"> | null {
	return getOne(db, queryBuilder.selectFrom("threads").select("title").where("id", "=", id));
}

export function findThreadCreatedAtById(db: Database, id: string): { created_at: string } | null {
	return getOne(db, queryBuilder.selectFrom("threads").select("created_at").where("id", "=", id));
}

export function findThreadModelHintById(
	db: Database,
	id: string,
): { model_hint: string | null } | null {
	return getOne(db, queryBuilder.selectFrom("threads").select("model_hint").where("id", "=", id));
}

export function findLatestThreadColorExcludingInterfaces(
	db: Database,
	excludedInterfaces: readonly string[],
): { color: number } | null {
	return getOne(
		db,
		queryBuilder
			.selectFrom("threads")
			.select("color")
			.where("deleted", "=", 0)
			.where("interface", "not in", excludedInterfaces)
			.orderBy("created_at", "desc")
			.limit(1)
			.$narrowType<{ color: number }>(),
	);
}

/** One link up the ancestry chain (live rows only). */
export function findThreadParentIdById(
	db: Database,
	id: string,
): { parent_thread_id: string | null } | null {
	return getOne(
		db,
		queryBuilder
			.selectFrom("threads")
			.select("parent_thread_id")
			.where("id", "=", id)
			.where("deleted", "=", 0),
	);
}

/**
 * The owning aux identity, or null for a main-agent thread.
 *
 * Behavioral code identifies aux threads by `agent_id IS NOT NULL`, never by the
 * `interface` tag (#201) — `interface='aux'` is descriptive only.
 */
export function findThreadAgentIdById(
	db: Database,
	id: string,
): { agent_id: string | null } | null {
	return getOne(
		db,
		queryBuilder
			.selectFrom("threads")
			.select("agent_id")
			.where("id", "=", id)
			.where("deleted", "=", 0),
	);
}
