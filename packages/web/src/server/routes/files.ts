import type { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import { getSiteId, insertRow } from "@bound/core";
import { type AgentFile, MAX_FILE_STORAGE_BYTES } from "@bound/shared";
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

/** File extension to MIME type mapping. */
const EXTENSION_MIME_MAP: Record<string, string> = {
	".txt": "text/plain",
	".md": "text/markdown",
	".json": "application/json",
	".xml": "application/xml",
	".html": "text/html",
	".htm": "text/html",
	".css": "text/css",
	".js": "application/javascript",
	".ts": "application/typescript",
	".jsx": "application/javascript",
	".tsx": "application/typescript",
	".py": "text/x-python",
	".sh": "application/x-sh",
	".bash": "application/x-sh",
	".png": "image/png",
	".jpg": "image/jpeg",
	".jpeg": "image/jpeg",
	".gif": "image/gif",
	".svg": "image/svg+xml",
	".pdf": "application/pdf",
	".zip": "application/zip",
	".tar": "application/x-tar",
	".gz": "application/gzip",
	".csv": "text/csv",
	".yaml": "application/x-yaml",
	".yml": "application/x-yaml",
};

function isTextMime(mimeType: string): boolean {
	const base = mimeType.split(";")[0].trim().toLowerCase();
	return TEXT_MIME_PREFIXES.some((p) => base.startsWith(p)) || TEXT_MIME_EXACT.has(base);
}

/**
 * Detect MIME type from file extension.
 * Returns the mapped MIME type or "application/octet-stream" as default.
 */
function detectMimeType(path: string): string {
	const ext = path.substring(path.lastIndexOf(".")).toLowerCase();
	return EXTENSION_MIME_MAP[ext] || "application/octet-stream";
}

/**
 * Get filename from a path.
 */
function getFilename(path: string): string {
	return path.substring(path.lastIndexOf("/") + 1);
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
	// Sanitize filename: strip directory components and traversal sequences
	const safeName =
		opts.name.replace(/\.\./g, "").replace(/[/\\]/g, "_").replace(/^_+/, "") || "unnamed";
	const filePath = `/home/user/uploads/${safeName}`;

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

			// Strip content field from each file in response
			const filesWithoutContent = files.map((file) => {
				const { content: _, ...fileWithoutContent } = file;
				return fileWithoutContent;
			});

			return c.json(filesWithoutContent);
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

	app.get("/download/:id", (c) => {
		try {
			const fileId = c.req.param("id");

			const file = db
				.query(
					`
				SELECT * FROM files
				WHERE id = ? AND deleted = 0
			`,
				)
				.get(fileId) as AgentFile | null;

			if (!file) {
				return c.json(
					{
						error: "File not found",
					},
					404,
				);
			}

			if (file.content === null) {
				return c.json(
					{
						error: "File content not available",
					},
					404,
				);
			}

			const mimeType = detectMimeType(file.path);
			const filename = getFilename(file.path);

			let responseBody: string | Blob;
			if (file.is_binary === 1) {
				// Decode base64 to binary
				responseBody = new Blob([Buffer.from(file.content, "base64")]);
			} else {
				// Return text as-is
				responseBody = file.content;
			}

			// Sanitize filename for Content-Disposition header to prevent injection
			const safeFilename = filename.replace(/["\\\r\n]/g, "_");

			return new Response(responseBody, {
				headers: {
					"Content-Type": mimeType,
					"Content-Disposition": `attachment; filename="${safeFilename}"`,
				},
			});
		} catch (error) {
			const message = error instanceof Error ? error.message : "Unknown error";
			return c.json(
				{
					error: "Failed to download file",
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

			if (file.size > MAX_FILE_STORAGE_BYTES) {
				return c.json(
					{
						error: "File too large",
						details: `Maximum file size is ${MAX_FILE_STORAGE_BYTES / (1024 * 1024)}MB`,
					},
					413,
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
