import type { Database } from "bun:sqlite";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyMetricsSchema, applySchema, createDatabase } from "@bound/core";
import { cleanupTmpDir } from "@bound/shared/test-utils";
import { computeInflationRatio, resolveAdaptiveTruncationRatio } from "../inflation-ratio";

describe("computeInflationRatio — per-thread tiktoken vs actual ratio", () => {
	let db: Database;
	let tmpDir: string;
	let threadId: string;

	beforeAll(() => {
		tmpDir = mkdtempSync(join(tmpdir(), "inflation-ratio-test-"));
		const dbPath = join(tmpDir, "test.db");
		db = createDatabase(dbPath);
		applySchema(db);
		applyMetricsSchema(db);
	});

	afterAll(async () => {
		db.close();
		if (tmpDir) {
			await cleanupTmpDir(tmpDir);
		}
	});

	beforeEach(() => {
		// Each test uses a fresh thread id to avoid cross-pollution
		threadId = randomUUID();
	});

	function insertTurn(
		ts: Date,
		options: {
			estimated: number | null;
			actualTotal: number | null;
			tokensIn?: number;
		},
	): void {
		const ctxDebug =
			options.estimated === null && options.actualTotal === null
				? null
				: JSON.stringify({
						contextWindow: 200000,
						totalEstimated: options.estimated ?? 0,
						actualTotalTokens: options.actualTotal,
						model: "opus",
						sections: [],
						budgetPressure: false,
						truncated: 0,
					});

		db.prepare(`
			INSERT INTO turns (id, thread_id, model_id, tokens_in, tokens_out, cost_usd, created_at, context_debug)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?)
		`).run(
			randomUUID(),
			threadId,
			"opus",
			options.tokensIn ?? 1000,
			500,
			0.01,
			ts.toISOString(),
			ctxDebug,
		);
	}

	it("returns null when the thread has no turns", () => {
		const ratio = computeInflationRatio(db, threadId);
		expect(ratio).toBeNull();
	});

	it("returns null gracefully when the turns table does not exist (test harness)", () => {
		// Many older agent tests build a DB with applySchema only and skip
		// applyMetricsSchema. The agent loop calls into here on every
		// assembly, so the helper must not crash — it must report "no data"
		// and let callers fall back to the base ratio.
		const noMetricsDir = mkdtempSync(join(tmpdir(), "inflation-ratio-no-metrics-"));
		const noMetricsPath = join(noMetricsDir, "test.db");
		const noMetricsDb = createDatabase(noMetricsPath);
		try {
			applySchema(noMetricsDb);
			expect(computeInflationRatio(noMetricsDb, threadId)).toBeNull();
		} finally {
			noMetricsDb.close();
			void cleanupTmpDir(noMetricsDir);
		}
	});

	it("returns null when fewer than the minimum sample size of usable turns exist", () => {
		// 2 usable turns < default minSamples (3)
		const t0 = new Date("2026-05-22T10:00:00Z");
		insertTurn(t0, { estimated: 100000, actualTotal: 230000 });
		insertTurn(new Date(t0.getTime() + 1000), { estimated: 100000, actualTotal: 230000 });

		expect(computeInflationRatio(db, threadId)).toBeNull();
	});

	it("computes the arithmetic mean of (actual / estimated) across the last N turns", () => {
		const t0 = new Date("2026-05-22T11:00:00Z");
		// Three turns with ratios 2.0, 2.5, 3.0 — mean = 2.5
		insertTurn(t0, { estimated: 100000, actualTotal: 200000 });
		insertTurn(new Date(t0.getTime() + 1000), { estimated: 100000, actualTotal: 250000 });
		insertTurn(new Date(t0.getTime() + 2000), { estimated: 100000, actualTotal: 300000 });

		const ratio = computeInflationRatio(db, threadId);
		expect(ratio).toBeCloseTo(2.5, 5);
	});

	it("uses only the most recent N turns when more than the lookback exist", () => {
		const t0 = new Date("2026-05-22T12:00:00Z");
		// Stale baseline (low inflation) followed by recent burst (high inflation).
		// With lookback=3 we should see only the recent ratios.
		insertTurn(t0, { estimated: 100000, actualTotal: 110000 });
		insertTurn(new Date(t0.getTime() + 1000), { estimated: 100000, actualTotal: 110000 });
		insertTurn(new Date(t0.getTime() + 2000), { estimated: 100000, actualTotal: 110000 });
		insertTurn(new Date(t0.getTime() + 3000), { estimated: 100000, actualTotal: 240000 });
		insertTurn(new Date(t0.getTime() + 4000), { estimated: 100000, actualTotal: 240000 });
		insertTurn(new Date(t0.getTime() + 5000), { estimated: 100000, actualTotal: 240000 });

		const ratio = computeInflationRatio(db, threadId, 3);
		expect(ratio).toBeCloseTo(2.4, 5);
	});

	it("ignores turns with null actualTotalTokens (pre-fix DB rows)", () => {
		const t0 = new Date("2026-05-22T13:00:00Z");
		// 3 valid samples + 5 pre-fix nulls. Mean over the 3 valid: 2.4.
		insertTurn(t0, { estimated: 100000, actualTotal: null });
		insertTurn(new Date(t0.getTime() + 1000), { estimated: 100000, actualTotal: null });
		insertTurn(new Date(t0.getTime() + 2000), { estimated: 100000, actualTotal: null });
		insertTurn(new Date(t0.getTime() + 3000), { estimated: 100000, actualTotal: null });
		insertTurn(new Date(t0.getTime() + 4000), { estimated: 100000, actualTotal: null });
		insertTurn(new Date(t0.getTime() + 5000), { estimated: 100000, actualTotal: 240000 });
		insertTurn(new Date(t0.getTime() + 6000), { estimated: 100000, actualTotal: 240000 });
		insertTurn(new Date(t0.getTime() + 7000), { estimated: 100000, actualTotal: 240000 });

		const ratio = computeInflationRatio(db, threadId);
		expect(ratio).toBeCloseTo(2.4, 5);
	});

	it("ignores turns with totalEstimated <= 0 to avoid division-by-zero", () => {
		const t0 = new Date("2026-05-22T14:00:00Z");
		insertTurn(t0, { estimated: 0, actualTotal: 200000 });
		insertTurn(new Date(t0.getTime() + 1000), { estimated: 100000, actualTotal: 200000 });
		insertTurn(new Date(t0.getTime() + 2000), { estimated: 100000, actualTotal: 200000 });
		insertTurn(new Date(t0.getTime() + 3000), { estimated: 100000, actualTotal: 200000 });

		const ratio = computeInflationRatio(db, threadId);
		// Mean of three valid ratios (2.0 each), zero-estimate row excluded.
		expect(ratio).toBeCloseTo(2.0, 5);
	});

	it("returns null when no turns have valid actualTotalTokens (all pre-fix)", () => {
		const t0 = new Date("2026-05-22T15:00:00Z");
		insertTurn(t0, { estimated: 100000, actualTotal: null });
		insertTurn(new Date(t0.getTime() + 1000), { estimated: 100000, actualTotal: null });
		insertTurn(new Date(t0.getTime() + 2000), { estimated: 100000, actualTotal: null });

		expect(computeInflationRatio(db, threadId)).toBeNull();
	});

	it("resolves to the base ratio when no usable history exists (cold start)", () => {
		// Empty thread → null from computeInflationRatio → resolved ratio
		// equals the supplied base. New threads get the original 0.85 budget
		// until they accumulate enough turns to measure their own inflation.
		expect(resolveAdaptiveTruncationRatio(db, threadId, 0.85)).toBeCloseTo(0.85, 5);
	});

	it("tightens the ratio proportionally to measured inflation (option 2)", () => {
		const t0 = new Date("2026-05-22T19:00:00Z");
		// Three turns showing 2.0x inflation (LLM input is twice tiktoken estimate)
		insertTurn(t0, { estimated: 100000, actualTotal: 200000 });
		insertTurn(new Date(t0.getTime() + 1000), { estimated: 100000, actualTotal: 200000 });
		insertTurn(new Date(t0.getTime() + 2000), { estimated: 100000, actualTotal: 200000 });

		// 0.85 base / 2.0 inflation = 0.425
		expect(resolveAdaptiveTruncationRatio(db, threadId, 0.85)).toBeCloseTo(0.425, 5);
	});

	it("does NOT loosen the ratio when inflation < 1.0 (estimator overcounts)", () => {
		const t0 = new Date("2026-05-22T20:00:00Z");
		// Three turns showing 0.8x — tiktoken overestimated. The clamp at 1.0
		// prevents us from raising the truncation ratio above its base, since
		// loosening would risk blowing the configured forcing budget on the
		// next turn that swings back over the line.
		insertTurn(t0, { estimated: 100000, actualTotal: 80000 });
		insertTurn(new Date(t0.getTime() + 1000), { estimated: 100000, actualTotal: 80000 });
		insertTurn(new Date(t0.getTime() + 2000), { estimated: 100000, actualTotal: 80000 });

		expect(resolveAdaptiveTruncationRatio(db, threadId, 0.85)).toBeCloseTo(0.85, 5);
	});

	it("scopes ratios to the requested thread (does not pollute across threads)", () => {
		const otherThread = randomUUID();
		const t0 = new Date("2026-05-22T16:00:00Z");

		// Three turns on the other thread with high inflation
		const savedThreadId = threadId;
		threadId = otherThread;
		insertTurn(t0, { estimated: 100000, actualTotal: 500000 });
		insertTurn(new Date(t0.getTime() + 1000), { estimated: 100000, actualTotal: 500000 });
		insertTurn(new Date(t0.getTime() + 2000), { estimated: 100000, actualTotal: 500000 });
		threadId = savedThreadId;

		// Three turns on our thread with low inflation
		insertTurn(t0, { estimated: 100000, actualTotal: 110000 });
		insertTurn(new Date(t0.getTime() + 1000), { estimated: 100000, actualTotal: 110000 });
		insertTurn(new Date(t0.getTime() + 2000), { estimated: 100000, actualTotal: 110000 });

		expect(computeInflationRatio(db, threadId)).toBeCloseTo(1.1, 5);
		expect(computeInflationRatio(db, otherThread)).toBeCloseTo(5.0, 5);
	});

	// Regression: thread c879be2b-fe29-421d-b1a6-b9b1579e5648 (2026-05-24).
	// The pre-fix agent-loop wrote actualTotalTokens = inputTokens +
	// cacheReadTokens + cacheWriteTokens. Both AI SDK Bedrock@4.x and
	// Anthropic@3.x already sum (raw_input + cR + cW) into the standardized
	// `inputTokens` they yield, so this addition was double-counting on every
	// cache-write turn. The result was a recorded inflation of ~2.7x on
	// cache-write turns (live data) versus ~1.4x on no-cache turns —
	// poisoning the EMA, monotonically tightening the adaptive truncation
	// ratio, and forcing warm-path budget bails forever.
	//
	// This test pins the EMA's healthy band against a synthetic Bedrock-like
	// turn sequence where actualTotalTokens has been recorded correctly.
	// Inflation should stay in 1.3-1.5x (legit tiktoken-vs-Bedrock drift on
	// opus), and effective truncation ratio should NOT collapse below 0.5.
	it("inflation EMA stays in healthy band when actualTotalTokens excludes double-counting", () => {
		const t0 = new Date("2026-05-23T20:00:00Z");

		// Realistic turn sequence inspired by the live thread: 10 turns
		// alternating cache-write and cache-read, all opus, with a
		// consistent tiktoken-vs-actual ratio of ~1.4x.
		// Each turn's `actual` is what the agent loop NOW writes:
		// just `inputTokens` (which the AI SDK provider already summed
		// to include cached tokens).
		const turns = [
			// Cold turn: cache_write only
			{ estimated: 167666, actualTotal: 248613 }, // ratio 1.483
			// Warm turn: cache_read only — same total prompt size, so
			// actualTotal stays close to the cold turn value.
			{ estimated: 175352, actualTotal: 249804 }, // ratio 1.425
			{ estimated: 169302, actualTotal: 247599 }, // ratio 1.462
			{ estimated: 166950, actualTotal: 247101 }, // ratio 1.480
			{ estimated: 168000, actualTotal: 248000 }, // ratio 1.476
			{ estimated: 170000, actualTotal: 245000 }, // ratio 1.441
			{ estimated: 172000, actualTotal: 250000 }, // ratio 1.453
			{ estimated: 174000, actualTotal: 248000 }, // ratio 1.425
			{ estimated: 176000, actualTotal: 252000 }, // ratio 1.432
			{ estimated: 178000, actualTotal: 250000 }, // ratio 1.404
		];
		for (let i = 0; i < turns.length; i++) {
			insertTurn(new Date(t0.getTime() + i * 1000), turns[i]);
		}

		const ratio = computeInflationRatio(db, threadId);
		// Healthy band — pre-fix this would have spiked to 2.0+ on the
		// cache-write turns (due to actualTotalTokens being doubled).
		expect(ratio).not.toBeNull();
		// biome-ignore lint/style/noNonNullAssertion: just asserted above
		expect(ratio!).toBeGreaterThan(1.3);
		// biome-ignore lint/style/noNonNullAssertion: just asserted above
		expect(ratio!).toBeLessThan(1.55);

		// Adaptive truncation ratio derived from this EMA must stay
		// well above 0.5. If it drops below, the spiral has returned.
		const adaptive = resolveAdaptiveTruncationRatio(db, threadId, 0.85);
		expect(adaptive).toBeGreaterThan(0.55);
		// And of course it should still be tightened from the base
		// (otherwise we'd be ignoring the legit drift entirely).
		expect(adaptive).toBeLessThan(0.65);
	});

	// Regression: pre-fix simulation of the SAME thread WITH the
	// double-counting bug active. This test documents what the bad
	// numerator looked like — included for forensic clarity. The
	// adaptive ratio collapse below 0.5 it produces is what the live
	// thread experienced, and what the cache-aware EMA fix prevents.
	it("documents the pre-fix collapse: doubled actualTotalTokens drives ratio below 0.5", () => {
		const t0 = new Date("2026-05-23T21:00:00Z");

		// What pre-fix would have written: input + cR + cW = ~2x the
		// real prompt size on cache-write turns.
		const turns = [
			{ estimated: 167666, actualTotal: 248613 }, // cold (matches post-fix)
			{ estimated: 175352, actualTotal: 495000 }, // cache-write turn DOUBLED
			{ estimated: 169302, actualTotal: 480000 }, // cache-write turn DOUBLED
			{ estimated: 166950, actualTotal: 247101 }, // cold
			{ estimated: 168000, actualTotal: 490000 }, // cache-write turn DOUBLED
			{ estimated: 170000, actualTotal: 245000 }, // cold
			{ estimated: 172000, actualTotal: 500000 }, // cache-write turn DOUBLED
			{ estimated: 174000, actualTotal: 248000 }, // cold
			{ estimated: 176000, actualTotal: 510000 }, // cache-write turn DOUBLED
			{ estimated: 178000, actualTotal: 250000 }, // cold
		];
		for (let i = 0; i < turns.length; i++) {
			insertTurn(new Date(t0.getTime() + i * 1000), turns[i]);
		}

		const ratio = computeInflationRatio(db, threadId);
		// Pre-fix EMA would land near 2.0x — the average of ~1.4 cold
		// turns and ~2.8 cache-write turns. This is the BAD state we
		// fixed; if the EMA reads this on real data, the double-count
		// bug has been re-introduced.
		expect(ratio).not.toBeNull();
		// biome-ignore lint/style/noNonNullAssertion: just asserted above
		expect(ratio!).toBeGreaterThan(1.8);

		// And the adaptive ratio collapses past 0.5 — the warm-path
		// budget bails on every turn under this load.
		const adaptive = resolveAdaptiveTruncationRatio(db, threadId, 0.85);
		expect(adaptive).toBeLessThan(0.5);
	});
});
