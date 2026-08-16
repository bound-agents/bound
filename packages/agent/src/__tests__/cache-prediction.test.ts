import Database from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { applyMetricsSchema, applySchema, recordTurn } from "@bound/core";
import { predictCacheState, selectCacheTtl } from "../cache-prediction";

const NOW = 1_800_000_000_000;
const threadId = "test-thread-001";
const agoIso = (ms: number) => new Date(NOW - ms).toISOString();

function recordCacheTurn(
	db: Database.Database,
	{
		elapsedMs,
		cacheRead,
		cacheWrite,
	}: { elapsedMs: number; cacheRead: number; cacheWrite: number },
) {
	recordTurn(db, {
		thread_id: threadId,
		model_id: "opus",
		tokens_in: 100,
		tokens_out: 50,
		tokens_cache_read: cacheRead,
		tokens_cache_write: cacheWrite,
		created_at: agoIso(elapsedMs),
	});
}

describe("Cache Prediction", () => {
	let db: Database.Database;

	beforeEach(() => {
		db = new Database(":memory:");
		applySchema(db);
		applyMetricsSchema(db);
	});

	afterEach(() => {
		db.close();
	});

	describe("predictCacheState", () => {
		it("returns cold when no turn exists", () => {
			expect(predictCacheState(db, threadId, 5 * 60_000, NOW)).toBe("cold");
		});

		it("classifies cache activity, zero activity, null metrics, and TTL boundary with an injected clock", () => {
			const ttl = 5 * 60_000;
			recordCacheTurn(db, { elapsedMs: ttl - 1, cacheRead: 0, cacheWrite: 500 });
			expect(predictCacheState(db, threadId, ttl, NOW)).toBe("warm");

			const readOnlyThread = "read-only-thread";
			recordTurn(db, {
				thread_id: readOnlyThread,
				model_id: "opus",
				tokens_in: 100,
				tokens_out: 50,
				tokens_cache_read: 200_000,
				tokens_cache_write: 0,
				created_at: agoIso(ttl - 1),
			});
			expect(predictCacheState(db, readOnlyThread, ttl, NOW)).toBe("warm");

			const zeroActivityThread = "zero-activity-thread";
			recordTurn(db, {
				thread_id: zeroActivityThread,
				model_id: "opus",
				tokens_in: 100,
				tokens_out: 50,
				tokens_cache_read: 0,
				tokens_cache_write: 0,
				created_at: agoIso(ttl - 1),
			});
			expect(predictCacheState(db, zeroActivityThread, ttl, NOW)).toBe("cold");

			const inactiveThread = "inactive-thread";
			recordTurn(db, {
				thread_id: inactiveThread,
				model_id: "llama3",
				tokens_in: 100,
				tokens_out: 50,
				tokens_cache_read: null,
				tokens_cache_write: null,
				created_at: agoIso(ttl - 1),
			});
			expect(predictCacheState(db, inactiveThread, ttl, NOW)).toBe("cold");
		});

		it("is deterministic at the exact TTL boundary", () => {
			const ttl = 5 * 60_000;
			recordCacheTurn(db, { elapsedMs: ttl, cacheRead: 200_000, cacheWrite: 500 });

			expect(predictCacheState(db, threadId, ttl, NOW)).toBe("cold");
			expect(predictCacheState(db, threadId, ttl, NOW - 1)).toBe("warm");
		});

		it("uses the latest turn's cache activity and timestamp in both directions", () => {
			const ttl = 5 * 60_000;

			// A newer cold turn overrides an older warm turn.
			recordCacheTurn(db, { elapsedMs: 10 * 60_000, cacheRead: 200_000, cacheWrite: 500 });
			recordCacheTurn(db, { elapsedMs: 60_000, cacheRead: 0, cacheWrite: 0 });
			expect(predictCacheState(db, threadId, ttl, NOW)).toBe("cold");

			const newerWarmThread = "newer-warm-thread";
			recordTurn(db, {
				thread_id: newerWarmThread,
				model_id: "opus",
				tokens_in: 100,
				tokens_out: 50,
				tokens_cache_read: 0,
				tokens_cache_write: 0,
				created_at: agoIso(10 * 60_000),
			});
			recordTurn(db, {
				thread_id: newerWarmThread,
				model_id: "opus",
				tokens_in: 100,
				tokens_out: 50,
				tokens_cache_read: 200_000,
				tokens_cache_write: 500,
				created_at: agoIso(60_000),
			});
			expect(predictCacheState(db, newerWarmThread, ttl, NOW)).toBe("warm");
		});
	});

	describe("selectCacheTtl", () => {
		it("returns 1h for all interfaces", () => {
			for (const threadInterface of [
				"discord",
				"scheduler",
				"web",
				"boundless",
				"discord-interaction",
				"unknown",
			]) {
				expect(selectCacheTtl(threadInterface)).toBe("1h");
			}
		});
	});
});
