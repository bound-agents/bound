import type { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import {
	deleteSkill,
	importSkillFromFiles,
	isBuiltinSkillId,
	parseFrontmatter,
} from "@bound/agent";
import {
	findFileContentByPathActive,
	findFileIdContentByPathActive,
	findSkillById,
	findSkillByIdIncludingDeleted,
	getHostMetaSiteId,
	listFileIdPathSizeByPrefixActive,
	listSkills,
	updateRow,
} from "@bound/core";
import type { Skill, SkillFileEntry } from "@bound/shared";
import { unzipSync } from "fflate";
import { Hono } from "hono";

export const MAX_SKILL_DESCRIPTION_LENGTH = 1024;

/**
 * Serialize a frontmatter scalar as a double-quoted YAML string. JSON string
 * syntax is a subset of YAML double-quoted scalars, so newlines, colons, and
 * quotes stay inside the value and cannot open a new key.
 */
export function yamlScalar(value: string): string {
	return JSON.stringify(value);
}

export function buildSkillFrontmatter(fields: {
	name?: string;
	description?: string;
	allowed_tools?: string;
	compatibility?: string;
}): string {
	let frontmatter = "---\n";
	if (fields.name) frontmatter += `name: ${yamlScalar(fields.name)}\n`;
	if (fields.description) frontmatter += `description: ${yamlScalar(fields.description)}\n`;
	if (fields.allowed_tools) frontmatter += `allowed_tools: ${yamlScalar(fields.allowed_tools)}\n`;
	if (fields.compatibility) frontmatter += `compatibility: ${yamlScalar(fields.compatibility)}\n`;
	return `${frontmatter}---\n`;
}

function descriptionTooLong(description: unknown): boolean {
	return typeof description === "string" && description.length > MAX_SKILL_DESCRIPTION_LENGTH;
}

const DESCRIPTION_TOO_LONG_ERROR = `description must be at most ${MAX_SKILL_DESCRIPTION_LENGTH} characters`;

export function createSkillsRoutes(db: Database): Hono {
	const app = new Hono();

	function getSiteId(): string {
		return getHostMetaSiteId(db);
	}

	// GET / - List all skills
	app.get("/", (c) => {
		try {
			const skills = listSkills(db).map((skill) => ({
				...skill,
				is_builtin: isBuiltinSkillId(skill.id),
			}));
			return c.json(skills);
		} catch (error) {
			const message = error instanceof Error ? error.message : "Unknown error";
			return c.json(
				{
					error: "Failed to list skills",
					details: message,
				},
				500,
			);
		}
	});

	// GET /:id - Get skill detail + content + file list
	app.get("/:id", (c) => {
		try {
			const { id } = c.req.param();

			// Query skill row
			const skill = findSkillById(db, id);

			if (!skill) {
				return c.json({ error: "Skill not found" }, 404);
			}

			// Use skill_root when set (e.g. seeded skills store files at an absolute VFS path
			// like /home/user/skills/<name>); fall back to canonical relative path that
			// importSkillFromFiles uses. Matches the pattern in context-assembly.ts.
			const skillRoot = skill.skill_root ?? `skills/${skill.name}`;

			// Query files for this skill
			const pattern = `${skillRoot}/%`;
			const files = listFileIdPathSizeByPrefixActive(db, pattern);

			// Find SKILL.md content
			const skillMdPath = `${skillRoot}/SKILL.md`;
			const skillMdRow = findFileContentByPathActive(db, skillMdPath);

			const skillMdContent = skillMdRow?.content ?? "";

			// Build relative paths
			const relativeFiles = files.map((f) => {
				const relativePath = f.path.replace(`${skillRoot}/`, "");
				return {
					path: relativePath,
					size: f.size_bytes,
				};
			});

			return c.json({
				skill: { ...skill, is_builtin: isBuiltinSkillId(skill.id) },
				content: skillMdContent,
				files: relativeFiles,
			});
		} catch (error) {
			const message = error instanceof Error ? error.message : "Unknown error";
			return c.json(
				{
					error: "Failed to get skill",
					details: message,
				},
				500,
			);
		}
	});

	// POST / - Create skill from JSON body or multipart upload
	app.post("/", async (c) => {
		try {
			const siteId = getSiteId();
			const contentType = c.req.header("Content-Type") ?? "";

			let files: SkillFileEntry[] = [];

			// Handle JSON body
			if (contentType.includes("application/json")) {
				const body = (await c.req.json()) as {
					name?: string;
					description?: string;
					body?: string;
					allowed_tools?: string;
					compatibility?: string;
				};

				if (descriptionTooLong(body.description)) {
					return c.json({ error: DESCRIPTION_TOO_LONG_ERROR }, 400);
				}

				// Assemble SKILL.md with YAML frontmatter (scalars quoted)
				const skillContent = buildSkillFrontmatter(body) + (body.body ?? "");
				files = [{ path: "SKILL.md", content: skillContent }];
			} else if (contentType.includes("multipart/form-data")) {
				// Handle multipart upload
				const formData = await c.req.formData();
				const file = formData.get("skillfile");

				if (!file || !(file instanceof File)) {
					return c.json({ error: "No file uploaded" }, 400);
				}

				// Determine file type and process
				if (file.name.endsWith(".md")) {
					// Single .md file
					const content = await file.text();
					files = [{ path: "SKILL.md", content }];
				} else if (file.name.endsWith(".zip")) {
					// Zip file
					try {
						const zipData = new Uint8Array(await file.arrayBuffer());
						const extracted = unzipSync(zipData);

						// Security: validate paths
						for (const path of Object.keys(extracted)) {
							if (
								path.includes("../") ||
								path.startsWith("/") ||
								path.includes("\0") ||
								path.includes("\\")
							) {
								return c.json(
									{
										error: "Invalid zip: path traversal detected",
										details: path,
									},
									400,
								);
							}
						}

						// Validate SKILL.md exists
						if (!extracted["SKILL.md"]) {
							return c.json(
								{
									error: "Zip must contain SKILL.md at root",
								},
								400,
							);
						}

						// Size validation
						let totalSize = 0;
						for (const data of Object.values(extracted)) {
							totalSize += data.length;
						}
						if (totalSize > 64 * 1024) {
							return c.json(
								{
									error: "Zip contents exceed 64KB limit",
								},
								400,
							);
						}

						// Convert to SkillFileEntry[]
						files = Object.entries(extracted).map(([path, data]) => ({
							path,
							content: new TextDecoder().decode(data),
						}));
					} catch (error) {
						const message = error instanceof Error ? error.message : "Unknown error";
						return c.json(
							{
								error: "Failed to extract zip",
								details: message,
							},
							400,
						);
					}
				} else {
					return c.json({ error: "File must be .md or .zip" }, 400);
				}
			} else {
				return c.json({ error: "Invalid Content-Type" }, 400);
			}

			// Import the skill
			const result = await importSkillFromFiles(db, siteId, files, {});

			if (!result.ok) {
				return c.json({ error: result.error }, 400);
			}

			// Query the created skill
			const skill = findSkillByIdIncludingDeleted(db, result.skillId) as Skill;

			return c.json({ skill }, 201);
		} catch (error) {
			const message = error instanceof Error ? error.message : "Unknown error";
			return c.json(
				{
					error: "Failed to create skill",
					details: message,
				},
				500,
			);
		}
	});

	// PATCH /:id - Update skill content (name is read-only)
	app.patch("/:id", async (c) => {
		try {
			const { id } = c.req.param();
			const siteId = getSiteId();

			const skill = findSkillById(db, id);

			if (!skill) {
				return c.json({ error: "Skill not found" }, 404);
			}

			const body = (await c.req.json()) as {
				description?: string;
				body?: string;
				allowed_tools?: string;
				compatibility?: string;
			};

			if (descriptionTooLong(body.description)) {
				return c.json({ error: DESCRIPTION_TOO_LONG_ERROR }, 400);
			}

			// Load existing SKILL.md to extract current body if not provided
			const skillRoot = skill.skill_root ?? `skills/${skill.name}`;
			const skillMdPath = `${skillRoot}/SKILL.md`;
			// files PK is `id`, not `path`: resolve the row id so the update
			// lands on rows whose id differs from their path (seeded skills).
			const skillMdRow = findFileIdContentByPathActive(db, skillMdPath);

			const parsed = skillMdRow ? parseFrontmatter(skillMdRow.content ?? "") : null;
			const currentBody = parsed?.body ?? "";

			// Merge new values over existing
			const newDescription = body.description ?? skill.description;
			const newAllowedTools =
				body.allowed_tools !== undefined ? body.allowed_tools : (skill.allowed_tools ?? "");
			const newCompatibility =
				body.compatibility !== undefined ? body.compatibility : (skill.compatibility ?? "");
			const newBody = body.body !== undefined ? body.body : currentBody;

			// Reconstruct SKILL.md
			const newContent =
				buildSkillFrontmatter({
					name: skill.name,
					description: newDescription,
					allowed_tools: newAllowedTools,
					compatibility: newCompatibility,
				}) + newBody;

			const contentHash = createHash("sha256").update(newContent).digest("hex");
			const now = new Date().toISOString();

			// Update SKILL.md file if it exists
			if (skillMdRow) {
				updateRow(
					db,
					"files",
					skillMdRow.id,
					{
						content: newContent,
						size_bytes: Buffer.byteLength(newContent, "utf8"),
						modified_at: now,
					},
					siteId,
				);
			}

			// Update skill row
			updateRow(
				db,
				"skills",
				id,
				{
					description: newDescription,
					allowed_tools: newAllowedTools || null,
					compatibility: newCompatibility || null,
					content_hash: contentHash,
					modified_at: now,
				},
				siteId,
			);

			const updated = findSkillByIdIncludingDeleted(db, id) as Skill;
			return c.json({ skill: updated }, 200);
		} catch (error) {
			const message = error instanceof Error ? error.message : "Unknown error";
			return c.json({ error: "Failed to update skill", details: message }, 500);
		}
	});

	// DELETE /:id - Delete a skill (any status): soft-delete row + files, R-SK14 advisory scan
	app.delete("/:id", (c) => {
		try {
			const { id } = c.req.param();
			const siteId = getSiteId();

			const skill = findSkillById(db, id);

			if (!skill) {
				return c.json({ error: "Skill not found" }, 404);
			}

			// Unified removal (any status): soft-deletes the row + its files and files
			// task-reference advisories. Shared with boundctl and the agent core.
			deleteSkill(db, siteId, skill.name, { by: "web" });

			return new Response(null, { status: 204 });
		} catch (error) {
			const message = error instanceof Error ? error.message : "Unknown error";
			return c.json(
				{
					error: "Failed to delete skill",
					details: message,
				},
				500,
			);
		}
	});

	return app;
}
