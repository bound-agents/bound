import type { Database } from "bun:sqlite";
import type { Skill } from "@bound/shared";

/** Read repository for the `skills` table. See ./index.ts for conventions. */

export function findSkillByName(db: Database, name: string): Skill | null {
	return db.query("SELECT * FROM skills WHERE name = ? AND deleted = 0").get(name) as Skill | null;
}

export function listActiveSkills(db: Database): Skill[] {
	return db.query("SELECT * FROM skills WHERE deleted = 0 ORDER BY name ASC").all() as Skill[];
}

/** Full row by id, active only. */
export function findSkillById(db: Database, id: string): Skill | null {
	return db.query("SELECT * FROM skills WHERE id = ? AND deleted = 0").get(id) as Skill | null;
}

/** Full row by id with NO `deleted` filter (matches read-backs that omit it). */
export function findSkillByIdIncludingDeleted(db: Database, id: string): Skill | null {
	return db.query("SELECT * FROM skills WHERE id = ?").get(id) as Skill | null;
}

/** All non-deleted skills, unordered. */
export function listSkills(db: Database): Skill[] {
	return db.query("SELECT * FROM skills WHERE deleted = 0").all() as Skill[];
}

/** Existence check by id (no `deleted` filter — matches the raw read-back). */
export function findSkillIdById(db: Database, id: string): { id: string } | null {
	return db.query("SELECT id FROM skills WHERE id = ?").get(id) as { id: string } | null;
}

export function findSkillRootByName(
	db: Database,
	name: string,
): { skill_root: string | null } | null {
	return db.query("SELECT skill_root FROM skills WHERE name = ? AND deleted = 0").get(name) as {
		skill_root: string | null;
	} | null;
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

export function findActiveSkillSourceByName(
	db: Database,
	name: string,
): { skill_root: string | null; content_hash: string | null; modified_at: string | null } | null {
	return db
		.query(
			"SELECT skill_root, content_hash, modified_at FROM skills WHERE name = ? AND deleted = 0",
		)
		.get(name) as {
		skill_root: string | null;
		content_hash: string | null;
		modified_at: string | null;
	} | null;
}

export function findSkillMetadataByName(
	db: Database,
	name: string,
): {
	id: string;
	name: string;
	activation_count: number;
	last_activated_at: string | null;
	description: string;
	content_hash: string | null;
	skill_root: string;
} | null {
	return db
		.query(
			"SELECT id, name, activation_count, last_activated_at, description, content_hash, skill_root FROM skills WHERE name = ? AND deleted = 0",
		)
		.get(name) as {
		id: string;
		name: string;
		activation_count: number;
		last_activated_at: string | null;
		description: string;
		content_hash: string | null;
		skill_root: string;
	} | null;
}

export function findSkillDetailByName(
	db: Database,
	name: string,
): {
	id: string;
	name: string;
	activation_count: number;
	last_activated_at: string | null;
	description: string;
	content_hash: string | null;
	skill_root: string;
} | null {
	return db
		.query(
			`SELECT id, name, activation_count, last_activated_at, description,
			        content_hash, skill_root
			 FROM skills WHERE name = ? AND deleted = 0`,
		)
		.get(name) as {
		id: string;
		name: string;
		activation_count: number;
		last_activated_at: string | null;
		description: string;
		content_hash: string | null;
		skill_root: string;
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

/**
 * Skill list view (CLI). All non-deleted skills, ordered by
 * most-recently-activated, then name.
 */
export function listSkillsForCliView(db: Database): Array<{
	name: string;
	activation_count: number;
	last_activated_at: string | null;
	description: string;
	allowed_tools: string | null;
	compatibility: string | null;
	content_hash: string | null;
	skill_root: string;
}> {
	return db
		.query(
			`SELECT name, activation_count, last_activated_at, description,
			        allowed_tools, compatibility, content_hash, skill_root
			 FROM skills
			 WHERE deleted = 0
			 ORDER BY last_activated_at DESC, name ASC`,
		)
		.all() as Array<{
		name: string;
		activation_count: number;
		last_activated_at: string | null;
		description: string;
		allowed_tools: string | null;
		compatibility: string | null;
		content_hash: string | null;
		skill_root: string;
	}>;
}

/**
 * Skill list view (agent `skill` tool). Same as the CLI view minus `skill_root`.
 * All non-deleted skills.
 */
export function listSkillsForToolView(db: Database): Array<{
	name: string;
	activation_count: number;
	last_activated_at: string | null;
	description: string;
	allowed_tools: string | null;
	compatibility: string | null;
	content_hash: string | null;
}> {
	return db
		.query(
			`SELECT name, activation_count, last_activated_at, description,
			        allowed_tools, compatibility, content_hash
			 FROM skills
			 WHERE deleted = 0
			 ORDER BY last_activated_at DESC, name ASC`,
		)
		.all() as Array<{
		name: string;
		activation_count: number;
		last_activated_at: string | null;
		description: string;
		allowed_tools: string | null;
		compatibility: string | null;
		content_hash: string | null;
	}>;
}
