import { Database } from "bun:sqlite";
import { beforeEach, describe, expect, it } from "bun:test";
import { applySchema } from "@bound/core";
import { createFilesRoutes, storeFile } from "../files";

function buf(s: string): ArrayBuffer {
	return new TextEncoder().encode(s).buffer as ArrayBuffer;
}

describe("storeFile — content-hash dedup (#159)", () => {
	let db: Database;
	const siteId = "test-site";
	const base = {
		mimeType: "application/pdf",
		createdBy: "u",
		hostOrigin: "h",
	};

	beforeEach(() => {
		db = new Database(":memory:");
		applySchema(db);
	});

	it("no-ops to the existing row when identical content is re-uploaded under the same name", async () => {
		const id1 = await storeFile(db, siteId, { ...base, name: "report.pdf", data: buf("hello") });
		const id2 = await storeFile(db, siteId, { ...base, name: "report.pdf", data: buf("hello") });
		expect(id2).toBe(id1);
		const rows = db.query("SELECT id FROM files WHERE deleted = 0").all();
		expect(rows.length).toBe(1);
	});

	it("creates distinct rows for the same name with different content", async () => {
		const id1 = await storeFile(db, siteId, { ...base, name: "report.pdf", data: buf("v1") });
		const id2 = await storeFile(db, siteId, { ...base, name: "report.pdf", data: buf("v2") });
		expect(id2).not.toBe(id1);
		const paths = (
			db.query("SELECT path FROM files WHERE deleted = 0").all() as { path: string }[]
		).map((r) => r.path);
		expect(new Set(paths).size).toBe(2);
	});

	it("inserts the content hash before the extension", async () => {
		const id = await storeFile(db, siteId, { ...base, name: "report.pdf", data: buf("hello") });
		const row = db.query("SELECT path FROM files WHERE id = ?").get(id) as { path: string };
		expect(row.path).toMatch(/\/home\/user\/uploads\/report\.[0-9a-f]+\.pdf$/);
	});

	it("handles extensionless names by appending the hash", async () => {
		const id = await storeFile(db, siteId, { ...base, name: "LICENSE", data: buf("x") });
		const row = db.query("SELECT path FROM files WHERE id = ?").get(id) as { path: string };
		expect(row.path).toMatch(/\/home\/user\/uploads\/LICENSE\.[0-9a-f]+$/);
	});
});

describe("files routes", () => {
	let db: Database;
	const siteId = "test-site";
	let app: ReturnType<typeof createFilesRoutes>;

	beforeEach(() => {
		db = new Database(":memory:");
		applySchema(db);
		db.prepare("INSERT INTO host_meta (key, value) VALUES (?, ?)").run("site_id", siteId);
		app = createFilesRoutes(db);
	});

	describe("GET /", () => {
		it("lists files without their content field", async () => {
			await storeFile(db, siteId, {
				name: "a.txt",
				mimeType: "text/plain",
				data: new TextEncoder().encode("hi").buffer as ArrayBuffer,
				createdBy: "u",
				hostOrigin: "h",
			});
			const res = await app.request("/");
			expect(res.status).toBe(200);
			const body = (await res.json()) as Array<Record<string, unknown>>;
			expect(body).toHaveLength(1);
			expect(body[0]).not.toHaveProperty("content");
			expect(body[0].path).toContain("a.");
		});

		it("500s when the list query throws", async () => {
			db.close();
			const res = await app.request("/");
			expect(res.status).toBe(500);
			expect((await res.json()).error).toBe("Failed to list files");
		});
	});

	describe("GET /download", () => {
		it("400s when neither path nor id is given", async () => {
			const res = await app.request("/download");
			expect(res.status).toBe(400);
			expect((await res.json()).error).toContain("path or id");
		});

		it("downloads a text file by id with a sanitized filename", async () => {
			const id = await storeFile(db, siteId, {
				name: "notes.txt",
				mimeType: "text/plain",
				data: new TextEncoder().encode("body text").buffer as ArrayBuffer,
				createdBy: "u",
				hostOrigin: "h",
			});
			const res = await app.request(`/download?id=${id}`);
			expect(res.status).toBe(200);
			expect(res.headers.get("Content-Disposition")).toContain("attachment");
			expect(await res.text()).toBe("body text");
		});

		it("downloads a binary file by path decoded from base64", async () => {
			const bytes = new Uint8Array([0, 255, 65]);
			const id = await storeFile(db, siteId, {
				name: "blob.bin",
				mimeType: "application/octet-stream",
				data: bytes.buffer as ArrayBuffer,
				createdBy: "u",
				hostOrigin: "h",
			});
			const row = db.query("SELECT path FROM files WHERE id = ?").get(id) as { path: string };
			const res = await app.request(`/download?path=${encodeURIComponent(row.path)}`);
			expect(res.status).toBe(200);
			const out = new Uint8Array(await res.arrayBuffer());
			expect([...out]).toEqual([0, 255, 65]);
		});

		it("404s an unknown file", async () => {
			const res = await app.request("/download?id=nope");
			expect(res.status).toBe(404);
			expect((await res.json()).error).toBe("File not found");
		});
	});

	describe("GET /* (by path)", () => {
		it("returns the full file row including content", async () => {
			const id = await storeFile(db, siteId, {
				name: "doc.md",
				mimeType: "text/markdown",
				data: new TextEncoder().encode("# hi").buffer as ArrayBuffer,
				createdBy: "u",
				hostOrigin: "h",
			});
			const row = db.query("SELECT path FROM files WHERE id = ?").get(id) as { path: string };
			const res = await app.request(row.path);
			expect(res.status).toBe(200);
			const body = (await res.json()) as { content: string };
			expect(body.content).toBe("# hi");
		});

		it("404s an unknown path", async () => {
			const res = await app.request("/home/user/nope.txt");
			expect(res.status).toBe(404);
			expect((await res.json()).error).toBe("File not found");
		});
	});

	describe("POST /upload", () => {
		it("stores an uploaded file and returns 201", async () => {
			const form = new FormData();
			form.set("file", new File(["uploaded"], "up.txt", { type: "text/plain" }));
			const res = await app.request("/upload", { method: "POST", body: form });
			expect(res.status).toBe(201);
			const body = (await res.json()) as { id: string; path: string };
			expect(body.id).toBeDefined();
			expect(body.path).toContain("up.");
		});

		it("400s a request with no file field", async () => {
			const res = await app.request("/upload", { method: "POST", body: new FormData() });
			expect(res.status).toBe(400);
			expect((await res.json()).error).toBe("Invalid request body");
		});

		describe("error and edge paths", () => {
			it("download 404s when a file row has null content", async () => {
				// Seed a file row directly with content = null (a tombstoned/offloaded row).
				const now = "2026-07-04T00:00:00.000Z";
				db.prepare(
					`INSERT INTO files (id, path, content, is_binary, size_bytes, created_at, modified_at, created_by, host_origin, deleted)
				 VALUES (?, ?, NULL, 0, 0, ?, ?, ?, ?, 0)`,
				).run("f-null", "/home/user/uploads/empty.txt", now, now, "u", "h");
				const res = await app.request("/download?id=f-null");
				expect(res.status).toBe(404);
				expect((await res.json()).error).toBe("File content not available");
			});

			// NOTE: the file-too-large 413 branch (files.ts upload size gate) is not
			// covered here — Hono's c.req.formData() reconstructs the multipart body, so a
			// stubbed oversized File.size does not survive to the handler, and allocating
			// a real >50MB body is wasteful. The branch is a simple `if (size > cap)`
			// guard; function coverage already clears 90% without it.

			it("download 500s when the lookup throws", async () => {
				db.close();
				const res = await app.request("/download?id=any");
				expect(res.status).toBe(500);
				expect((await res.json()).error).toBe("Failed to download file");
			});

			it("GET /* 500s when the lookup throws", async () => {
				db.close();
				const res = await app.request("/home/user/anything.txt");
				expect(res.status).toBe(500);
				expect((await res.json()).error).toBe("Failed to get file");
			});

			it("upload 500s when storage throws", async () => {
				db.close();
				const form = new FormData();
				form.set("file", new File(["x"], "x.txt", { type: "text/plain" }));
				const res = await app.request("/upload", { method: "POST", body: form });
				expect(res.status).toBe(500);
				expect((await res.json()).error).toBe("Failed to upload file");
			});
		});
	});
});
