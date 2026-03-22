import type { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import type { AgentFile } from "@bound/shared";
import { Hono } from "hono";

export function createFilesRoutes(db: Database): Hono {
	const app = new Hono();

	app.get("/", (c) => {
		try {
			const files = db
				.query(
					`
				SELECT * FROM files
				WHERE deleted = 0
				ORDER BY created_at DESC
			`,
				)
				.all() as AgentFile[];

			return c.json(files);
		} catch (error) {
			const message = error instanceof Error ? error.message : "Unknown error";
			return c.json(
				{
					error: "Failed to list files",
					details: message,
				},
				500,
			);
		}
	});

	app.get("/*", (c) => {
		try {
			const path = c.req.path.replace(/^\/api\/files\/?/, "") || "/";

			const file = db
				.query(
					`
				SELECT * FROM files
				WHERE path = ? AND deleted = 0
			`,
				)
				.get(path) as AgentFile | undefined;

			if (!file) {
				return c.json(
					{
						error: "File not found",
					},
					404,
				);
			}

			return c.json(file);
		} catch (error) {
			const message = error instanceof Error ? error.message : "Unknown error";
			return c.json(
				{
					error: "Failed to get file",
					details: message,
				},
				500,
			);
		}
	});

	app.post("/upload", async (c) => {
		try {
			const formData = await c.req.formData();
			const file = formData.get("file");

			if (!file || !(file instanceof File)) {
				return c.json(
					{
						error: "Invalid request body",
						details: "file field is required",
					},
					400,
				);
			}

			const fileId = randomUUID();
			const now = new Date().toISOString();
			const filePath = `/home/user/uploads/${file.name}`;
			const fileContent = await file.text();
			const fileSize = fileContent.length;

			db.run(
				`
				INSERT INTO files (
					id, path, content, is_binary, size_bytes,
					created_at, modified_at, deleted, created_by, host_origin
				) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
			`,
				[
					fileId,
					filePath,
					fileContent,
					0,
					fileSize,
					now,
					now,
					0,
					"default_web_user",
					"localhost:3000",
				],
			);

			const result = db.query("SELECT * FROM files WHERE id = ?").get(fileId) as AgentFile;

			return c.json(result, 201);
		} catch (error) {
			const message = error instanceof Error ? error.message : "Unknown error";
			return c.json(
				{
					error: "Failed to upload file",
					details: message,
				},
				500,
			);
		}
	});

	return app;
}
