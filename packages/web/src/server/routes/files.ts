import type { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import { getSiteId, insertRow } from "@bound/core";
import type { AgentFile } from "@bound/shared";
import { Hono } from "hono";

/** MIME type prefixes and exact types considered text (not binary). */
const TEXT_MIME_PREFIXES = ["text/"];
const TEXT_MIME_EXACT = new Set([
	"application/json",
	"application/xml",
	"application/javascript",
	"application/typescript",
	"application/xhtml+xml",
	"application/x-yaml",
	"application/x-sh",
	"application/graphql",
]);

function isTextMime(mimeType: string): boolean {
	const base = mimeType.split(";")[0].trim().toLowerCase();
	return TEXT_MIME_PREFIXES.some((p) => base.startsWith(p)) || TEXT_MIME_EXACT.has(base);
}

/**
 * Store an uploaded file in the `files` table via the change-log outbox pattern.
 * Returns the new file ID.
 */
export async function storeFile(
	db: Database,
	siteId: string,
	opts: {
		name: string;
		mimeType: string;
		data: ArrayBuffer;
		createdBy: string;
		hostOrigin: string;
	},
): Promise<string> {
	const fileId = randomUUID();
	const now = new Date().toISOString();
	const filePath = `/home/user/uploads/${opts.name}`;

	const binary = !isTextMime(opts.mimeType);
	const sizeBytes = opts.data.byteLength;
	const content = binary
		? Buffer.from(opts.data).toString("base64")
		: new TextDecoder().decode(opts.data);

	insertRow(
		db,
		"files",
		{
			id: fileId,
			path: filePath,
			content,
			is_binary: binary ? 1 : 0,
			size_bytes: sizeBytes,
			created_at: now,
			modified_at: now,
			deleted: 0,
			created_by: opts.createdBy,
			host_origin: opts.hostOrigin,
		},
		siteId,
	);

	return fileId;
}

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

			const siteId = getSiteId(db);
			const fileId = await storeFile(db, siteId, {
				name: file.name,
				mimeType: file.type || "application/octet-stream",
				data: await file.arrayBuffer(),
				createdBy: "default_web_user",
				hostOrigin: "localhost:3000",
			});

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
