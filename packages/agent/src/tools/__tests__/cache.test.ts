import Database from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { randomBytes } from "node:crypto";
import { applySchema } from "@bound/core";
import type { ToolContext } from "../../types";
import { createCacheTool } from "../cache";

function getExecute(tool: ReturnType<typeof createCacheTool>) {
	const execute = tool.execute;
	if (!execute) throw new Error("Tool execute is required");
	return execute;
}

describe("cache tool", () => {
	let db: Database;
	let ctx: ToolContext;
	const siteId = randomBytes(4).toString("hex");
	const threadId = randomBytes(4).toString("hex");

	beforeEach(() => {
		const dbPath = `/tmp/cache-test-${randomBytes(4).toString("hex")}.db`;
		db = new Database(dbPath);
		applySchema(db);

		ctx = {
			db,
			siteId,
			eventBus: {
				emit: () => {},
				on: () => {},
				off: () => {},
			} as any,
			logger: {
				debug: () => {},
				info: () => {},
				warn: () => {},
				error: () => {},
			},
			threadId,
		};
	});

	afterEach(() => {
		try {
			db.close();
		} catch {
			// ignore
		}
	});

	describe("invalid action", () => {
		it("returns error with valid actions list", async () => {
			const tool = createCacheTool(ctx);
			const result = await getExecute(tool)({ action: "invalid" });
			expect(result).toContain("Error");
			expect(result).toContain("warm");
			expect(result).toContain("pin");
			expect(result).toContain("unpin");
			expect(result).toContain("evict");
		});
	});

	describe("warm action", () => {
		it("returns informational message", async () => {
			const tool = createCacheTool(ctx);
			const result = await getExecute(tool)({ action: "warm" });
			expect(result).toBeTruthy();
			expect(result).not.toContain("Error");
		});
	});

	describe("pin action", () => {
		it("requires path parameter", async () => {
			const tool = createCacheTool(ctx);
			const result = await getExecute(tool)({ action: "pin" });
			expect(result).toContain("Error");
			expect(result).toContain("path");
		});

		it("returns error if file not found", async () => {
			const tool = createCacheTool(ctx);
			const result = await getExecute(tool)({ action: "pin", path: "/nonexistent/file" });
			expect(result).toContain("Error");
			expect(result).toContain("not found");
		});

		it("pins an existing file", async () => {
			// Seed a file
			const fileId = randomBytes(4).toString("hex");
			const now = new Date().toISOString();
			db.prepare(
				"INSERT INTO files (id, path, content, size_bytes, created_at, modified_at, deleted) VALUES (?, ?, ?, ?, ?, ?, ?)",
			).run(fileId, "/test/file.txt", "test content", 1024, now, now, 0);

			const tool = createCacheTool(ctx);
			const result = await getExecute(tool)({ action: "pin", path: "/test/file.txt" });
			expect(result).not.toContain("Error");
			expect(result).toContain("pinned");

			// Verify pinned_files in cluster_config
			const configRow = db
				.prepare("SELECT value FROM cluster_config WHERE key = ?")
				.get("pinned_files") as { value: string } | null;
			expect(configRow).toBeTruthy();
			if (configRow) {
				const pinnedFiles = JSON.parse(configRow.value);
				expect(pinnedFiles).toContain("/test/file.txt");
			}
		});

		it("does not duplicate pinned files", async () => {
			const path = "/test/file.txt";
			const fileId = randomBytes(4).toString("hex");
			const now = new Date().toISOString();
			db.prepare(
				"INSERT INTO files (id, path, content, size_bytes, created_at, modified_at, deleted) VALUES (?, ?, ?, ?, ?, ?, ?)",
			).run(fileId, path, "test content", 1024, now, now, 0);

			const tool = createCacheTool(ctx);
			await getExecute(tool)({ action: "pin", path });
			await getExecute(tool)({ action: "pin", path });

			const configRow = db
				.prepare("SELECT value FROM cluster_config WHERE key = ?")
				.get("pinned_files") as { value: string } | null;
			if (configRow) {
				const pinnedFiles = JSON.parse(configRow.value);
				const count = pinnedFiles.filter((p: string) => p === path).length;
				expect(count).toBe(1);
			}
		});
	});

	describe("unpin action", () => {
		it("requires path parameter", async () => {
			const tool = createCacheTool(ctx);
			const result = await getExecute(tool)({ action: "unpin" });
			expect(result).toContain("Error");
			expect(result).toContain("path");
		});

		it("returns error if file not found", async () => {
			const tool = createCacheTool(ctx);
			const result = await getExecute(tool)({ action: "unpin", path: "/nonexistent" });
			expect(result).toContain("Error");
			expect(result).toContain("not found");
		});

		it("returns error if file not pinned", async () => {
			const path = "/test/file.txt";
			const fileId = randomBytes(4).toString("hex");
			const now = new Date().toISOString();
			db.prepare(
				"INSERT INTO files (id, path, content, size_bytes, created_at, modified_at, deleted) VALUES (?, ?, ?, ?, ?, ?, ?)",
			).run(fileId, path, "test content", 1024, now, now, 0);

			const tool = createCacheTool(ctx);
			const result = await getExecute(tool)({ action: "unpin", path });
			expect(result).toContain("Error");
			expect(result).toContain("not pinned");
		});

		it("unpins a pinned file", async () => {
			const path = "/test/file.txt";
			const fileId = randomBytes(4).toString("hex");
			const now = new Date().toISOString();
			db.prepare(
				"INSERT INTO files (id, path, content, size_bytes, created_at, modified_at, deleted) VALUES (?, ?, ?, ?, ?, ?, ?)",
			).run(fileId, path, "test content", 1024, now, now, 0);

			const tool = createCacheTool(ctx);
			await getExecute(tool)({ action: "pin", path });
			const result = await getExecute(tool)({ action: "unpin", path });

			expect(result).not.toContain("Error");
			expect(result).toContain("unpinned");

			const configRow = db
				.prepare("SELECT value FROM cluster_config WHERE key = ?")
				.get("pinned_files") as { value: string } | null;
			if (configRow) {
				const pinnedFiles = JSON.parse(configRow.value);
				expect(pinnedFiles).not.toContain(path);
			}
		});
	});

	describe("evict action", () => {
		it("requires pattern parameter", async () => {
			const tool = createCacheTool(ctx);
			const result = await getExecute(tool)({ action: "evict" });
			expect(result).toContain("Error");
			expect(result).toContain("pattern");
		});

		it("returns 0 matches when no files match pattern", async () => {
			const tool = createCacheTool(ctx);
			const result = await getExecute(tool)({ action: "evict", pattern: "/nonexistent/*" });
			expect(result).toContain("0");
		});

		it("evicts files matching glob pattern", async () => {
			const file1Id = randomBytes(4).toString("hex");
			const file2Id = randomBytes(4).toString("hex");
			const file3Id = randomBytes(4).toString("hex");
			const now = new Date().toISOString();

			db.prepare(
				"INSERT INTO files (id, path, content, size_bytes, created_at, modified_at, deleted) VALUES (?, ?, ?, ?, ?, ?, ?)",
			).run(file1Id, "/cache/file1.txt", "content1", 100, now, now, 0);
			db.prepare(
				"INSERT INTO files (id, path, content, size_bytes, created_at, modified_at, deleted) VALUES (?, ?, ?, ?, ?, ?, ?)",
			).run(file2Id, "/cache/file2.txt", "content2", 200, now, now, 0);
			db.prepare(
				"INSERT INTO files (id, path, content, size_bytes, created_at, modified_at, deleted) VALUES (?, ?, ?, ?, ?, ?, ?)",
			).run(file3Id, "/other/file.txt", "content3", 300, now, now, 0);

			const tool = createCacheTool(ctx);
			const result = await getExecute(tool)({ action: "evict", pattern: "/cache/*" });

			expect(result).not.toContain("Error");
			expect(result).toContain("2");

			// Verify files are soft-deleted
			const file1 = db.prepare("SELECT deleted FROM files WHERE id = ?").get(file1Id) as {
				deleted: number;
			};
			const file2 = db.prepare("SELECT deleted FROM files WHERE id = ?").get(file2Id) as {
				deleted: number;
			};
			const file3 = db.prepare("SELECT deleted FROM files WHERE id = ?").get(file3Id) as {
				deleted: number;
			};

			expect(file1.deleted).toBe(1);
			expect(file2.deleted).toBe(1);
			expect(file3.deleted).toBe(0);
		});

		it("converts glob patterns to SQL LIKE", async () => {
			const fileId = randomBytes(4).toString("hex");
			const now = new Date().toISOString();
			db.prepare(
				"INSERT INTO files (id, path, content, size_bytes, created_at, modified_at, deleted) VALUES (?, ?, ?, ?, ?, ?, ?)",
			).run(fileId, "/cache/test-f.txt", "content", 100, now, now, 0);

			const tool = createCacheTool(ctx);
			const result = await getExecute(tool)({ action: "evict", pattern: "/cache/test-?.txt" });

			expect(result).not.toContain("Error");
			expect(result).toContain("1");

			const file = db.prepare("SELECT deleted FROM files WHERE id = ?").get(fileId) as {
				deleted: number;
			};
			expect(file.deleted).toBe(1);
		});
	});
});
