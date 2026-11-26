import type { Database } from "bun:sqlite";
import { getOne, queryBuilder } from "../query-builder";

/** Existence check by id; ignores the `deleted` flag. */
export function findUserIdById(db: Database, id: string): { id: string } | null {
	return getOne(db, queryBuilder.selectFrom("users").select("id").where("id", "=", id));
}

export function findUserDisplayNameById(db: Database, id: string): { display_name: string } | null {
	return getOne(
		db,
		queryBuilder
			.selectFrom("users")
			.select("display_name")
			.where("id", "=", id)
			.where("deleted", "=", 0),
	);
}
