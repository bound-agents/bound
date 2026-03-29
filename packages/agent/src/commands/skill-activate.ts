import { createHash } from "node:crypto";
import { insertRow, updateRow } from "@bound/core";
import type { CommandContext, CommandDefinition } from "@bound/sandbox";
import { BOUND_NAMESPACE, deterministicUUID } from "@bound/shared";
import { commandError, commandSuccess, handleCommandError } from "./helpers";

const MAX_ACTIVE_SKILLS = 20;
const MAX_SKILL_BODY_LINES = 500;
const MAX_FILE_SIZE_BYTES = 64 * 1024; // 64 KB
const MAX_DESCRIPTION_LENGTH = 1024;
const SKILL_NAME_REGEX = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const MAX_SKILL_NAME_LENGTH = 64;

// Out of scope (not in design plan, deferred):
// - R-SK12: FS_PERSIST content_hash update when files are modified post-activation
// - R-SK15: Namespace collision check against built-in command names / MCP server names
// - R-SK15: Directory total size limit (500 KB) -- deferred per design plan
// - R-SK15: allowed_tools validation warning -- deferred per design plan

/**
 * Parse YAML frontmatter from a SKILL.md file.
 * Exported so packages/cli/src/commands/skill.ts can import it (DRY).
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

export const skillActivate: CommandDefinition = {
	name: "skill-activate",
	args: [
		{
			name: "name",
			required: true,
			description: "Skill directory name under /home/user/skills/",
		},
	],
	handler: async (args: Record<string, string>, ctx: CommandContext) => {
		try {
			if (!ctx.fs) {
				return commandError("Filesystem unavailable: ctx.fs is not set");
			}

			const name = args.name;
			const skillRoot = `/home/user/skills/${name}`;
			const skillMdPath = `${skillRoot}/SKILL.md`;

			// Validate skill name format (S6.1)
			if (!SKILL_NAME_REGEX.test(name)) {
				return commandError(
					`Invalid skill name '${name}': must match ^[a-z0-9]+(-[a-z0-9]+)*$ (lowercase alphanumeric, hyphens allowed between segments)\n`,
				);
			}
			if (name.length > MAX_SKILL_NAME_LENGTH) {
				return commandError(
					`Skill name '${name}' exceeds maximum length of ${MAX_SKILL_NAME_LENGTH} characters\n`,
				);
			}

			// Read SKILL.md
			let content: string;
			try {
				content = await ctx.fs.readFile(skillMdPath);
			} catch {
				return commandError(
					`Skill '${name}' not found: missing ${skillMdPath}\n`,
				);
			}

			// Validate file size
			const sizeBytes = Buffer.byteLength(content, "utf8");
			if (sizeBytes > MAX_FILE_SIZE_BYTES) {
				return commandError(
					`SKILL.md exceeds 64 KB size limit (${sizeBytes} bytes)\n`,
				);
			}

			// Parse frontmatter
			const parsed = parseFrontmatter(content);
			if (!parsed) {
				return commandError(
					"SKILL.md is missing required YAML frontmatter (---...---)\n",
				);
			}

			const { data, body } = parsed;

			// Validate name matches directory
			if (data.name && data.name !== name) {
				return commandError(
					`Frontmatter 'name' field ('${data.name}') does not match directory name ('${name}')\n`,
				);
			}

			// Validate description is present and within length limit (S6.1)
			if (!data.description) {
				return commandError(
					"SKILL.md is missing required 'description' field in frontmatter\n",
				);
			}
			if (data.description.length > MAX_DESCRIPTION_LENGTH) {
				return commandError(
					`Description exceeds ${MAX_DESCRIPTION_LENGTH} character limit (${data.description.length} chars)\n`,
				);
			}

			// Validate body line count
			const bodyLines = body.split("\n").length;
			if (bodyLines > MAX_SKILL_BODY_LINES) {
				return commandError(
					`SKILL.md body exceeds ${MAX_SKILL_BODY_LINES} lines (${bodyLines} lines)\n`,
				);
			}

			// Check active skill cap — do not count the skill being (re-)activated itself
			const skillId = deterministicUUID(BOUND_NAMESPACE, name);
			const capRow = ctx.db
				.prepare(
					"SELECT COUNT(*) as count FROM skills WHERE status = 'active' AND deleted = 0 AND id != ?",
				)
				.get(skillId) as { count: number };
			if (capRow.count >= MAX_ACTIVE_SKILLS) {
				return commandError(
					`Active skill cap reached (${MAX_ACTIVE_SKILLS} maximum). Retire a skill before activating another.\n`,
				);
			}

			const now = new Date().toISOString();

			// R-SK13: Early file persistence — write all skill files to files table BEFORE upserting skills row
			const allPaths = ctx.fs
				.getAllPaths()
				.filter((p) => p.startsWith(skillRoot + "/"));
			for (const filePath of allPaths) {
				let fileContent: string;
				try {
					fileContent = await ctx.fs.readFile(filePath);
				} catch {
					continue; // skip unreadable entries (e.g., directories)
				}
				const fileSize = Buffer.byteLength(fileContent, "utf8");
				const fileHash = createHash("sha256").update(fileContent).digest("hex");

				const existingFile = ctx.db
					.prepare(
						"SELECT id, content FROM files WHERE path = ? AND deleted = 0",
					)
					.get(filePath) as { id: string; content: string } | null;

				if (existingFile) {
					const existingHash = createHash("sha256")
						.update(existingFile.content ?? "")
						.digest("hex");
					if (existingHash !== fileHash) {
						updateRow(
							ctx.db,
							"files",
							existingFile.id,
							{ content: fileContent, size_bytes: fileSize, modified_at: now },
							ctx.siteId,
						);
					}
				} else {
					insertRow(
						ctx.db,
						"files",
						{
							id: filePath,
							path: filePath,
							content: fileContent,
							is_binary: 0,
							size_bytes: fileSize,
							created_at: now,
							modified_at: now,
							deleted: 0,
						},
						ctx.siteId,
					);
				}
			}

			// Upsert skills row — after files are persisted
			const contentHash = createHash("sha256").update(content).digest("hex");
			const existing = ctx.db
				.prepare("SELECT id, activation_count FROM skills WHERE id = ?")
				.get(skillId) as { id: string; activation_count: number } | null;

			if (existing) {
				updateRow(
					ctx.db,
					"skills",
					skillId,
					{
						description: data.description,
						status: "active",
						skill_root: skillRoot,
						content_hash: contentHash,
						allowed_tools: data.allowed_tools ?? null,
						compatibility: data.compatibility ?? null,
						metadata_json: JSON.stringify(data),
						activated_at: now,
						activation_count: (existing.activation_count ?? 0) + 1,
						last_activated_at: now,
						retired_by: null,
						retired_reason: null,
						modified_at: now,
						deleted: 0,
					},
					ctx.siteId,
				);
			} else {
				insertRow(
					ctx.db,
					"skills",
					{
						id: skillId,
						name,
						description: data.description,
						status: "active",
						skill_root: skillRoot,
						content_hash: contentHash,
						allowed_tools: data.allowed_tools ?? null,
						compatibility: data.compatibility ?? null,
						metadata_json: JSON.stringify(data),
						activated_at: now,
						created_by_thread: ctx.threadId ?? null,
						activation_count: 1,
						last_activated_at: now,
						retired_by: null,
						retired_reason: null,
						modified_at: now,
						deleted: 0,
					},
					ctx.siteId,
				);
			}

			return commandSuccess(`Skill '${name}' activated successfully.\n`);
		} catch (error) {
			return handleCommandError(error);
		}
	},
};
