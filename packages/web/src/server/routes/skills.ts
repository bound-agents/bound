import type { Database } from "bun:sqlite";
import { importSkillFromFiles } from "@bound/agent";
import { updateRow } from "@bound/core";
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

	// GET / - List all skills (with optional status filter)
	app.get("/", (c) => {
		try {
			const status = c.req.query("status");

			let query = "SELECT * FROM skills WHERE deleted = 0";
			const params: string[] = [];

			if (status) {
				query += " AND status = ?";
				params.push(status);
			}

			const skills = db.query(query).all(...params) as Skill[];

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
			const skill = db
				.query("SELECT * FROM skills WHERE id = ? AND deleted = 0")
				.get(id) as Skill | null;

			if (!skill) {
				return c.json({ error: "Skill not found" }, 404);
			}

			// Query files for this skill
			const pattern = `skills/${skill.name}/%`;
			const files = db
				.query("SELECT id, path, size_bytes FROM files WHERE path LIKE ? AND deleted = 0")
				.all(pattern) as Array<{ id: string; path: string; size_bytes: number }>;

			// Find SKILL.md content
			const skillMdPath = `skills/${skill.name}/SKILL.md`;
			const skillMdRow = db
				.query("SELECT content FROM files WHERE path = ? AND deleted = 0")
				.get(skillMdPath) as { content: string } | null;

			const skillMdContent = skillMdRow?.content ?? "";

			// Build relative paths
			const relativeFiles = files.map((f) => {
				const relativePath = f.path.replace(`skills/${skill.name}/`, "");
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
			const skill = db.query("SELECT * FROM skills WHERE id = ?").get(result.skillId) as Skill;

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

	// POST /:id/retire - Retire a skill
	app.post("/:id/retire", async (c) => {
		try {
			const { id } = c.req.param();
			const siteId = getSiteId();

			// Query skill
			const skill = db
				.query("SELECT * FROM skills WHERE id = ? AND deleted = 0")
				.get(id) as Skill | null;

			if (!skill) {
				return c.json({ error: "Skill not found" }, 404);
			}

			// Parse optional body
			let body: { reason?: string } = {};
			try {
				body = (await c.req.json()) as { reason?: string };
			} catch {
				// No body or invalid JSON
			}

			// Update skill
			updateRow(
				db,
				"skills",
				id,
				{
					status: "retired",
					retired_reason: body.reason ?? null,
					retired_by: "web",
					modified_at: new Date().toISOString(),
				},
				siteId,
			);

			// Query updated skill
			const updated = db.query("SELECT * FROM skills WHERE id = ?").get(id) as Skill;

			return c.json({ skill: updated }, 200);
		} catch (error) {
			const message = error instanceof Error ? error.message : "Unknown error";
			return c.json(
				{
					error: "Failed to retire skill",
					details: message,
				},
				500,
			);
		}
	});

	// POST /:id/activate - Re-activate a retired skill
	app.post("/:id/activate", async (c) => {
		try {
			const { id } = c.req.param();
			const siteId = getSiteId();

			// Query skill
			const skill = db
				.query("SELECT * FROM skills WHERE id = ? AND deleted = 0")
				.get(id) as Skill | null;

			if (!skill) {
				return c.json({ error: "Skill not found" }, 404);
			}

			// Query skill files
			const pattern = `skills/${skill.name}/%`;
			const files = db
				.query("SELECT path, content FROM files WHERE path LIKE ? AND deleted = 0")
				.all(pattern) as Array<{ path: string; content: string }>;

			if (files.length === 0) {
				return c.json(
					{
						error: "Skill files not found. Re-import the skill.",
					},
					500,
				);
			}

			// Convert to SkillFileEntry[], stripping prefix
			const skillFiles: SkillFileEntry[] = files.map((f) => ({
				path: f.path.replace(`skills/${skill.name}/`, ""),
				content: f.content,
			}));

			// Re-import the skill via importSkillFromFiles
			// If it's a new import or update, this handles both
			const result = await importSkillFromFiles(db, siteId, skillFiles, {});

			if (!result.ok) {
				// If import fails due to name conflict, just update status instead
				// Mark skill as active and clear retired fields, increment activation_count
				updateRow(
					db,
					"skills",
					id,
					{
						status: "active",
						retired_by: null,
						retired_reason: null,
						activation_count: (skill.activation_count || 0) + 1,
						activated_at: new Date().toISOString(),
						modified_at: new Date().toISOString(),
					},
					siteId,
				);
			}

			// Query updated skill
			const updated = db.query("SELECT * FROM skills WHERE id = ?").get(id) as Skill;

			return c.json({ skill: updated }, 200);
		} catch (error) {
			const message = error instanceof Error ? error.message : "Unknown error";
			return c.json(
				{
					error: "Failed to activate skill",
					details: message,
				},
				500,
			);
		}
	});

	return app;
}
