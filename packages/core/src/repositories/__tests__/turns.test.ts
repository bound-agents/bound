import type Database from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { Turn } from "@bound/shared";
import { createCoreTestDb } from "../../__tests__/test-database";
import { insertRow, softDelete } from "../../index";
import {
	computeEffectiveCacheWindowMs,
	findLatestTurnCacheStateByThread,
	findMaxTurnCreatedAtByThreadAndTask,
	listContextDebugTurnsByThread,
	listTurnsByThread,
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
		cost_breakdown: overrides.cost_breakdown ?? null,
		route_id: overrides.route_id ?? null,
		substituted_from: overrides.substituted_from ?? null,
		host_origin: overrides.host_origin ?? null,
		modified_at: overrides.modified_at ?? null,
	};
}

function seed(overrides: Partial<Turn> & { id: string }): void {
	insertRow(db, "turns", makeTurn(overrides), SITE);
}

beforeEach(() => {
	db = createCoreTestDb({ metrics: true });
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

describe("listTurnsByThread", () => {
	it("returns non-deleted turns for the thread oldest-first with provenance columns", () => {
		seed({
			id: "t2",
			thread_id: "th1",
			created_at: "2026-01-02T00:00:00.000Z",
			model_id: "gpt-5.6-sol",
			route_id: "siteB:codex:sol",
			substituted_from: "opus-4.8",
			cost_usd: 0.5,
			cost_breakdown: JSON.stringify({ input: 0.4, output: 0.1, cacheRead: 0, cacheWrite: 0 }),
		});
		seed({
			id: "t1",
			thread_id: "th1",
			created_at: "2026-01-01T00:00:00.000Z",
			model_id: "opus-4.8",
			route_id: "siteA:anthropic:opus",
		});
		// Another thread's turn must not leak in.
		seed({ id: "t3", thread_id: "th2", created_at: "2026-01-03T00:00:00.000Z" });

		const got = listTurnsByThread(db, "th1");
		expect(got.map((t) => t.id)).toEqual(["t1", "t2"]);
		expect(got[1]).toEqual({
			id: "t2",
			created_at: "2026-01-02T00:00:00.000Z",
			model_id: "gpt-5.6-sol",
			route_id: "siteB:codex:sol",
			substituted_from: "opus-4.8",
			status: null,
			cost_usd: 0.5,
			cost_breakdown: JSON.stringify({ input: 0.4, output: 0.1, cacheRead: 0, cacheWrite: 0 }),
		});
	});

	it("excludes soft-deleted turns", () => {
		seed({ id: "t1", thread_id: "th1", created_at: "2026-01-01T00:00:00.000Z" });
		seed({ id: "t2", thread_id: "th1", created_at: "2026-01-02T00:00:00.000Z" });
		softDelete(db, "turns", "t2", SITE);
		expect(listTurnsByThread(db, "th1").map((t) => t.id)).toEqual(["t1"]);
	});

	it("returns an empty array for a thread with no turns", () => {
		expect(listTurnsByThread(db, "missing")).toEqual([]);
	});
});

describe("computeEffectiveCacheWindowMs", () => {
	const ROUTE = "siteA:bedrock:haiku";

	it("returns null when the route has no turns", () => {
		expect(computeEffectiveCacheWindowMs(db, ROUTE, { nowIso: "2026-01-01T12:00:00.000Z" })).toBe(
			null,
		);
	});

	it("returns null when the route never produced a cache read", () => {
		// Two consecutive turns on the route, but the later one read nothing from
		// cache — so no measured gap is a confirmed warm window.
		seed({
			id: "t1",
			thread_id: "th1",
			route_id: ROUTE,
			created_at: "2026-01-01T10:00:00.000Z",
			tokens_cache_read: 0,
		});
		seed({
			id: "t2",
			thread_id: "th1",
			route_id: ROUTE,
			created_at: "2026-01-01T10:20:00.000Z",
			tokens_cache_read: 0,
		});
		expect(computeEffectiveCacheWindowMs(db, ROUTE, { nowIso: "2026-01-01T12:00:00.000Z" })).toBe(
			null,
		);
	});

	it("measures the gap before a turn that reported a cache read", () => {
		// First turn writes the cache; 20 minutes later the second turn reads it.
		// The effective window is at least that 20-minute gap.
		seed({
			id: "t1",
			thread_id: "th1",
			route_id: ROUTE,
			created_at: "2026-01-01T10:00:00.000Z",
			tokens_cache_read: 0,
		});
		seed({
			id: "t2",
			thread_id: "th1",
			route_id: ROUTE,
			created_at: "2026-01-01T10:20:00.000Z",
			tokens_cache_read: 1200,
		});
		expect(computeEffectiveCacheWindowMs(db, ROUTE, { nowIso: "2026-01-01T12:00:00.000Z" })).toBe(
			20 * 60 * 1000,
		);
	});

	it("returns the LONGEST cache-read-followed gap across the route", () => {
		// 10m gap (read), then a 45m gap (read). The longest confirmed-warm gap wins.
		seed({
			id: "t1",
			thread_id: "th1",
			route_id: ROUTE,
			created_at: "2026-01-01T10:00:00.000Z",
			tokens_cache_read: 0,
		});
		seed({
			id: "t2",
			thread_id: "th1",
			route_id: ROUTE,
			created_at: "2026-01-01T10:10:00.000Z",
			tokens_cache_read: 500,
		});
		seed({
			id: "t3",
			thread_id: "th1",
			route_id: ROUTE,
			created_at: "2026-01-01T10:55:00.000Z",
			tokens_cache_read: 800,
		});
		expect(computeEffectiveCacheWindowMs(db, ROUTE, { nowIso: "2026-01-01T12:00:00.000Z" })).toBe(
			45 * 60 * 1000,
		);
	});

	it("only measures gaps between consecutive turns WITHIN one thread", () => {
		// A read on thread th2 must not be attributed to a th1 turn's write: the gap
		// is per-thread, since a cache prefix is thread-scoped.
		seed({
			id: "a1",
			thread_id: "th1",
			route_id: ROUTE,
			created_at: "2026-01-01T10:00:00.000Z",
			tokens_cache_read: 0,
		});
		seed({
			id: "b1",
			thread_id: "th2",
			route_id: ROUTE,
			created_at: "2026-01-01T10:05:00.000Z",
			tokens_cache_read: 0,
		});
		// th1's second turn reads cache 30m after th1's first.
		seed({
			id: "a2",
			thread_id: "th1",
			route_id: ROUTE,
			created_at: "2026-01-01T10:30:00.000Z",
			tokens_cache_read: 700,
		});
		expect(computeEffectiveCacheWindowMs(db, ROUTE, { nowIso: "2026-01-01T12:00:00.000Z" })).toBe(
			30 * 60 * 1000,
		);
	});

	it("ignores turns from other routes", () => {
		seed({
			id: "t1",
			thread_id: "th1",
			route_id: "siteA:bedrock:other",
			created_at: "2026-01-01T10:00:00.000Z",
			tokens_cache_read: 0,
		});
		seed({
			id: "t2",
			thread_id: "th1",
			route_id: "siteA:bedrock:other",
			created_at: "2026-01-01T10:40:00.000Z",
			tokens_cache_read: 900,
		});
		expect(computeEffectiveCacheWindowMs(db, ROUTE, { nowIso: "2026-01-01T12:00:00.000Z" })).toBe(
			null,
		);
	});

	it("bounds the lookback to the recent window (24h, anchored to the longest retention Bound requests)", () => {
		// A warm gap 30h ago is older than the 24h lookback bound and is excluded:
		// Bound never requests a retention longer than 24h, so a gap older than that
		// cannot describe a currently-live cache window.
		seed({
			id: "old1",
			thread_id: "th1",
			route_id: ROUTE,
			created_at: "2026-01-01T06:00:00.000Z",
			tokens_cache_read: 0,
		});
		seed({
			id: "old2",
			thread_id: "th1",
			route_id: ROUTE,
			created_at: "2026-01-01T07:00:00.000Z",
			tokens_cache_read: 1000,
		});
		// now is 2026-01-02T13:00:00Z → the gap above ended >24h ago.
		expect(computeEffectiveCacheWindowMs(db, ROUTE, { nowIso: "2026-01-02T13:00:00.000Z" })).toBe(
			null,
		);
	});

	it("excludes soft-deleted turns from the gap measurement", () => {
		seed({
			id: "t1",
			thread_id: "th1",
			route_id: ROUTE,
			created_at: "2026-01-01T10:00:00.000Z",
			tokens_cache_read: 0,
		});
		seed({
			id: "t2",
			thread_id: "th1",
			route_id: ROUTE,
			created_at: "2026-01-01T10:20:00.000Z",
			tokens_cache_read: 1200,
		});
		softDelete(db, "turns", "t2", SITE);
		expect(computeEffectiveCacheWindowMs(db, ROUTE, { nowIso: "2026-01-01T12:00:00.000Z" })).toBe(
			null,
		);
	});
});
