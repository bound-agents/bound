import { createHash } from "node:crypto";
import type { Database } from "bun:sqlite";
import { insertRow, updateRow } from "@bound/core";
import { BOUND_NAMESPACE, deterministicUUID } from "@bound/shared";
import {
	SKILL_AUTHORING_FORMAT_REFERENCE_MD,
	SKILL_AUTHORING_SKILL_MD,
} from "./bundled-skills";

/**
 * Seed a file into the files table if missing or stale (content hash differs).
 * Follows the autoCacheFile pattern from packages/sandbox/src/cluster-fs.ts.
 */
function seedFile(
	db: Database,
	siteId: string,
	path: string,
	content: string,
): void {
	const contentHash = createHash("sha256").update(content).digest("hex");
	const sizeBytes = Buffer.byteLength(content, "utf8");
	const now = new Date().toISOString();

	const existing = db
		.prepare(
			"SELECT id, content FROM files WHERE path = ? AND deleted = 0",
		)
		.get(path) as { id: string; content: string | null } | null;

	if (existing) {
		const existingHash = createHash("sha256")
			.update(existing.content ?? "")
			.digest("hex");
		if (existingHash !== contentHash) {
			// Content changed (e.g., updated bundled-skills.ts) — restore/update
			updateRow(
				db,
				"files",
				existing.id,
				{ content, size_bytes: sizeBytes, modified_at: now },
				siteId,
			);
		}
		// else: content unchanged, skip update (no-op)
	} else {
		// File missing (e.g., deleted from files table) — restore
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
			},
			siteId,
		);
	}
}

/**
 * Seed the bundled skill-authoring skill on startup.
 * Idempotent: safe to call on every boot.
 *
 * Behavior:
 * - Files: Always restores if missing or stale (AC5.1, AC5.4, AC5.5)
 * - Skills row: Only inserts if no row exists for skill-authoring ID.
 *   If operator retired skill-authoring, leaves it retired (AC5.3).
 */
export function seedSkillAuthoring(db: Database, siteId: string): void {
	const skillName = "skill-authoring";
	const skillRoot = `/home/user/skills/${skillName}`;
	const skillId = deterministicUUID(BOUND_NAMESPACE, skillName);
	const now = new Date().toISOString();

	// Step 1: Restore skill files if missing or stale (AC5.1, AC5.4, AC5.5)
	seedFile(db, siteId, `${skillRoot}/SKILL.md`, SKILL_AUTHORING_SKILL_MD);
	seedFile(
		db,
		siteId,
		`${skillRoot}/references/format-reference.md`,
		SKILL_AUTHORING_FORMAT_REFERENCE_MD,
	);

	// Step 2: Insert skills row only if it does not already exist (AC5.2, AC5.3)
	// Equivalent to INSERT OR IGNORE — change-log compliant version.
	const existing = db
		.prepare("SELECT id FROM skills WHERE id = ?")
		.get(skillId) as { id: string } | null;

	if (!existing) {
		const contentHash = createHash("sha256")
			.update(SKILL_AUTHORING_SKILL_MD)
			.digest("hex");

		insertRow(
			db,
			"skills",
			{
				id: skillId,
				name: skillName,
				description:
					"Author, activate, and manage reusable instruction sets called skills.",
				status: "active",
				skill_root: skillRoot,
				content_hash: contentHash,
				allowed_tools:
					"skill-activate skill-list skill-read skill-retire bash",
				compatibility: null,
				metadata_json: JSON.stringify({
					name: skillName,
					description:
						"Author, activate, and manage reusable instruction sets called skills.",
					allowed_tools:
						"skill-activate skill-list skill-read skill-retire bash",
				}),
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
