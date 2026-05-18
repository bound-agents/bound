import type { Database } from "bun:sqlite";
import type { Skill } from "@bound/shared";
import { Hono } from "hono";

export function createSkillsRoutes(db: Database): Hono {
	const app = new Hono();

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

	return app;
}
