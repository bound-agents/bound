import type { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { deleteSkill, importSkillFromFiles, parseFrontmatter } from "@bound/agent";
import {
	findFileContentByPathActive,
	findSkillById,
	findSkillByIdIncludingDeleted,
	listFileIdPathSizeByPrefixActive,
	listSkills,
	updateRow,
} from "@bound/core";
import type { Skill, SkillFileEntry } from "@bound/shared";
import { unzipSync } from "fflate";
import { Hono } from "hono";

export function createSkillsRoutes(db: Database): Hono {
	const app = new Hono();

	function getSiteId(): string {
		const row = db.query("SELECT value FROM host_meta WHERE key = 'site_id'").get() as
			| { value: string }
			| undefined;
		return row?.value ?? "unknown";
	}

	// GET / - List all skills
	app.get("/", (c) => {
		try {
			return c.json(listSkills(db));
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
				skill,
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

				// Assemble SKILL.md with YAML frontmatter
				let frontmatter = "---\n";
				if (body.name) frontmatter += `name: ${body.name}\n`;
				if (body.description) frontmatter += `description: ${body.description}\n`;
				if (body.allowed_tools) frontmatter += `allowed_tools: ${body.allowed_tools}\n`;
				if (body.compatibility) frontmatter += `compatibility: ${body.compatibility}\n`;
				frontmatter += "---\n";

				const skillContent = frontmatter + (body.body ?? "");
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

			// Load existing SKILL.md to extract current body if not provided
			const skillRoot = skill.skill_root ?? `skills/${skill.name}`;
			const skillMdPath = `${skillRoot}/SKILL.md`;
			const skillMdRow = findFileContentByPathActive(db, skillMdPath);

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
			let frontmatter = "---\n";
			frontmatter += `name: ${skill.name}\n`;
			frontmatter += `description: ${newDescription}\n`;
			if (newAllowedTools) frontmatter += `allowed_tools: ${newAllowedTools}\n`;
			if (newCompatibility) frontmatter += `compatibility: ${newCompatibility}\n`;
			frontmatter += "---\n";
			const newContent = frontmatter + newBody;

			const contentHash = createHash("sha256").update(newContent).digest("hex");
			const now = new Date().toISOString();

			// Update SKILL.md file if it exists
			if (skillMdRow) {
				updateRow(
					db,
					"files",
					skillMdPath,
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
