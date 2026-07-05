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

/** All non-deleted skills with the given status, unordered. */
export function listSkillsByStatus(db: Database, status: string): Skill[] {
	return db.query("SELECT * FROM skills WHERE deleted = 0 AND status = ?").all(status) as Skill[];
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

export function findSkillStatusByName(db: Database, name: string): { status: string } | null {
	return db.query("SELECT status FROM skills WHERE name = ? AND deleted = 0").get(name) as {
		status: string;
	} | null;
}

export function findSkillIdAndStatusByName(
	db: Database,
	name: string,
): { id: string; status: string } | null {
	return db.query("SELECT id, status FROM skills WHERE name = ? AND deleted = 0").get(name) as {
		id: string;
		status: string;
	} | null;
}

/** Like {@link findSkillIdAndStatusByName} but scoped to `status = 'active'`, returning `skill_root` for SKILL.md resolution instead of status. */
export function findActiveSkillIdAndRootByName(
	db: Database,
	name: string,
): { id: string; skill_root: string | null } | null {
	return db
		.query("SELECT id, skill_root FROM skills WHERE name = ? AND status = 'active' AND deleted = 0")
		.get(name) as { id: string; skill_root: string | null } | null;
}

export function findActiveSkillSourceByName(
	db: Database,
	name: string,
): { skill_root: string | null; content_hash: string | null; modified_at: string | null } | null {
	return db
		.query(
			"SELECT skill_root, content_hash, modified_at FROM skills WHERE name = ? AND status = 'active' AND deleted = 0",
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
	status: string;
	activation_count: number;
	last_activated_at: string | null;
	description: string;
	content_hash: string | null;
	skill_root: string;
} | null {
	return db
		.query(
			"SELECT id, name, status, activation_count, last_activated_at, description, content_hash, skill_root FROM skills WHERE name = ? AND deleted = 0",
		)
		.get(name) as {
		id: string;
		name: string;
		status: string;
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
	status: string;
	activation_count: number;
	last_activated_at: string | null;
	description: string;
	content_hash: string | null;
	skill_root: string;
	retired_by: string | null;
	retired_reason: string | null;
} | null {
	return db
		.query(
			`SELECT id, name, status, activation_count, last_activated_at, description,
			        content_hash, skill_root, retired_by, retired_reason
			 FROM skills WHERE name = ? AND deleted = 0`,
		)
		.get(name) as {
		id: string;
		name: string;
		status: string;
		activation_count: number;
		last_activated_at: string | null;
		description: string;
		content_hash: string | null;
		skill_root: string;
		retired_by: string | null;
		retired_reason: string | null;
	} | null;
}

export function countActiveSkills(db: Database): { count: number } {
	return db
		.query("SELECT COUNT(*) as count FROM skills WHERE status = 'active' AND deleted = 0")
		.get() as { count: number };
}

/** Active skills (name + description), ordered by most-recently-activated. */
export function listActiveSkillNameDescriptions(
	db: Database,
): Array<{ name: string; description: string }> {
	return db
		.query(
			"SELECT name, description FROM skills WHERE status = 'active' AND deleted = 0 ORDER BY last_activated_at DESC",
		)
		.all() as Array<{ name: string; description: string }>;
}

/** Operator-retired skills modified since the given ISO cutoff. */
export function listOperatorRetiredSkillsSince(
	db: Database,
	modifiedAfter: string,
): Array<{ name: string; retired_reason: string | null }> {
	return db
		.query(
			`SELECT name, retired_reason FROM skills
			 WHERE status = 'retired'
			   AND retired_by = 'operator'
			   AND modified_at > ?
			   AND deleted = 0`,
		)
		.all(modifiedAfter) as Array<{ name: string; retired_reason: string | null }>;
}

/**
 * Skill list view (CLI). `status` optional; when omitted, returns all
 * non-deleted skills. Ordered by most-recently-activated, then name.
 */
export function listSkillsForCliView(
	db: Database,
	status?: string,
): Array<{
	name: string;
	status: string;
	activation_count: number;
	last_activated_at: string | null;
	description: string;
	allowed_tools: string | null;
	compatibility: string | null;
	content_hash: string | null;
	retired_reason: string | null;
	skill_root: string;
}> {
	const whereClause = status ? "WHERE status = ? AND deleted = 0" : "WHERE deleted = 0";
	const queryArgs = status ? [status] : [];
	return db
		.query(
			`SELECT name, status, activation_count, last_activated_at, description,
			        allowed_tools, compatibility, content_hash, retired_reason,
			        skill_root
			 FROM skills
			 ${whereClause}
			 ORDER BY last_activated_at DESC, name ASC`,
		)
		.all(...queryArgs) as Array<{
		name: string;
		status: string;
		activation_count: number;
		last_activated_at: string | null;
		description: string;
		allowed_tools: string | null;
		compatibility: string | null;
		content_hash: string | null;
		retired_reason: string | null;
		skill_root: string;
	}>;
}

/**
 * Skill list view (agent `skill` tool). Same as the CLI view minus `skill_root`.
 * `status` optional; when omitted, returns all non-deleted skills.
 */
export function listSkillsForToolView(
	db: Database,
	status?: string,
): Array<{
	name: string;
	status: string;
	activation_count: number;
	last_activated_at: string | null;
	description: string;
	allowed_tools: string | null;
	compatibility: string | null;
	content_hash: string | null;
	retired_reason: string | null;
}> {
	const whereClause = status ? "WHERE status = ? AND deleted = 0" : "WHERE deleted = 0";
	const queryArgs = status ? [status] : [];
	return db
		.query(
			`SELECT name, status, activation_count, last_activated_at, description,
			        allowed_tools, compatibility, content_hash, retired_reason
			 FROM skills
			 ${whereClause}
			 ORDER BY last_activated_at DESC, name ASC`,
		)
		.all(...queryArgs) as Array<{
		name: string;
		status: string;
		activation_count: number;
		last_activated_at: string | null;
		description: string;
		allowed_tools: string | null;
		compatibility: string | null;
		content_hash: string | null;
		retired_reason: string | null;
	}>;
}
