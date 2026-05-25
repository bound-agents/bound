/**
 * Property tests for `resolveAdaptiveTruncation` and the underlying
 * inflation-EMA computation.
 *
 * The adaptive truncation ratio is the gate that converts measured
 * tiktoken-vs-actual inflation into a tightened truncation ratio.
 * Two concrete failure modes have been fixed historically (memory
 * notes "Live Debugging Session 5" and the cache-aware EMA fix
 * in 2026-05-24); both surfaced as silent over-truncation OR
 * under-truncation in production.
 *
 * Properties:
 *
 *   A1 Bounds — for any inflation EMA, the resolved ratio is in
 *      [0, baseRatio]. Specifically: it can never EXCEED baseRatio
 *      (the clamp at inflation < 1.0). And it can never be
 *      negative.
 *
 *   A2 Monotonicity in inflation — for two threads where thread B
 *      has higher inflation than thread A, B's resolved ratio is
 *      ≤ A's. Higher inflation = tighter ratio.
 *
 *   A3 Cold-start fallback — a thread with insufficient samples
 *      (< MIN_SAMPLES) returns baseRatio exactly with `inflation:
 *      null`.
 *
 *   A4 Determinism — same DB state, same threadId, same baseRatio
 *      => same result.
 *
 *   A5 Inflation = 1.0 → ratio = baseRatio (no tightening when
 *      estimator is accurate).
 *
 *   A6 Inflation N → ratio = baseRatio / N for N >= 1.
 */

import Database from "bun:sqlite";
import { describe, it } from "bun:test";
import { applyMetricsSchema, applySchema } from "@bound/core";
import fc from "fast-check";
import { resolveAdaptiveTruncation } from "../inflation-ratio";

function freshDb(): Database {
	const db = new Database(":memory:");
	applySchema(db);
	applyMetricsSchema(db);
	return db;
}

const THREAD_ID = "test-thread";

function seedTurns(
	db: Database,
	threadId: string,
	estimatedActualPairs: Array<[number, number]>,
): void {
	for (let i = 0; i < estimatedActualPairs.length; i++) {
		const [estimated, actual] = estimatedActualPairs[i];
		const ts = new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString();
		const debug = JSON.stringify({
			contextWindow: 200000,
			totalEstimated: estimated,
			actualTotalTokens: actual,
		});
		// Primary key includes the thread id so callers seeding
		// multiple threads don't collide on `turn-<i>`.
		db.prepare(
			`INSERT INTO turns (
				id, thread_id, model_id, tokens_in, tokens_out, created_at,
				modified_at, host_origin, deleted, context_debug
			) VALUES (?, ?, 'test', 0, 0, ?, ?, 'test', 0, ?)`,
		).run(`${threadId}-turn-${i}`, threadId, ts, ts, debug);
	}
}

describe("resolveAdaptiveTruncation — property tests", () => {
	it("A1: bounds — ratio always in [0, baseRatio]", () => {
		fc.assert(
			fc.property(
				fc.array(
					fc.tuple(fc.integer({ min: 1, max: 1_000_000 }), fc.integer({ min: 1, max: 5_000_000 })),
					{
						minLength: 0,
						maxLength: 12,
					},
				),
				fc.double({ min: 0.1, max: 1.0, noNaN: true }),
				(pairs, baseRatio) => {
					const db = freshDb();
					seedTurns(db, THREAD_ID, pairs);
					const { ratio } = resolveAdaptiveTruncation(db, THREAD_ID, baseRatio);
					db.close();
					return ratio >= 0 && ratio <= baseRatio + 1e-9;
				},
			),
			{ numRuns: 50 },
		);
	});

	it("A2: monotonicity in inflation — higher inflation thread => tighter or equal ratio", () => {
		fc.assert(
			fc.property(
				fc.integer({ min: 1, max: 100_000 }),
				fc.integer({ min: 100_001, max: 500_000 }),
				fc.integer({ min: 500_001, max: 2_000_000 }),
				(estimated, actualA, actualB) => {
					if (actualA >= actualB) return true; // ensure B has strictly higher inflation
					const db = freshDb();
					// 5 turns each, distinct thread_ids
					seedTurns(db, "thread-A", Array(5).fill([estimated, actualA]));
					seedTurns(db, "thread-B", Array(5).fill([estimated, actualB]));
					const a = resolveAdaptiveTruncation(db, "thread-A", 0.85);
					const b = resolveAdaptiveTruncation(db, "thread-B", 0.85);
					db.close();
					return b.ratio <= a.ratio + 1e-9;
				},
			),
			{ numRuns: 30 },
		);
	});

	it("A3: cold-start fallback — < min samples returns baseRatio with null inflation", () => {
		fc.assert(
			fc.property(
				fc.array(
					fc.tuple(fc.integer({ min: 1, max: 100_000 }), fc.integer({ min: 1, max: 200_000 })),
					{
						maxLength: 2, // below the 3-sample minimum
					},
				),
				fc.double({ min: 0.1, max: 1.0, noNaN: true }),
				(pairs, baseRatio) => {
					const db = freshDb();
					seedTurns(db, THREAD_ID, pairs);
					const { ratio, inflation } = resolveAdaptiveTruncation(db, THREAD_ID, baseRatio);
					db.close();
					return Math.abs(ratio - baseRatio) < 1e-9 && inflation === null;
				},
			),
			{ numRuns: 30 },
		);
	});

	it("A4: determinism — same DB state, same input => same output", () => {
		fc.assert(
			fc.property(
				fc.array(
					fc.tuple(fc.integer({ min: 1, max: 100_000 }), fc.integer({ min: 1, max: 500_000 })),
					{
						minLength: 3,
						maxLength: 10,
					},
				),
				(pairs) => {
					const db = freshDb();
					seedTurns(db, THREAD_ID, pairs);
					const a = resolveAdaptiveTruncation(db, THREAD_ID, 0.85);
					const b = resolveAdaptiveTruncation(db, THREAD_ID, 0.85);
					db.close();
					return a.ratio === b.ratio && a.inflation === b.inflation;
				},
			),
			{ numRuns: 30 },
		);
	});

	it("A5: inflation = 1.0 → ratio = baseRatio (no tightening when accurate)", () => {
		const db = freshDb();
		// 5 turns where actual == estimated (perfect estimator).
		seedTurns(db, THREAD_ID, Array(5).fill([100_000, 100_000]));
		const { ratio, inflation } = resolveAdaptiveTruncation(db, THREAD_ID, 0.85);
		db.close();
		if (inflation === null) throw new Error("expected non-null inflation");
		if (Math.abs(inflation - 1.0) > 1e-9) {
			throw new Error(`expected inflation 1.0, got ${inflation}`);
		}
		if (Math.abs(ratio - 0.85) > 1e-9) {
			throw new Error(`expected ratio 0.85, got ${ratio}`);
		}
	});

	it("A6: inflation N → ratio = baseRatio / N (for N > 1)", () => {
		fc.assert(
			fc.property(fc.double({ min: 1.5, max: 5.0, noNaN: true }), (inflationFactor) => {
				const db = freshDb();
				const estimated = 100_000;
				const actual = Math.round(estimated * inflationFactor);
				seedTurns(db, THREAD_ID, Array(5).fill([estimated, actual]));
				const { ratio, inflation } = resolveAdaptiveTruncation(db, THREAD_ID, 0.85);
				db.close();
				if (inflation === null) return false;
				const expected = 0.85 / inflationFactor;
				return Math.abs(ratio - expected) < 0.01;
			}),
			{ numRuns: 30 },
		);
	});
});
