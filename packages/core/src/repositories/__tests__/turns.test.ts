import Database from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { Turn } from "@bound/shared";
import { applyMetricsSchema, applySchema, insertRow, softDelete } from "../../index";
import {
	aggregateContextDebugHealthInRange,
	aggregateUsageTotalsInRange,
	findLatestCacheHitRateInRange,
	findLatestTurnCacheStateByThread,
	findLatestTurnCreatedAtByThread,
	findLatestTurnSpend,
	findLatestTurnStatusByThreadSince,
	findMaxTurnCreatedAtByThreadAndTask,
	listContextDebugTurnsByThread,
	listModelUsageInRange,
	listStablePrefixDriftTurnsSince,
	listTurnInflationRatiosByThread,
	sumTurnCostForDate,
} from "../turns";

const SITE = "site-test";

let db: Database;

/** Build a complete Turn row, filling every column; overrides win. */
function makeTurn(overrides: Partial<Turn> & { id: string }): Turn {
	return {
		id: overrides.id,
		thread_id: overrides.thread_id ?? null,
		task_id: overrides.task_id ?? null,
		dag_root_id: overrides.dag_root_id ?? null,
		model_id: overrides.model_id ?? "model-a",
		tokens_in: overrides.tokens_in ?? 0,
		tokens_out: overrides.tokens_out ?? 0,
		tokens_cache_write: overrides.tokens_cache_write ?? null,
		tokens_cache_read: overrides.tokens_cache_read ?? null,
		cost_usd: overrides.cost_usd ?? null,
		created_at: overrides.created_at ?? "2026-01-01T00:00:00.000Z",
		status: overrides.status ?? null,
		relay_target: overrides.relay_target ?? null,
		relay_latency_ms: overrides.relay_latency_ms ?? null,
		context_debug: overrides.context_debug ?? null,
		host_origin: overrides.host_origin ?? null,
		modified_at: overrides.modified_at ?? null,
	};
}

function seed(overrides: Partial<Turn> & { id: string }): void {
	insertRow(db, "turns", makeTurn(overrides), SITE);
}

beforeEach(() => {
	db = new Database(":memory:");
	applySchema(db);
	applyMetricsSchema(db);
});

afterEach(() => {
	db.close();
});

describe("findLatestTurnCacheStateByThread", () => {
	it("returns the most recent turn's cache columns for the thread", () => {
		seed({
			id: "t1",
			thread_id: "th1",
			created_at: "2026-01-01T00:00:00.000Z",
			tokens_cache_read: 10,
			tokens_cache_write: 5,
		});
		seed({
			id: "t2",
			thread_id: "th1",
			created_at: "2026-01-02T00:00:00.000Z",
			tokens_cache_read: 99,
			tokens_cache_write: 88,
		});
		// Different thread — must not be selected.
		seed({ id: "t3", thread_id: "th2", created_at: "2026-01-03T00:00:00.000Z" });

		const got = findLatestTurnCacheStateByThread(db, "th1");
		expect(got).toEqual({
			created_at: "2026-01-02T00:00:00.000Z",
			tokens_cache_read: 99,
			tokens_cache_write: 88,
		});
	});

	it("returns null when the thread has no turns", () => {
		expect(findLatestTurnCacheStateByThread(db, "nope")).toBeNull();
	});

	it("does NOT exclude soft-deleted rows (no deleted=0 filter)", () => {
		// A tombstoned row is the most recent for the thread; the finder lacks a
		// deleted=0 clause, so it must still surface it.
		seed({ id: "t1", thread_id: "th1", created_at: "2026-01-01T00:00:00.000Z" });
		seed({
			id: "t2",
			thread_id: "th1",
			created_at: "2026-01-09T00:00:00.000Z",
			tokens_cache_read: 7,
		});
		softDelete(db, "turns", "t2", SITE);

		const got = findLatestTurnCacheStateByThread(db, "th1");
		expect(got).toEqual({
			created_at: "2026-01-09T00:00:00.000Z",
			tokens_cache_read: 7,
			tokens_cache_write: null,
		});
	});
});

describe("findLatestTurnCreatedAtByThread", () => {
	it("returns the created_at of the latest turn", () => {
		seed({ id: "t1", thread_id: "th1", created_at: "2026-01-01T00:00:00.000Z" });
		seed({ id: "t2", thread_id: "th1", created_at: "2026-01-05T00:00:00.000Z" });
		expect(findLatestTurnCreatedAtByThread(db, "th1")).toEqual({
			created_at: "2026-01-05T00:00:00.000Z",
		});
	});

	it("returns null for an unknown thread", () => {
		expect(findLatestTurnCreatedAtByThread(db, "missing")).toBeNull();
	});
});

describe("findLatestTurnStatusByThreadSince", () => {
	it("returns the latest status at or after the cutoff", () => {
		seed({
			id: "t1",
			thread_id: "th1",
			created_at: "2026-01-01T00:00:00.000Z",
			status: "ok",
		});
		seed({
			id: "t2",
			thread_id: "th1",
			created_at: "2026-01-10T00:00:00.000Z",
			status: "error",
		});
		// since is inclusive (created_at >= ?): boundary row should match.
		expect(findLatestTurnStatusByThreadSince(db, "th1", "2026-01-10T00:00:00.000Z")).toEqual({
			status: "error",
		});
	});

	it("excludes turns strictly before the cutoff", () => {
		seed({
			id: "t1",
			thread_id: "th1",
			created_at: "2026-01-01T00:00:00.000Z",
			status: "ok",
		});
		// Only turn is before the cutoff → null.
		expect(findLatestTurnStatusByThreadSince(db, "th1", "2026-02-01T00:00:00.000Z")).toBeNull();
	});
});

describe("listTurnInflationRatiosByThread", () => {
	it("extracts estimated/actual from context_debug, newest first, capped by lookback", () => {
		seed({
			id: "t1",
			thread_id: "th1",
			created_at: "2026-01-01T00:00:00.000Z",
			context_debug: JSON.stringify({ totalEstimated: 100, actualTotalTokens: 110 }),
		});
		seed({
			id: "t2",
			thread_id: "th1",
			created_at: "2026-01-02T00:00:00.000Z",
			context_debug: JSON.stringify({ totalEstimated: 200, actualTotalTokens: 240 }),
		});
		seed({
			id: "t3",
			thread_id: "th1",
			created_at: "2026-01-03T00:00:00.000Z",
			context_debug: JSON.stringify({ totalEstimated: 300, actualTotalTokens: 360 }),
		});
		// lookback caps at 2 → newest two only.
		expect(listTurnInflationRatiosByThread(db, "th1", 2)).toEqual([
			{ estimated: 300, actual: 360 },
			{ estimated: 200, actual: 240 },
		]);
	});

	it("skips turns with NULL context_debug", () => {
		seed({ id: "t1", thread_id: "th1", created_at: "2026-01-01T00:00:00.000Z" });
		seed({
			id: "t2",
			thread_id: "th1",
			created_at: "2026-01-02T00:00:00.000Z",
			context_debug: JSON.stringify({ totalEstimated: 50, actualTotalTokens: 55 }),
		});
		expect(listTurnInflationRatiosByThread(db, "th1", 10)).toEqual([{ estimated: 50, actual: 55 }]);
	});

	it("uses rowid as the secondary sort key for identical created_at", () => {
		const ts = "2026-01-01T00:00:00.000Z";
		seed({
			id: "a",
			thread_id: "th1",
			created_at: ts,
			context_debug: JSON.stringify({ totalEstimated: 1, actualTotalTokens: 1 }),
		});
		seed({
			id: "b",
			thread_id: "th1",
			created_at: ts,
			context_debug: JSON.stringify({ totalEstimated: 2, actualTotalTokens: 2 }),
		});
		seed({
			id: "c",
			thread_id: "th1",
			created_at: ts,
			context_debug: JSON.stringify({ totalEstimated: 3, actualTotalTokens: 3 }),
		});
		// ORDER BY created_at DESC, rowid DESC → reverse insertion order.
		expect(listTurnInflationRatiosByThread(db, "th1", 10)).toEqual([
			{ estimated: 3, actual: 3 },
			{ estimated: 2, actual: 2 },
			{ estimated: 1, actual: 1 },
		]);
	});

	it("returns [] for a thread with no turns", () => {
		expect(listTurnInflationRatiosByThread(db, "none", 5)).toEqual([]);
	});
});

describe("listStablePrefixDriftTurnsSince", () => {
	it("returns only cold-path turns with a stablePrefixHash, ordered by thread then created_at", () => {
		const cold = (extra: Record<string, unknown>) =>
			JSON.stringify({
				cachePath: "cold",
				stablePrefixHash: "h",
				stablePrefixInputFingerprint: "fp",
				...extra,
			});
		// Eligible cold turns across two threads.
		seed({
			id: "tb2",
			thread_id: "thB",
			created_at: "2026-01-05T00:00:00.000Z",
			context_debug: cold({ stablePrefixHash: "hB2", stablePrefixInputFingerprint: "fpB2" }),
		});
		seed({
			id: "ta1",
			thread_id: "thA",
			created_at: "2026-01-02T00:00:00.000Z",
			context_debug: cold({ stablePrefixHash: "hA1", stablePrefixInputFingerprint: "fpA1" }),
		});
		seed({
			id: "ta2",
			thread_id: "thA",
			created_at: "2026-01-04T00:00:00.000Z",
			context_debug: cold({ stablePrefixHash: "hA2", stablePrefixInputFingerprint: "fpA2" }),
		});
		// Warm-path turn — excluded.
		seed({
			id: "warm",
			thread_id: "thA",
			created_at: "2026-01-03T00:00:00.000Z",
			context_debug: JSON.stringify({ cachePath: "warm", stablePrefixHash: "hW" }),
		});
		// Cold but no hash — excluded.
		seed({
			id: "nohash",
			thread_id: "thA",
			created_at: "2026-01-03T12:00:00.000Z",
			context_debug: JSON.stringify({ cachePath: "cold" }),
		});

		const got = listStablePrefixDriftTurnsSince(db, "2026-01-01T00:00:00.000Z");
		expect(got).toEqual([
			{
				thread_id: "thA",
				created_at: "2026-01-02T00:00:00.000Z",
				hash: "hA1",
				input_fp: "fpA1",
			},
			{
				thread_id: "thA",
				created_at: "2026-01-04T00:00:00.000Z",
				hash: "hA2",
				input_fp: "fpA2",
			},
			{
				thread_id: "thB",
				created_at: "2026-01-05T00:00:00.000Z",
				hash: "hB2",
				input_fp: "fpB2",
			},
		]);
	});

	it("excludes soft-deleted turns (deleted=0 filter)", () => {
		const cold = JSON.stringify({
			cachePath: "cold",
			stablePrefixHash: "h",
			stablePrefixInputFingerprint: "fp",
		});
		seed({
			id: "live",
			thread_id: "thA",
			created_at: "2026-01-02T00:00:00.000Z",
			context_debug: cold,
		});
		seed({
			id: "dead",
			thread_id: "thA",
			created_at: "2026-01-03T00:00:00.000Z",
			context_debug: cold,
		});
		softDelete(db, "turns", "dead", SITE);

		const got = listStablePrefixDriftTurnsSince(db, "2026-01-01T00:00:00.000Z");
		expect(got).toEqual([
			{ thread_id: "thA", created_at: "2026-01-02T00:00:00.000Z", hash: "h", input_fp: "fp" },
		]);
	});

	it("excludes turns before the since cutoff and returns [] when none qualify", () => {
		const cold = JSON.stringify({
			cachePath: "cold",
			stablePrefixHash: "h",
			stablePrefixInputFingerprint: "fp",
		});
		seed({
			id: "old",
			thread_id: "thA",
			created_at: "2026-01-01T00:00:00.000Z",
			context_debug: cold,
		});
		expect(listStablePrefixDriftTurnsSince(db, "2026-02-01T00:00:00.000Z")).toEqual([]);
	});
});

describe("listContextDebugTurnsByThread", () => {
	it("returns context-debug turns oldest first, only those with a payload", () => {
		seed({
			id: "10",
			thread_id: "th1",
			model_id: "m1",
			tokens_in: 100,
			tokens_out: 20,
			tokens_cache_read: 5,
			tokens_cache_write: 3,
			created_at: "2026-01-02T00:00:00.000Z",
			context_debug: JSON.stringify({ x: 1 }),
		});
		seed({
			id: "20",
			thread_id: "th1",
			model_id: "m2",
			tokens_in: 200,
			tokens_out: 40,
			tokens_cache_read: null,
			tokens_cache_write: null,
			created_at: "2026-01-01T00:00:00.000Z",
			context_debug: JSON.stringify({ x: 2 }),
		});
		// No context_debug — excluded.
		seed({ id: "30", thread_id: "th1", created_at: "2026-01-03T00:00:00.000Z" });

		const got = listContextDebugTurnsByThread(db, "th1");
		// NOTE: the finder's return type declares `id: number`, but the `turns.id`
		// column is TEXT (Turn.id is `string`) — SQLite returns the stored string
		// verbatim. We assert the ACTUAL runtime value ("20"/"10"), which exposes a
		// type/reality mismatch in the finder's annotation. See return summary.
		expect(got).toEqual([
			{
				id: "20" as unknown as number,
				model_id: "m2",
				tokens_in: 200,
				tokens_out: 40,
				tokens_cache_read: null,
				tokens_cache_write: null,
				context_debug: JSON.stringify({ x: 2 }),
				created_at: "2026-01-01T00:00:00.000Z",
			},
			{
				id: "10" as unknown as number,
				model_id: "m1",
				tokens_in: 100,
				tokens_out: 20,
				tokens_cache_read: 5,
				tokens_cache_write: 3,
				context_debug: JSON.stringify({ x: 1 }),
				created_at: "2026-01-02T00:00:00.000Z",
			},
		]);
	});

	it("returns [] for an unknown thread", () => {
		expect(listContextDebugTurnsByThread(db, "missing")).toEqual([]);
	});

	it("does NOT exclude soft-deleted rows (no deleted=0 filter)", () => {
		seed({
			id: "1",
			thread_id: "th1",
			model_id: "m1",
			tokens_in: 1,
			tokens_out: 1,
			created_at: "2026-01-01T00:00:00.000Z",
			context_debug: JSON.stringify({ x: 1 }),
		});
		softDelete(db, "turns", "1", SITE);
		const got = listContextDebugTurnsByThread(db, "th1");
		expect(got).toHaveLength(1);
		// id is TEXT at rest (see note above) — returned as the stored string.
		expect(got[0]?.id).toBe("1" as unknown as number);
	});
});

describe("findLatestTurnSpend", () => {
	it("returns the most recent turn's spend columns regardless of thread", () => {
		seed({
			id: "t1",
			thread_id: "thX",
			created_at: "2026-01-01T00:00:00.000Z",
			cost_usd: 0.5,
			tokens_in: 10,
			tokens_out: 2,
		});
		seed({
			id: "t2",
			thread_id: "thY",
			created_at: "2026-01-02T00:00:00.000Z",
			cost_usd: 1.25,
			tokens_in: 30,
			tokens_out: 8,
		});
		expect(findLatestTurnSpend(db)).toEqual({
			cost_usd: 1.25,
			tokens_in: 30,
			tokens_out: 8,
		});
	});

	it("uses rowid DESC to break created_at ties (last inserted wins)", () => {
		const ts = "2026-01-01T00:00:00.000Z";
		seed({ id: "a", created_at: ts, cost_usd: 0.1, tokens_in: 1, tokens_out: 1 });
		seed({ id: "b", created_at: ts, cost_usd: 0.2, tokens_in: 2, tokens_out: 2 });
		expect(findLatestTurnSpend(db)).toEqual({ cost_usd: 0.2, tokens_in: 2, tokens_out: 2 });
	});

	it("returns null when there are no turns", () => {
		expect(findLatestTurnSpend(db)).toBeNull();
	});
});

describe("sumTurnCostForDate", () => {
	it("sums cost_usd for turns on the given calendar day", () => {
		seed({ id: "t1", created_at: "2026-03-01T01:00:00.000Z", cost_usd: 1.0 });
		seed({ id: "t2", created_at: "2026-03-01T23:00:00.000Z", cost_usd: 2.5 });
		// Different day — excluded.
		seed({ id: "t3", created_at: "2026-03-02T00:00:00.000Z", cost_usd: 99 });
		expect(sumTurnCostForDate(db, "2026-03-01")).toEqual({ total: 3.5 });
	});

	it("returns total null when no turns match the date (SUM over zero rows)", () => {
		seed({ id: "t1", created_at: "2026-03-01T00:00:00.000Z", cost_usd: 1.0 });
		expect(sumTurnCostForDate(db, "2026-12-31")).toEqual({ total: null });
	});
});

describe("findMaxTurnCreatedAtByThreadAndTask", () => {
	it("returns MAX(created_at) for the thread+task pair", () => {
		seed({
			id: "t1",
			thread_id: "th1",
			task_id: "task1",
			created_at: "2026-01-01T00:00:00.000Z",
		});
		seed({
			id: "t2",
			thread_id: "th1",
			task_id: "task1",
			created_at: "2026-01-09T00:00:00.000Z",
		});
		// Same thread, different task — excluded.
		seed({
			id: "t3",
			thread_id: "th1",
			task_id: "task2",
			created_at: "2026-02-01T00:00:00.000Z",
		});
		expect(findMaxTurnCreatedAtByThreadAndTask(db, "th1", "task1")).toEqual({
			last_turn_at: "2026-01-09T00:00:00.000Z",
		});
	});

	it("returns last_turn_at null when no rows match (MAX over zero rows)", () => {
		expect(findMaxTurnCreatedAtByThreadAndTask(db, "nope", "nada")).toEqual({
			last_turn_at: null,
		});
	});
});

describe("listModelUsageInRange", () => {
	it("rolls up per-model totals within the window, ordered by total tokens DESC", () => {
		// model-a: two turns in range.
		seed({
			id: "a1",
			model_id: "model-a",
			created_at: "2026-01-02T00:00:00.000Z",
			tokens_in: 100,
			tokens_out: 50,
			tokens_cache_read: 10,
			tokens_cache_write: 5,
			cost_usd: 1.0,
		});
		seed({
			id: "a2",
			model_id: "model-a",
			created_at: "2026-01-03T00:00:00.000Z",
			tokens_in: 200,
			tokens_out: 100,
			tokens_cache_read: null,
			tokens_cache_write: null,
			cost_usd: 2.0,
		});
		// model-b: one smaller turn in range.
		seed({
			id: "b1",
			model_id: "model-b",
			created_at: "2026-01-02T12:00:00.000Z",
			tokens_in: 10,
			tokens_out: 5,
			tokens_cache_read: 1,
			tokens_cache_write: 0,
			cost_usd: 0.1,
		});
		// Out of range — excluded.
		seed({
			id: "old",
			model_id: "model-a",
			created_at: "2025-12-01T00:00:00.000Z",
			tokens_in: 9999,
			tokens_out: 9999,
		});

		const got = listModelUsageInRange(db, "2026-01-01T00:00:00.000Z", "2026-01-31T23:59:59.999Z");
		expect(got).toEqual([
			{
				model_id: "model-a",
				tokens_in: 300,
				tokens_out: 150,
				cache_read: 10, // COALESCE NULL -> 0 then summed
				cache_write: 5,
				cost_usd: 3.0,
				turn_count: 2,
			},
			{
				model_id: "model-b",
				tokens_in: 10,
				tokens_out: 5,
				cache_read: 1,
				cache_write: 0,
				cost_usd: 0.1,
				turn_count: 1,
			},
		]);
	});

	it("excludes soft-deleted turns from the rollup", () => {
		seed({
			id: "live",
			model_id: "model-a",
			created_at: "2026-01-02T00:00:00.000Z",
			tokens_in: 100,
			tokens_out: 10,
			cost_usd: 1.0,
		});
		seed({
			id: "dead",
			model_id: "model-a",
			created_at: "2026-01-02T00:00:00.000Z",
			tokens_in: 500,
			tokens_out: 50,
			cost_usd: 5.0,
		});
		softDelete(db, "turns", "dead", SITE);

		const got = listModelUsageInRange(db, "2026-01-01T00:00:00.000Z", "2026-01-31T23:59:59.999Z");
		expect(got).toEqual([
			{
				model_id: "model-a",
				tokens_in: 100,
				tokens_out: 10,
				cache_read: 0,
				cache_write: 0,
				cost_usd: 1.0,
				turn_count: 1,
			},
		]);
	});

	it("returns [] when no turns fall in the window", () => {
		seed({ id: "t1", created_at: "2026-01-02T00:00:00.000Z", tokens_in: 1, tokens_out: 1 });
		expect(
			listModelUsageInRange(db, "2027-01-01T00:00:00.000Z", "2027-12-31T00:00:00.000Z"),
		).toEqual([]);
	});
});

describe("aggregateUsageTotalsInRange", () => {
	it("aggregates totals + error count over the window, excluding soft-deleted", () => {
		seed({
			id: "ok1",
			model_id: "m",
			created_at: "2026-01-02T00:00:00.000Z",
			tokens_in: 100,
			tokens_out: 20,
			tokens_cache_read: 10,
			tokens_cache_write: null,
			cost_usd: 1.0,
			status: "ok",
		});
		seed({
			id: "err1",
			model_id: "m",
			created_at: "2026-01-03T00:00:00.000Z",
			tokens_in: 50,
			tokens_out: 5,
			tokens_cache_read: null,
			tokens_cache_write: 7,
			cost_usd: 0.5,
			status: "error",
		});
		seed({
			id: "dead",
			model_id: "m",
			created_at: "2026-01-03T00:00:00.000Z",
			tokens_in: 999,
			tokens_out: 999,
			cost_usd: 9.0,
			status: "error",
		});
		softDelete(db, "turns", "dead", SITE);

		expect(
			aggregateUsageTotalsInRange(db, "2026-01-01T00:00:00.000Z", "2026-01-31T23:59:59.999Z"),
		).toEqual({
			tokens_in: 150,
			tokens_out: 25,
			cache_read: 10,
			cache_write: 7,
			cost_usd: 1.5,
			turn_count: 2,
			error_count: 1,
		});
	});

	it("returns NULL SUMs but 0 counts over an empty window", () => {
		// COUNT(*) -> 0; SUM(...) over zero rows -> NULL; SUM(CASE...) -> NULL.
		expect(
			aggregateUsageTotalsInRange(db, "2030-01-01T00:00:00.000Z", "2030-12-31T00:00:00.000Z"),
		).toEqual({
			tokens_in: null,
			tokens_out: null,
			cache_read: null,
			cache_write: null,
			cost_usd: null,
			turn_count: 0,
			error_count: null,
		});
	});
});

describe("aggregateContextDebugHealthInRange", () => {
	it("counts budget-pressure turns and averages truncated messages over debug turns", () => {
		seed({
			id: "d1",
			created_at: "2026-01-02T00:00:00.000Z",
			context_debug: JSON.stringify({ budgetPressure: 1, truncated: 4 }),
		});
		seed({
			id: "d2",
			created_at: "2026-01-03T00:00:00.000Z",
			context_debug: JSON.stringify({ budgetPressure: 0, truncated: 2 }),
		});
		// Missing `truncated` -> COALESCE to 0 in the average.
		seed({
			id: "d3",
			created_at: "2026-01-04T00:00:00.000Z",
			context_debug: JSON.stringify({ budgetPressure: 1 }),
		});
		// No context_debug -> excluded entirely.
		seed({ id: "nodebug", created_at: "2026-01-05T00:00:00.000Z" });

		expect(
			aggregateContextDebugHealthInRange(
				db,
				"2026-01-01T00:00:00.000Z",
				"2026-01-31T23:59:59.999Z",
			),
		).toEqual({
			total_turns_with_debug: 3,
			budget_pressure_count: 2,
			avg_truncated_messages: (4 + 2 + 0) / 3,
		});
	});

	it("returns 0 count and null average over an empty window", () => {
		// COUNT(*) -> 0; SUM(CASE...) -> NULL; AVG over zero rows -> NULL.
		expect(
			aggregateContextDebugHealthInRange(
				db,
				"2030-01-01T00:00:00.000Z",
				"2030-12-31T00:00:00.000Z",
			),
		).toEqual({
			total_turns_with_debug: 0,
			budget_pressure_count: null,
			avg_truncated_messages: null,
		});
	});
});

describe("findLatestCacheHitRateInRange", () => {
	it("returns the cache-hit rate of the most recent qualifying turn", () => {
		// Older turn: rate = 30 / (30 + 70) = 0.3.
		seed({
			id: "old",
			created_at: "2026-01-02T00:00:00.000Z",
			tokens_in: 70,
			tokens_out: 1,
			tokens_cache_read: 30,
			context_debug: JSON.stringify({ x: 1 }),
		});
		// Newest turn: rate = 90 / (90 + 10) = 0.9 — this one wins.
		seed({
			id: "new",
			created_at: "2026-01-05T00:00:00.000Z",
			tokens_in: 10,
			tokens_out: 1,
			tokens_cache_read: 90,
			context_debug: JSON.stringify({ x: 2 }),
		});
		expect(
			findLatestCacheHitRateInRange(db, "2026-01-01T00:00:00.000Z", "2026-01-31T23:59:59.999Z"),
		).toEqual({ cache_hit_rate: 0.9 });
	});

	it("skips turns where cache_read + tokens_in is 0 (guards divide-by-zero)", () => {
		// Newest by time but denominator is 0 → must be skipped.
		seed({
			id: "zero",
			created_at: "2026-01-09T00:00:00.000Z",
			tokens_in: 0,
			tokens_out: 1,
			tokens_cache_read: 0,
			context_debug: JSON.stringify({ x: 1 }),
		});
		// Older but valid: 25 / (25 + 75) = 0.25.
		seed({
			id: "valid",
			created_at: "2026-01-03T00:00:00.000Z",
			tokens_in: 75,
			tokens_out: 1,
			tokens_cache_read: 25,
			context_debug: JSON.stringify({ x: 2 }),
		});
		expect(
			findLatestCacheHitRateInRange(db, "2026-01-01T00:00:00.000Z", "2026-01-31T23:59:59.999Z"),
		).toEqual({ cache_hit_rate: 0.25 });
	});

	it("requires context_debug to be present", () => {
		seed({
			id: "nodebug",
			created_at: "2026-01-03T00:00:00.000Z",
			tokens_in: 50,
			tokens_out: 1,
			tokens_cache_read: 50,
		});
		expect(
			findLatestCacheHitRateInRange(db, "2026-01-01T00:00:00.000Z", "2026-01-31T23:59:59.999Z"),
		).toBeNull();
	});

	it("returns null over an empty window", () => {
		expect(
			findLatestCacheHitRateInRange(db, "2030-01-01T00:00:00.000Z", "2030-12-31T00:00:00.000Z"),
		).toBeNull();
	});
});
