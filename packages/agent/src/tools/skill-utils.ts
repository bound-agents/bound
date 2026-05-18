import type { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { insertRow, updateRow } from "@bound/core";
import { BOUND_NAMESPACE, deterministicUUID } from "@bound/shared";
import type { ImportSkillOptions, ImportSkillResult, SkillFileEntry } from "@bound/shared";

/**
 * Parse YAML frontmatter from a SKILL.md file.
 * Shared utility for both native skill tool and any other code that needs to parse skill frontmatter.
 */
export function parseFrontmatter(
	content: string,
): { data: Record<string, string>; body: string } | null {
	const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n([\s\S]*))?$/);
	if (!match) return null;
	const data: Record<string, string> = {};
	for (const line of match[1].split(/\r?\n/)) {
		const colonIndex = line.indexOf(":");
		if (colonIndex > 0) {
			data[line.slice(0, colonIndex).trim()] = line.slice(colonIndex + 1).trim();
		}
	}
	return { data, body: match[2] ?? "" };
}

// Validation constants
export const MAX_ACTIVE_SKILLS = 20;
export const MAX_SKILL_BODY_LINES = 500;
export const MAX_FILE_SIZE_BYTES = 64 * 1024;
export const MAX_DESCRIPTION_LENGTH = 1024;
export const SKILL_NAME_REGEX = /^[a-z0-9]+(-[a-z0-9]+)*$/;
export const MAX_SKILL_NAME_LENGTH = 64;

/**
 * Import and persist a skill from a file entry list.
 * Validates name, description, body, and file sizes.
 * Handles both new skill creation and re-activation of retired skills.
 */
export async function importSkillFromFiles(
	db: Database,
	siteId: string,
	files: SkillFileEntry[],
	options: ImportSkillOptions,
): Promise<ImportSkillResult> {
	try {
		// Step 1: Locate SKILL.md
		const skillMdEntry = files.find((f) => f.path === "SKILL.md");
		if (!skillMdEntry) {
			return { ok: false, error: "SKILL.md not found in file list" };
		}

		// Step 2: Parse frontmatter
		const parsed = parseFrontmatter(skillMdEntry.content);
		if (!parsed) {
			return { ok: false, error: "Invalid frontmatter in SKILL.md" };
		}

		const { data, body } = parsed;

		// Step 3: Validate name
		const name = data.name?.trim();
		if (!name) {
			return { ok: false, error: "Skill name is required" };
		}
		if (!SKILL_NAME_REGEX.test(name)) {
			return {
				ok: false,
				error: `Invalid skill name format. Must match pattern ${SKILL_NAME_REGEX.source}`,
			};
		}
		if (name.length > MAX_SKILL_NAME_LENGTH) {
			return {
				ok: false,
				error: `Skill name must be ≤ ${MAX_SKILL_NAME_LENGTH} characters`,
			};
		}

		// Step 4: Validate description
		const description = data.description?.trim();
		if (!description) {
			return { ok: false, error: "Skill description is required" };
		}
		if (description.length > MAX_DESCRIPTION_LENGTH) {
			return {
				ok: false,
				error: `Description must be ≤ ${MAX_DESCRIPTION_LENGTH} characters`,
			};
		}

		// Step 5: Validate body
		const bodyLines = body.split(/\r?\n/).length;
		if (bodyLines > MAX_SKILL_BODY_LINES) {
			return {
				ok: false,
				error: `Skill body must be ≤ ${MAX_SKILL_BODY_LINES} lines`,
			};
		}

		// Step 6: Validate total size
		const totalSize = files.reduce((sum, f) => sum + Buffer.byteLength(f.content, "utf8"), 0);
		if (totalSize > MAX_FILE_SIZE_BYTES) {
			return {
				ok: false,
				error: `Total file size must be ≤ ${MAX_FILE_SIZE_BYTES} bytes`,
			};
		}

		// Step 7: Check active skill cap
		const activeCount = db
			.prepare("SELECT COUNT(*) as count FROM skills WHERE status = 'active' AND deleted = 0")
			.get() as { count: number };

		const skillId = deterministicUUID(BOUND_NAMESPACE, name);
		const existingSkill = db
			.prepare("SELECT * FROM skills WHERE id = ? AND deleted = 0")
			.get(skillId) as Record<string, unknown> | null;

		if (activeCount.count >= MAX_ACTIVE_SKILLS && !existingSkill) {
			return {
				ok: false,
				error: `Active skill cap (${MAX_ACTIVE_SKILLS}) reached. Retire a skill before creating a new one.`,
			};
		}

		// Step 8: Compute deterministic UUID (already done above)
		// Step 9: Compute content_hash
		const contentHash = createHash("sha256").update(skillMdEntry.content).digest("hex");

		// Step 10: Check existing skill
		const now = new Date().toISOString();

		if (existingSkill) {
			const existingAsSkill = existingSkill as Record<string, unknown> & {
				status: string;
				activation_count: number;
			};
			if (existingAsSkill.status === "retired") {
				// Re-activation
				updateRow(
					db,
					"skills",
					skillId,
					{
						status: "active",
						content_hash: contentHash,
						activation_count: existingAsSkill.activation_count + 1,
						last_activated_at: now,
						activated_at: now,
						modified_at: now,
						description,
						allowed_tools: data.allowed_tools ?? null,
						compatibility: data.compatibility ?? null,
						retired_by: null,
						retired_reason: null,
					},
					siteId,
				);
			} else {
				// Content update (already active)
				updateRow(
					db,
					"skills",
					skillId,
					{
						content_hash: contentHash,
						modified_at: now,
						description,
						allowed_tools: data.allowed_tools ?? null,
						compatibility: data.compatibility ?? null,
						metadata_json: JSON.stringify(data),
						activation_count: existingAsSkill.activation_count + 1,
						last_activated_at: now,
					},
					siteId,
				);
			}
		} else {
			// New skill creation
			insertRow(
				db,
				"skills",
				{
					id: skillId,
					name,
					description,
					status: "active",
					skill_root: `skills/${name}`,
					content_hash: contentHash,
					allowed_tools: data.allowed_tools ?? null,
					compatibility: data.compatibility ?? null,
					metadata_json: JSON.stringify(data),
					activated_at: now,
					created_by_thread: options.threadId ?? null,
					activation_count: 1,
					last_activated_at: now,
					retired_by: null,
					retired_reason: null,
					modified_at: now,
					deleted: 0,
				},
				siteId,
			);
		}

		// Step 11: Persist files
		for (const entry of files) {
			const filePath = `skills/${name}/${entry.path}`;
			const fileId = filePath;
			const sizeBytes = Buffer.byteLength(entry.content, "utf8");

			const existingFile = db
				.prepare("SELECT id FROM files WHERE id = ? AND deleted = 0")
				.get(fileId) as Record<string, unknown> | null;

			if (existingFile) {
				updateRow(
					db,
					"files",
					fileId,
					{
						content: entry.content,
						size_bytes: sizeBytes,
						modified_at: now,
					},
					siteId,
				);
			} else {
				insertRow(
					db,
					"files",
					{
						id: fileId,
						path: filePath,
						content: entry.content,
						is_binary: 0,
						size_bytes: sizeBytes,
						created_at: now,
						modified_at: now,
						deleted: 0,
						created_by: options.threadId ?? null,
						host_origin: null,
					},
					siteId,
				);
			}
		}

		// Step 12: Return success
		return { ok: true, skillId, name };
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		return { ok: false, error: `Failed to import skill: ${message}` };
	}
}
