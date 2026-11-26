import type { Database } from "bun:sqlite";
import type { Skill } from "@bound/shared";

export function findSkillByName(db: Database, name: string): Skill | null {
	return db.query("SELECT * FROM skills WHERE name = ? AND deleted = 0").get(name) as Skill | null;
}

export function findSkillById(db: Database, id: string): Skill | null {
	return db.query("SELECT * FROM skills WHERE id = ? AND deleted = 0").get(id) as Skill | null;
}

/** Full row by id; ignores the `deleted` flag. */
export function findSkillByIdIncludingDeleted(db: Database, id: string): Skill | null {
	return db.query("SELECT * FROM skills WHERE id = ?").get(id) as Skill | null;
}

export function listSkills(db: Database): Skill[] {
	return db.query("SELECT * FROM skills WHERE deleted = 0").all() as Skill[];
}

/** Existence check by id; ignores the `deleted` flag. */
export function findSkillIdById(db: Database, id: string): { id: string } | null {
	return db.query("SELECT id FROM skills WHERE id = ?").get(id) as { id: string } | null;
}

/** Id + `skill_root` (for SKILL.md resolution) of a non-deleted skill. */
export function findActiveSkillIdAndRootByName(
	db: Database,
	name: string,
): { id: string; skill_root: string | null } | null {
	return db.query("SELECT id, skill_root FROM skills WHERE name = ? AND deleted = 0").get(name) as {
		id: string;
		skill_root: string | null;
	} | null;
}

/** Active skills (name + description), ordered by most-recently-activated. */
export function listActiveSkillNameDescriptions(
	db: Database,
): Array<{ name: string; description: string }> {
	return db
		.query("SELECT name, description FROM skills WHERE deleted = 0 ORDER BY last_activated_at DESC")
		.all() as Array<{ name: string; description: string }>;
}
