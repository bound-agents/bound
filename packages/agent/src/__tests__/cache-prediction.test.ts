import Database from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { applySchema, applyMetricsSchema } from "@bound/core";
import { predictCacheState, selectCacheTtl } from "../cache-prediction";

describe("Cache Prediction", () => {
	let db: Database.Database;
	const threadId = "test-thread-001";

	beforeEach(() => {
		db = new Database(":memory:");
		applySchema(db);
		applyMetricsSchema(db);
	});

	afterEach(() => {
		db.close();
	});

	describe("predictCacheState", () => {
		it("returns 'cold' when no turns exist for the thread", () => {
			const state = predictCacheState(db, threadId, 5 * 60_000);
			expect(state).toBe("cold");
		});

		it("returns 'warm' when last turn had cache_write and is within TTL", () => {
			const recentTime = new Date(Date.now() - 60_000).toISOString(); // 1 min ago
			db.run(
				"INSERT INTO turns (thread_id, model_id, tokens_in, tokens_out, tokens_cache_read, tokens_cache_write, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
				[threadId, "opus", 100, 50, 0, 50000, recentTime],
			);

			const state = predictCacheState(db, threadId, 5 * 60_000);
			expect(state).toBe("warm");
		});

		it("returns 'warm' when last turn had cache_read and is within TTL", () => {
			const recentTime = new Date(Date.now() - 2 * 60_000).toISOString(); // 2 min ago
			db.run(
				"INSERT INTO turns (thread_id, model_id, tokens_in, tokens_out, tokens_cache_read, tokens_cache_write, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
				[threadId, "opus", 100, 50, 200000, 500, recentTime],
			);

			const state = predictCacheState(db, threadId, 5 * 60_000);
			expect(state).toBe("warm");
		});

		it("returns 'cold' when last turn is beyond TTL", () => {
			const oldTime = new Date(Date.now() - 10 * 60_000).toISOString(); // 10 min ago
			db.run(
				"INSERT INTO turns (thread_id, model_id, tokens_in, tokens_out, tokens_cache_read, tokens_cache_write, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
				[threadId, "opus", 100, 50, 200000, 500, oldTime],
			);

			const state = predictCacheState(db, threadId, 5 * 60_000);
			expect(state).toBe("cold");
		});

		it("returns 'cold' when last turn had no cache activity", () => {
			const recentTime = new Date(Date.now() - 60_000).toISOString();
			db.run(
				"INSERT INTO turns (thread_id, model_id, tokens_in, tokens_out, tokens_cache_read, tokens_cache_write, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
				[threadId, "opus", 100, 50, 0, 0, recentTime],
			);

			const state = predictCacheState(db, threadId, 5 * 60_000);
			expect(state).toBe("cold");
		});

		it("returns 'cold' when cache columns are NULL (e.g. Ollama)", () => {
			const recentTime = new Date(Date.now() - 30_000).toISOString();
			db.run(
				"INSERT INTO turns (thread_id, model_id, tokens_in, tokens_out, created_at) VALUES (?, ?, ?, ?, ?)",
				[threadId, "llama3", 100, 50, recentTime],
			);

			const state = predictCacheState(db, threadId, 5 * 60_000);
			expect(state).toBe("cold");
		});

		it("uses the most recent turn when multiple exist", () => {
			const oldTime = new Date(Date.now() - 10 * 60_000).toISOString();
			const recentTime = new Date(Date.now() - 60_000).toISOString();

			// Old turn with cache activity (beyond TTL)
			db.run(
				"INSERT INTO turns (thread_id, model_id, tokens_in, tokens_out, tokens_cache_read, tokens_cache_write, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
				[threadId, "opus", 100, 50, 200000, 500, oldTime],
			);
			// Recent turn with cache activity (within TTL)
			db.run(
				"INSERT INTO turns (thread_id, model_id, tokens_in, tokens_out, tokens_cache_read, tokens_cache_write, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
				[threadId, "opus", 100, 50, 200000, 100, recentTime],
			);

			const state = predictCacheState(db, threadId, 5 * 60_000);
			expect(state).toBe("warm");
		});
	});

	describe("selectCacheTtl", () => {
		it("returns '1h' for discord interface", () => {
			expect(selectCacheTtl("discord")).toBe("1h");
		});

		it("returns '1h' for scheduler interface", () => {
			expect(selectCacheTtl("scheduler")).toBe("1h");
		});

		it("returns '5m' for web interface", () => {
			expect(selectCacheTtl("web")).toBe("5m");
		});

		it("returns '5m' for mcp interface", () => {
			expect(selectCacheTtl("mcp")).toBe("5m");
		});

		it("returns '1h' for discord-interaction interface", () => {
			expect(selectCacheTtl("discord-interaction")).toBe("1h");
		});

		it("returns '5m' for unknown interface", () => {
			expect(selectCacheTtl("unknown")).toBe("5m");
		});
	});
});
