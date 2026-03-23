import type { Database } from "bun:sqlite";
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applySchema, createDatabase } from "@bound/core";
import type { CommandContext } from "@bound/sandbox";
import { TypedEventEmitter } from "@bound/shared";
import { archive } from "../commands/archive";
import { cacheEvict } from "../commands/cache-evict";
import { cachePin } from "../commands/cache-pin";
import { cacheUnpin } from "../commands/cache-unpin";
import { cacheWarm } from "../commands/cache-warm";
import { modelHint } from "../commands/model-hint";

describe("Cache and runtime command implementations", () => {
	let tmpDir: string;
	let dbPath: string;
	let db: Database;
	let ctx: CommandContext;

	beforeAll(() => {
		tmpDir = mkdtempSync(join(tmpdir(), "cache-commands-test-"));
		dbPath = join(tmpDir, "test.db");

		db = createDatabase(dbPath);
		applySchema(db);

		const siteId = randomUUID();

		const threadId = randomUUID();
		const taskId = randomUUID();
		const now = new Date().toISOString();

		ctx = {
			db,
			siteId,
			eventBus: new TypedEventEmitter(),
			logger: {
				info: () => {},
				warn: () => {},
				error: () => {},
			},
			threadId,
			taskId,
		};

		// Insert a task row so model-hint can find it
		db.run(
			`INSERT INTO tasks (
				id, type, status, trigger_spec, payload, thread_id,
				claimed_by, claimed_at, lease_id, next_run_at, last_run_at,
				run_count, max_runs, requires, model_hint, no_history,
				inject_mode, depends_on, require_success, alert_threshold,
				consecutive_failures, event_depth, no_quiescence,
				heartbeat_at, result, error, created_at, created_by, modified_at, deleted
			) VALUES (
				?, 'deferred', 'running', '{}', NULL, ?,
				NULL, NULL, NULL, NULL, NULL,
				0, NULL, NULL, NULL, 0,
				'results', NULL, 0, 1,
				0, 0, 0,
				NULL, NULL, NULL, ?, ?, ?, 0
			)`,
			[taskId, threadId, now, siteId, now],
		);
	});

	afterAll(() => {
		db.close();
		if (tmpDir) {
			rmSync(tmpDir, { recursive: true, force: true });
		}
	});

	describe("cache-warm command", () => {
		it("should return stub message for Phase 4", async () => {
			const result = await cacheWarm.handler({ patterns: "*.txt" }, ctx);

			expect(result.exitCode).toBe(0);
			expect(result.stdout).toContain("MCP proxy not yet implemented");
		});
	});

	describe("cache-pin command", () => {
		it("should pin a file", async () => {
			const fileId = randomUUID();
			const now = new Date().toISOString();

			db.run(
				`INSERT INTO files (id, path, content, is_binary, size_bytes, created_at, modified_at, deleted, created_by, host_origin)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
				[fileId, "/test/file.txt", "content", 0, 7, now, now, 0, ctx.siteId, "http://localhost"],
			);

			const result = await cachePin.handler({ path: "/test/file.txt" }, ctx);

			expect(result.exitCode).toBe(0);
			expect(result.stdout).toContain("pinned");
		});

		it("should reject non-existent file", async () => {
			const result = await cachePin.handler({ path: "/nonexistent.txt" }, ctx);

			expect(result.exitCode).toBe(1);
			expect(result.stderr).toContain("not found");
		});
	});

	describe("cache-unpin command", () => {
		it("should unpin a file", async () => {
			const fileId = randomUUID();
			const now = new Date().toISOString();

			db.run(
				`INSERT INTO files (id, path, content, is_binary, size_bytes, created_at, modified_at, deleted, created_by, host_origin)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
				[fileId, "/test/pinned.txt", "content", 0, 7, now, now, 0, ctx.siteId, "http://localhost"],
			);

			// Pin the file first
			await cachePin.handler({ path: "/test/pinned.txt" }, ctx);

			// Then unpin it
			const result = await cacheUnpin.handler({ path: "/test/pinned.txt" }, ctx);

			expect(result.exitCode).toBe(0);
			expect(result.stdout).toContain("unpinned");
		});
	});

	describe("cache-evict command", () => {
		it("should evict files matching a pattern", async () => {
			const now = new Date().toISOString();

			for (let i = 0; i < 3; i++) {
				const fileId = randomUUID();
				db.run(
					`INSERT INTO files (id, path, content, is_binary, size_bytes, created_at, modified_at, deleted, created_by, host_origin)
					 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
					[
						fileId,
						`/cache/file${i}.tmp`,
						"cached",
						0,
						6,
						now,
						now,
						0,
						ctx.siteId,
						"http://localhost",
					],
				);
			}

			const result = await cacheEvict.handler({ pattern: "/cache/*.tmp" }, ctx);

			expect(result.exitCode).toBe(0);
			expect(result.stdout).toContain("3 cached file(s)");

			// Verify files are soft-deleted
			const remaining = db
				.prepare("SELECT COUNT(*) as count FROM files WHERE path LIKE ? AND deleted = 0")
				.get("/cache/%") as { count: number };
			expect(remaining.count).toBe(0);
		});

		it("should return 0 matches for non-matching pattern", async () => {
			const result = await cacheEvict.handler({ pattern: "/nonexistent/*.txt" }, ctx);

			expect(result.exitCode).toBe(0);
			expect(result.stdout).toContain("No files matched");
		});
	});

	describe("model-hint command", () => {
		it("should set a model hint", async () => {
			const result = await modelHint.handler({ model: "gpt-4-turbo" }, ctx);

			expect(result.exitCode).toBe(0);
			expect(result.stdout).toContain("Model hint set to");
		});

		it("should require either --model or --reset", async () => {
			const result = await modelHint.handler({}, ctx);

			expect(result.exitCode).toBe(1);
			expect(result.stderr).toContain("must specify");
		});

		it("should clear a model hint with --reset", async () => {
			await modelHint.handler({ model: "gpt-4-turbo" }, ctx);

			const result = await modelHint.handler({ reset: "true" }, ctx);

			expect(result.exitCode).toBe(0);
			expect(result.stdout).toContain("Model hint cleared");
		});
	});

	describe("archive command", () => {
		it("should validate archive parameters", async () => {
			const result = await archive.handler({}, ctx);

			expect(result.exitCode).toBe(1);
			expect(result.stderr).toContain("must specify");
		});

		it("should reject non-existent thread", async () => {
			const result = await archive.handler({ "thread-id": randomUUID() }, ctx);

			expect(result.exitCode).toBe(1);
			expect(result.stderr).toContain("not found");
		});
	});
});
