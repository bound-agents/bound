import type { Database } from "bun:sqlite";
import type { Skill } from "@bound/shared";
import type { NotNull } from "kysely";
import { getAll, getOne, queryBuilder } from "../query-builder";

/**
 * `Skill` treats `activation_count` and `deleted` as non-null; the schema
 * declares them nullable with a default, so full-row reads narrow them.
 */
const fullSkillRows = () =>
	queryBuilder
		.selectFrom("skills")
		.selectAll()
		.$narrowType<{ activation_count: NotNull; deleted: NotNull }>();

export function findSkillByName(db: Database, name: string): Skill | null {
	return getOne(db, fullSkillRows().where("name", "=", name).where("deleted", "=", 0));
}

export function findSkillById(db: Database, id: string): Skill | null {
	return getOne(db, fullSkillRows().where("id", "=", id).where("deleted", "=", 0));
}

/** Full row by id; ignores the `deleted` flag. */
export function findSkillByIdIncludingDeleted(db: Database, id: string): Skill | null {
	return getOne(db, fullSkillRows().where("id", "=", id));
}

export function listSkills(db: Database): Skill[] {
	return getAll(db, fullSkillRows().where("deleted", "=", 0));
}

/** Existence check by id; ignores the `deleted` flag. */
export function findSkillIdById(db: Database, id: string): { id: string } | null {
	return getOne(db, queryBuilder.selectFrom("skills").select("id").where("id", "=", id));
}

/** Id + `skill_root` (for SKILL.md resolution) of a non-deleted skill. */
export function findActiveSkillIdAndRootByName(
	db: Database,
	name: string,
): { id: string; skill_root: string | null } | null {
	return getOne(
		db,
		queryBuilder
			.selectFrom("skills")
			.select(["id", "skill_root"])
			.where("name", "=", name)
			.where("deleted", "=", 0),
	);
}

/** Active skills (name + description), ordered by most-recently-activated. */
export function listActiveSkillNameDescriptions(
	db: Database,
): Array<{ name: string; description: string }> {
	return getAll(
		db,
		queryBuilder
			.selectFrom("skills")
			.select(["name", "description"])
			.where("deleted", "=", 0)
			.orderBy("last_activated_at", "desc"),
	);
}
