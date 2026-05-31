import type { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { insertRow, updateRow } from "@bound/core";
import { BOUND_NAMESPACE, deterministicUUID } from "@bound/shared";
import { BUNDLED_SKILLS } from "./bundled-skills";
import type { BundledSkill } from "./bundled-skills-types";

/**
 * Seed a file into the files table if missing or stale (content hash differs).
 * Follows the autoCacheFile pattern from packages/sandbox/src/cluster-fs.ts.
 */
function seedFile(db: Database, siteId: string, path: string, content: string): void {
	const contentHash = createHash("sha256").update(content).digest("hex");
	const sizeBytes = Buffer.byteLength(content, "utf8");
	const now = new Date().toISOString();

	const existing = db
		.prepare("SELECT id, content, deleted FROM files WHERE path = ?")
		.get(path) as { id: string; content: string | null; deleted: number } | null;

	if (existing) {
		const existingHash = createHash("sha256")
			.update(existing.content ?? "")
			.digest("hex");
		if (existingHash !== contentHash || existing.deleted === 1) {
			// Content changed (e.g., updated bundled skill markdown) or file was deleted — restore/update
			updateRow(
				db,
				"files",
				existing.id,
				{ content, size_bytes: sizeBytes, modified_at: now, deleted: 0 },
				siteId,
			);
		}
		// else: content unchanged and not deleted, skip update (no-op)
	} else {
		// File missing (no row at this path at all) — insert
		insertRow(
			db,
			"files",
			{
				id: path,
				path,
				content,
				is_binary: 0,
				size_bytes: sizeBytes,
				created_at: now,
				modified_at: now,
				deleted: 0,
				created_by: null,
				host_origin: null,
			},
			siteId,
		);
	}
}

/**
 * Seed a single bundled skill: restore its files (if missing or stale) and
 * insert its skills row only if no row exists for that skill ID.
 *
 * Behavior:
 * - Files: always restored if missing or stale (content hash differs).
 * - Skills row: only inserted if absent. If the operator retired the skill, the
 *   retired row is left untouched — seeding never silently re-activates it.
 */
function seedBundledSkill(db: Database, siteId: string, skill: BundledSkill): void {
	const skillRoot = `/home/user/skills/${skill.name}`;
	const skillId = deterministicUUID(BOUND_NAMESPACE, skill.name);
	const now = new Date().toISOString();

	// Step 1: Restore skill files if missing or stale.
	for (const file of skill.files) {
		seedFile(db, siteId, `${skillRoot}/${file.path}`, file.content);
	}

	// Step 2: Insert skills row only if it does not already exist.
	// Equivalent to INSERT OR IGNORE — change-log compliant version.
	const existing = db.prepare("SELECT id FROM skills WHERE id = ?").get(skillId) as {
		id: string;
	} | null;

	if (!existing) {
		const skillMd = skill.files.find((f) => f.path === "SKILL.md");
		const contentHash = createHash("sha256")
			.update(skillMd?.content ?? "")
			.digest("hex");
		const metadata: Record<string, string> = {
			name: skill.name,
			description: skill.description,
		};
		if (skill.allowedTools) metadata.allowed_tools = skill.allowedTools;
		if (skill.compatibility) metadata.compatibility = skill.compatibility;

		insertRow(
			db,
			"skills",
			{
				id: skillId,
				name: skill.name,
				description: skill.description,
				status: "active",
				skill_root: skillRoot,
				content_hash: contentHash,
				allowed_tools: skill.allowedTools,
				compatibility: skill.compatibility,
				metadata_json: JSON.stringify(metadata),
				activated_at: now,
				created_by_thread: null,
				activation_count: 0,
				last_activated_at: null,
				retired_by: null,
				retired_reason: null,
				modified_at: now,
				deleted: 0,
			},
			siteId,
		);
	}
	// If row already exists (active or operator-retired): leave unchanged.
}

/**
 * Seed all bundled skills on startup.
 * Idempotent: safe to call on every boot.
 */
export function seedBundledSkills(db: Database, siteId: string): void {
	for (const skill of BUNDLED_SKILLS) {
		seedBundledSkill(db, siteId, skill);
	}
}
