import Database from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { applyMetricsSchema, applySchema, recordTurn } from "@bound/core";
import { predictCacheState, selectCacheTtl } from "../cache-prediction";

describe("Cache Prediction", () => {
	let db: Database.Database;
	const threadId = "test-thread-001";

	// Fixed clock anchor: both the seeded `created_at` and the `nowMs` passed to
	// predictCacheState derive from this, so the warm/cold boundary is a pure
	// function of the offsets under test — never a race between a seeded
	// timestamp and a later real `Date.now()`.
	const NOW = 1_800_000_000_000; // arbitrary fixed epoch ms
	const agoIso = (ms: number) => new Date(NOW - ms).toISOString();

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
			const state = predictCacheState(db, threadId, 5 * 60_000, NOW);
			expect(state).toBe("cold");
		});

		it("returns 'warm' when last turn had cache_write and is within TTL", () => {
			const recentTime = agoIso(60_000); // 1 min ago
			recordTurn(db, {
				thread_id: threadId,
				model_id: "opus",
				tokens_in: 100,
				tokens_out: 50,
				tokens_cache_read: 0,
				tokens_cache_write: 50000,
				created_at: recentTime,
			});

			const state = predictCacheState(db, threadId, 5 * 60_000, NOW);
			expect(state).toBe("warm");
		});

		it("returns 'warm' when last turn had cache_read and is within TTL", () => {
			const recentTime = agoIso(2 * 60_000); // 2 min ago
			recordTurn(db, {
				thread_id: threadId,
				model_id: "opus",
				tokens_in: 100,
				tokens_out: 50,
				tokens_cache_read: 200000,
				tokens_cache_write: 500,
				created_at: recentTime,
			});

			const state = predictCacheState(db, threadId, 5 * 60_000, NOW);
			expect(state).toBe("warm");
		});

		it("returns 'cold' when last turn is beyond TTL", () => {
			const oldTime = agoIso(10 * 60_000); // 10 min ago
			recordTurn(db, {
				thread_id: threadId,
				model_id: "opus",
				tokens_in: 100,
				tokens_out: 50,
				tokens_cache_read: 200000,
				tokens_cache_write: 500,
				created_at: oldTime,
			});

			const state = predictCacheState(db, threadId, 5 * 60_000, NOW);
			expect(state).toBe("cold");
		});

		it("returns 'cold' when last turn had no cache activity", () => {
			const recentTime = agoIso(60_000);
			recordTurn(db, {
				thread_id: threadId,
				model_id: "opus",
				tokens_in: 100,
				tokens_out: 50,
				tokens_cache_read: 0,
				tokens_cache_write: 0,
				created_at: recentTime,
			});

			const state = predictCacheState(db, threadId, 5 * 60_000, NOW);
			expect(state).toBe("cold");
		});

		it("returns 'cold' when cache columns are NULL (e.g. Ollama)", () => {
			const recentTime = agoIso(30_000);
			recordTurn(db, {
				thread_id: threadId,
				model_id: "llama3",
				tokens_in: 100,
				tokens_out: 50,
				tokens_cache_read: null,
				tokens_cache_write: null,
				created_at: recentTime,
			});

			const state = predictCacheState(db, threadId, 5 * 60_000, NOW);
			expect(state).toBe("cold");
		});

		it("is deterministic at the exact TTL boundary (injected clock, no wall-clock race)", () => {
			const ttl = 5 * 60_000;
			recordTurn(db, {
				thread_id: threadId,
				model_id: "opus",
				tokens_in: 100,
				tokens_out: 50,
				tokens_cache_read: 200000,
				tokens_cache_write: 500,
				created_at: agoIso(ttl), // exactly TTL ago
			});

			// At exactly ttl elapsed, msSinceTurn === ttl, and the predicate is
			// strict `< ttlMs`, so the boundary is cold. One ms inside is warm.
			// With the injected clock these are exact, not timing-dependent.
			expect(predictCacheState(db, threadId, ttl, NOW)).toBe("cold");
			expect(predictCacheState(db, threadId, ttl, NOW - 1)).toBe("warm");
		});

		it("uses the most recent turn when multiple exist", () => {
			const oldTime = agoIso(10 * 60_000);
			const recentTime = agoIso(60_000);

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

			const state = predictCacheState(db, threadId, 5 * 60_000, NOW);
			expect(state).toBe("warm");
		});
	});

	describe("selectCacheTtl", () => {
		it("returns '1h' for all interfaces", () => {
			expect(selectCacheTtl("discord")).toBe("1h");
			expect(selectCacheTtl("scheduler")).toBe("1h");
			expect(selectCacheTtl("web")).toBe("1h");
			expect(selectCacheTtl("boundless")).toBe("1h");
			expect(selectCacheTtl("discord-interaction")).toBe("1h");
			expect(selectCacheTtl("unknown")).toBe("1h");
		});
	});
});
