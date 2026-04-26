import Database from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { applyMetricsSchema, applySchema, recordTurn } from "@bound/core";
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
			recordTurn(db, {
				thread_id: threadId,
				model_id: "opus",
				tokens_in: 100,
				tokens_out: 50,
				tokens_cache_read: 0,
				tokens_cache_write: 50000,
				created_at: recentTime,
			});

			const state = predictCacheState(db, threadId, 5 * 60_000);
			expect(state).toBe("warm");
		});

		it("returns 'warm' when last turn had cache_read and is within TTL", () => {
			const recentTime = new Date(Date.now() - 2 * 60_000).toISOString(); // 2 min ago
			recordTurn(db, {
				thread_id: threadId,
				model_id: "opus",
				tokens_in: 100,
				tokens_out: 50,
				tokens_cache_read: 200000,
				tokens_cache_write: 500,
				created_at: recentTime,
			});

			const state = predictCacheState(db, threadId, 5 * 60_000);
			expect(state).toBe("warm");
		});

		it("returns 'cold' when last turn is beyond TTL", () => {
			const oldTime = new Date(Date.now() - 10 * 60_000).toISOString(); // 10 min ago
			recordTurn(db, {
				thread_id: threadId,
				model_id: "opus",
				tokens_in: 100,
				tokens_out: 50,
				tokens_cache_read: 200000,
				tokens_cache_write: 500,
				created_at: oldTime,
			});

			const state = predictCacheState(db, threadId, 5 * 60_000);
			expect(state).toBe("cold");
		});

		it("returns 'cold' when last turn had no cache activity", () => {
			const recentTime = new Date(Date.now() - 60_000).toISOString();
			recordTurn(db, {
				thread_id: threadId,
				model_id: "opus",
				tokens_in: 100,
				tokens_out: 50,
				tokens_cache_read: 0,
				tokens_cache_write: 0,
				created_at: recentTime,
			});

			const state = predictCacheState(db, threadId, 5 * 60_000);
			expect(state).toBe("cold");
		});

		it("returns 'cold' when cache columns are NULL (e.g. Ollama)", () => {
			const recentTime = new Date(Date.now() - 30_000).toISOString();
			recordTurn(db, {
				thread_id: threadId,
				model_id: "llama3",
				tokens_in: 100,
				tokens_out: 50,
				tokens_cache_read: null,
				tokens_cache_write: null,
				created_at: recentTime,
			});

			const state = predictCacheState(db, threadId, 5 * 60_000);
			expect(state).toBe("cold");
		});

		it("uses the most recent turn when multiple exist", () => {
			const oldTime = new Date(Date.now() - 10 * 60_000).toISOString();
			const recentTime = new Date(Date.now() - 60_000).toISOString();

			// Old turn with cache activity (beyond TTL)
			recordTurn(db, {
				thread_id: threadId,
				model_id: "opus",
				tokens_in: 100,
				tokens_out: 50,
				tokens_cache_read: 200000,
				tokens_cache_write: 500,
				created_at: oldTime,
			});
			// Recent turn with cache activity (within TTL)
			recordTurn(db, {
				thread_id: threadId,
				model_id: "opus",
				tokens_in: 100,
				tokens_out: 50,
				tokens_cache_read: 200000,
				tokens_cache_write: 100,
				created_at: recentTime,
			});

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
