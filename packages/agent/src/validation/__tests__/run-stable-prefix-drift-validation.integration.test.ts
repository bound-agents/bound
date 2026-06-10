import Database from "bun:sqlite";
import { beforeEach, describe, expect, it } from "bun:test";
import { applyMetricsSchema, applySchema } from "@bound/core";
import {
	runStablePrefixDriftValidation,
	shouldRunStablePrefixDriftValidation,
} from "../run-stable-prefix-drift-validation";

const SITE_ID = "test-site";

function insertColdTurn(
	db: Database,
	turnId: string,
	threadId: string,
	createdAtIso: string,
	hash: string | null,
	inputFp: string | null,
): void {
	const debug = JSON.stringify({
		cachePath: "cold",
		stablePrefixHash: hash,
		stablePrefixInputFingerprint: inputFp,
	});
	db.prepare(
		`INSERT INTO turns (
			id, thread_id, model_id, tokens_in, tokens_out, created_at,
			modified_at, host_origin, deleted, context_debug
		) VALUES (?, ?, 'test-model', 0, 0, ?, ?, 'test', 0, ?)`,
	).run(turnId, threadId, createdAtIso, createdAtIso, debug);
}

describe("runStablePrefixDriftValidation (integration)", () => {
	let db: Database;
	const NOW = Date.now();

	beforeEach(() => {
		db = new Database(":memory:");
		applySchema(db);
		applyMetricsSchema(db);
	});

	it("returns zero drift on an empty corpus", () => {
		const report = runStablePrefixDriftValidation(db, SITE_ID, NOW);
		expect(report.pairsExamined).toBe(0);
		expect(report.composeDriftCount).toBe(0);
		expect(report.collectDriftCount).toBe(0);
	});

	it("ignores stable pairs (same hash, same fingerprint)", () => {
		const t0 = new Date(NOW - 30 * 60 * 1000).toISOString();
		const t1 = new Date(NOW - 25 * 60 * 1000).toISOString();
		insertColdTurn(db, "turn-1", "thread-A", t0, "abc123", "fp-A");
		insertColdTurn(db, "turn-2", "thread-A", t1, "abc123", "fp-A");

		const report = runStablePrefixDriftValidation(db, SITE_ID, NOW);
		expect(report.pairsExamined).toBe(1);
		expect(report.composeDriftCount).toBe(0);
		expect(report.collectDriftCount).toBe(0);
	});

	it("flags compose drift when output differs but input fingerprint matches", () => {
		const t0 = new Date(NOW - 30 * 60 * 1000).toISOString();
		const t1 = new Date(NOW - 25 * 60 * 1000).toISOString();
		insertColdTurn(db, "turn-1", "thread-A", t0, "hash-old", "fp-A");
		// Same fingerprint, different hash — by elimination, the renderer
		// is reading some signal not declared on `StableVolatileInputs`.
		insertColdTurn(db, "turn-2", "thread-A", t1, "hash-new", "fp-A");

		const report = runStablePrefixDriftValidation(db, SITE_ID, NOW);
		expect(report.pairsExamined).toBe(1);
		expect(report.composeDriftCount).toBe(1);
		expect(report.collectDriftCount).toBe(0);

		// The finding is returned in the report (the caller logs it) and
		// is NOT persisted to semantic_memory.
		expect(report.leaks).toHaveLength(1);
		expect(report.leaks[0]).toMatchObject({
			flavor: "compose",
			thread_id: "thread-A",
			prev_turn_id: "turn-1",
			curr_turn_id: "turn-2",
			prev_hash: "hash-old",
			curr_hash: "hash-new",
			prev_input_fp: "fp-A",
			curr_input_fp: "fp-A",
		});

		// No drift findings are written to semantic_memory anymore.
		const finding = db
			.prepare(
				"SELECT key FROM semantic_memory WHERE key LIKE '_validation:stable-prefix-drift:%' AND key != '_validation:stable-prefix-drift-last-run' AND deleted = 0",
			)
			.get() as { key: string } | null;
		expect(finding).toBeNull();
	});

	it("flags collect drift when input fingerprint differs without a covering change_log row", () => {
		const t0 = new Date(NOW - 30 * 60 * 1000).toISOString();
		const t1 = new Date(NOW - 25 * 60 * 1000).toISOString();
		insertColdTurn(db, "turn-1", "thread-A", t0, "hash-old", "fp-old");
		insertColdTurn(db, "turn-2", "thread-A", t1, "hash-new", "fp-new");
		// No change_log rows touching semantic_memory or skills between
		// t0 and t1, so the input fingerprint shifted with no declared
		// write covering it — collect leak.

		const report = runStablePrefixDriftValidation(db, SITE_ID, NOW);
		expect(report.pairsExamined).toBe(1);
		expect(report.composeDriftCount).toBe(0);
		expect(report.collectDriftCount).toBe(1);
	});

	it("does NOT flag collect drift when a covering change_log row exists", () => {
		const t0 = new Date(NOW - 30 * 60 * 1000).toISOString();
		const tMid = new Date(NOW - 27 * 60 * 1000).toISOString();
		const t1 = new Date(NOW - 25 * 60 * 1000).toISOString();
		insertColdTurn(db, "turn-1", "thread-A", t0, "hash-old", "fp-old");
		insertColdTurn(db, "turn-2", "thread-A", t1, "hash-new", "fp-new");
		// Insert a change_log row for semantic_memory between the two
		// cold rebuilds. The fingerprint shift is now explained.
		// change_log schema: (hlc, table_name, row_id, site_id, timestamp, row_data).
		db.prepare(
			`INSERT INTO change_log (hlc, table_name, row_id, site_id, timestamp, row_data)
			VALUES (?, ?, ?, ?, ?, ?)`,
		).run(`${tMid}-0-${SITE_ID}`, "semantic_memory", "row-A", SITE_ID, tMid, "{}");

		const report = runStablePrefixDriftValidation(db, SITE_ID, NOW);
		expect(report.pairsExamined).toBe(1);
		expect(report.composeDriftCount).toBe(0);
		expect(report.collectDriftCount).toBe(0);
	});

	it("does NOT pair turns across the cache TTL window", () => {
		// Two cold rebuilds 90 minutes apart — past the 60-minute pair
		// window. No pair, no drift, regardless of hash differences.
		const t0 = new Date(NOW - 120 * 60 * 1000).toISOString();
		const t1 = new Date(NOW - 30 * 60 * 1000).toISOString();
		insertColdTurn(db, "turn-1", "thread-A", t0, "hash-old", "fp-old");
		insertColdTurn(db, "turn-2", "thread-A", t1, "hash-new", "fp-new");

		const report = runStablePrefixDriftValidation(db, SITE_ID, NOW);
		expect(report.pairsExamined).toBe(0);
	});

	it("does NOT pair turns across different threads", () => {
		const t0 = new Date(NOW - 30 * 60 * 1000).toISOString();
		const t1 = new Date(NOW - 25 * 60 * 1000).toISOString();
		insertColdTurn(db, "turn-1", "thread-A", t0, "hash-old", "fp-A");
		insertColdTurn(db, "turn-2", "thread-B", t1, "hash-new", "fp-B");

		const report = runStablePrefixDriftValidation(db, SITE_ID, NOW);
		expect(report.pairsExamined).toBe(0);
	});

	it("cadence gate fires once per hour", () => {
		// First call should run (no last-run marker).
		expect(shouldRunStablePrefixDriftValidation(db, NOW)).toBe(true);

		runStablePrefixDriftValidation(db, SITE_ID, NOW);

		// Second call within the hour should NOT run.
		expect(shouldRunStablePrefixDriftValidation(db, NOW + 30 * 60 * 1000)).toBe(false);

		// 61 minutes later, the gate fires again.
		expect(shouldRunStablePrefixDriftValidation(db, NOW + 61 * 60 * 1000)).toBe(true);
	});
});
