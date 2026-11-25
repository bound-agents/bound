import Database from "bun:sqlite";
import { beforeEach, describe, expect, it } from "bun:test";
import { applyMetricsSchema, applySchema } from "@bound/core";
import { STABLE_PREFIX_DRIFT_VERSION } from "../../stable-prefix/hash";
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
	opts: { version?: number | null; wholePromptHash?: string; host?: string } = {},
): void {
	const version = opts.version === undefined ? STABLE_PREFIX_DRIFT_VERSION : opts.version;
	const debug = JSON.stringify({
		cachePath: "cold",
		stablePrefixHash: opts.wholePromptHash ?? `whole-${hash}`,
		stableSubsectionHash: hash,
		stablePrefixInputFingerprint: inputFp,
		...(version !== null ? { stablePrefixDriftVersion: version } : {}),
	});
	db.prepare(
		`INSERT INTO turns (
			id, thread_id, model_id, tokens_in, tokens_out, created_at,
			modified_at, host_origin, deleted, context_debug
		) VALUES (?, ?, 'test-model', 0, 0, ?, ?, ?, 0, ?)`,
	).run(turnId, threadId, createdAtIso, createdAtIso, opts.host ?? "test", debug);
}

function insertChangeLog(
	db: Database,
	table: string,
	atIso: string,
	rowId = "row-A",
	rowData: Record<string, unknown> = {},
): void {
	db.prepare(
		`INSERT INTO change_log (hlc, table_name, row_id, site_id, timestamp, row_data)
		VALUES (?, ?, ?, ?, ?, ?)`,
	).run(
		`${atIso}-${table}-${rowId}-${SITE_ID}`,
		table,
		rowId,
		SITE_ID,
		atIso,
		JSON.stringify(rowData),
	);
}

/** Retained change_log history reaching back before `beforeIso` (coverage proof). */
function seedRetainedHistory(db: Database, beforeIso: string): void {
	insertChangeLog(db, "messages", new Date(Date.parse(beforeIso) - 60_000).toISOString(), "older");
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
		// Retained history reaches back before t0, so the window is fully
		// covered, yet no stable-side row lands between t0 and t1: the
		// fingerprint shifted with no declared write — collect leak.
		seedRetainedHistory(db, t0);

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

	it("#303: a static system-prompt change outside the subsection is not a compose leak", () => {
		// Persona / command registry / suffix edits change the whole-prompt hash but
		// not the stable volatile subsection, which is all the fingerprint covers.
		const t0 = new Date(NOW - 30 * 60 * 1000).toISOString();
		const t1 = new Date(NOW - 25 * 60 * 1000).toISOString();
		insertColdTurn(db, "turn-1", "thread-A", t0, "sub-A", "fp-A", { wholePromptHash: "persona-1" });
		insertColdTurn(db, "turn-2", "thread-A", t1, "sub-A", "fp-A", { wholePromptHash: "persona-2" });

		const report = runStablePrefixDriftValidation(db, SITE_ID, NOW);
		expect(report.pairsExamined).toBe(1);
		expect(report.composeDriftCount).toBe(0);
		expect(report.collectDriftCount).toBe(0);
	});

	it("#303: old-generation records without a drift version are never compared", () => {
		const t0 = new Date(NOW - 30 * 60 * 1000).toISOString();
		const t1 = new Date(NOW - 25 * 60 * 1000).toISOString();
		insertColdTurn(db, "turn-1", "thread-A", t0, "hash-old", "fp-A", { version: null });
		insertColdTurn(db, "turn-2", "thread-A", t1, "hash-new", "fp-A", { version: null });

		const report = runStablePrefixDriftValidation(db, SITE_ID, NOW);
		expect(report.pairsExamined).toBe(0);
		expect(report.composeDriftCount).toBe(0);
	});

	it("#303: a pair straddling a drift-version change is not compared", () => {
		const t0 = new Date(NOW - 30 * 60 * 1000).toISOString();
		const t1 = new Date(NOW - 25 * 60 * 1000).toISOString();
		insertColdTurn(db, "turn-1", "thread-A", t0, "hash-old", "fp-A", { version: null });
		insertColdTurn(db, "turn-2", "thread-A", t1, "hash-new", "fp-A");

		const report = runStablePrefixDriftValidation(db, SITE_ID, NOW);
		expect(report.pairsExamined).toBe(0);
		expect(report.composeDriftCount).toBe(0);
	});

	it("#304: missing change_log history is unknown, not a collect leak", () => {
		// Pruning removed everything at or before the window: absence of a
		// covering row proves nothing.
		const t0 = new Date(NOW - 30 * 60 * 1000).toISOString();
		const t1 = new Date(NOW - 25 * 60 * 1000).toISOString();
		insertColdTurn(db, "turn-1", "thread-A", t0, "hash-old", "fp-old");
		insertColdTurn(db, "turn-2", "thread-A", t1, "hash-new", "fp-new");

		const report = runStablePrefixDriftValidation(db, SITE_ID, NOW);
		expect(report.pairsExamined).toBe(1);
		expect(report.collectDriftCount).toBe(0);
		expect(report.leaks).toHaveLength(0);
		expect(report.unknownCount).toBe(1);
		expect(report.unknown[0]).toMatchObject({
			reason: "incomplete-history",
			curr_turn_id: "turn-2",
		});
	});

	it("#304: history pruned to a point inside the window is still unknown", () => {
		const t0 = new Date(NOW - 30 * 60 * 1000).toISOString();
		const tMid = new Date(NOW - 27 * 60 * 1000).toISOString();
		const t1 = new Date(NOW - 25 * 60 * 1000).toISOString();
		insertColdTurn(db, "turn-1", "thread-A", t0, "hash-old", "fp-old");
		insertColdTurn(db, "turn-2", "thread-A", t1, "hash-new", "fp-new");
		// Oldest retained row is after t0: rows in (t0, tMid) may be gone.
		insertChangeLog(db, "messages", tMid);

		const report = runStablePrefixDriftValidation(db, SITE_ID, NOW);
		expect(report.collectDriftCount).toBe(0);
		expect(report.unknownCount).toBe(1);
	});

	it("#304: a threads change_log row covers a cross-thread summary shift", () => {
		const t0 = new Date(NOW - 30 * 60 * 1000).toISOString();
		const tMid = new Date(NOW - 27 * 60 * 1000).toISOString();
		const t1 = new Date(NOW - 25 * 60 * 1000).toISOString();
		insertColdTurn(db, "turn-1", "thread-A", t0, "hash-old", "fp-old");
		insertColdTurn(db, "turn-2", "thread-A", t1, "hash-new", "fp-new");
		seedRetainedHistory(db, t0);
		const tBefore = new Date(NOW - 40 * 60 * 1000).toISOString();
		insertChangeLog(db, "threads", tBefore, "sibling-thread", { summary: "old summary" });
		insertChangeLog(db, "threads", tMid, "sibling-thread", { summary: "new summary" });

		const report = runStablePrefixDriftValidation(db, SITE_ID, NOW);
		expect(report.pairsExamined).toBe(1);
		expect(report.collectDriftCount).toBe(0);
		expect(report.unknownCount).toBe(0);
	});

	it("#304: threads writes that leave sibling summaries unchanged do not mask a collect leak", () => {
		const t0 = new Date(NOW - 30 * 60 * 1000).toISOString();
		const tBefore = new Date(NOW - 40 * 60 * 1000).toISOString();
		const tMid1 = new Date(NOW - 28 * 60 * 1000).toISOString();
		const tMid2 = new Date(NOW - 27 * 60 * 1000).toISOString();
		const t1 = new Date(NOW - 25 * 60 * 1000).toISOString();
		insertColdTurn(db, "turn-1", "thread-A", t0, "hash-old", "fp-old");
		insertColdTurn(db, "turn-2", "thread-A", t1, "hash-new", "fp-new");
		seedRetainedHistory(db, t0);
		// Every loop turn bumps its own thread's last_message_at, summary included.
		insertChangeLog(db, "threads", tMid1, "thread-A", {
			summary: "own summary changed",
			last_message_at: tMid1,
		});
		// An active sibling bumps last_message_at without touching its summary.
		insertChangeLog(db, "threads", tBefore, "sibling-thread", {
			summary: "same summary",
			last_message_at: tBefore,
		});
		insertChangeLog(db, "threads", tMid2, "sibling-thread", {
			summary: "same summary",
			last_message_at: tMid2,
		});

		const report = runStablePrefixDriftValidation(db, SITE_ID, NOW);
		expect(report.pairsExamined).toBe(1);
		expect(report.collectDriftCount).toBe(1);
		expect(report.unknownCount).toBe(0);
		expect(report.leaks[0]?.flavor).toBe("collect");
	});

	it("#304: a sibling threads row with no earlier logged row is unknown, not coverage", () => {
		// Pruning dropped the sibling's earlier row, so its in-window
		// last_message_at bump cannot prove a summary change.
		const t0 = new Date(NOW - 30 * 60 * 1000).toISOString();
		const tMid = new Date(NOW - 27 * 60 * 1000).toISOString();
		const t1 = new Date(NOW - 25 * 60 * 1000).toISOString();
		insertColdTurn(db, "turn-1", "thread-A", t0, "hash-old", "fp-old");
		insertColdTurn(db, "turn-2", "thread-A", t1, "hash-new", "fp-new");
		seedRetainedHistory(db, t0);
		insertChangeLog(db, "threads", tMid, "sibling-thread", {
			summary: "same summary",
			last_message_at: tMid,
		});

		const report = runStablePrefixDriftValidation(db, SITE_ID, NOW);
		expect(report.pairsExamined).toBe(1);
		expect(report.collectDriftCount).toBe(0);
		expect(report.leaks).toHaveLength(0);
		expect(report.unknownCount).toBe(1);
		expect(report.unknown[0]).toMatchObject({
			reason: "incomplete-history",
			curr_turn_id: "turn-2",
		});
	});

	it("#304: a proven sibling summary change still covers alongside an unprovable sibling", () => {
		const t0 = new Date(NOW - 30 * 60 * 1000).toISOString();
		const tBefore = new Date(NOW - 40 * 60 * 1000).toISOString();
		const tMid1 = new Date(NOW - 28 * 60 * 1000).toISOString();
		const tMid2 = new Date(NOW - 27 * 60 * 1000).toISOString();
		const t1 = new Date(NOW - 25 * 60 * 1000).toISOString();
		insertColdTurn(db, "turn-1", "thread-A", t0, "hash-old", "fp-old");
		insertColdTurn(db, "turn-2", "thread-A", t1, "hash-new", "fp-new");
		seedRetainedHistory(db, t0);
		insertChangeLog(db, "threads", tMid1, "orphan-sibling", { summary: "x" });
		insertChangeLog(db, "threads", tBefore, "sibling-thread", { summary: "old summary" });
		insertChangeLog(db, "threads", tMid2, "sibling-thread", { summary: "new summary" });

		const report = runStablePrefixDriftValidation(db, SITE_ID, NOW);
		expect(report.collectDriftCount).toBe(0);
		expect(report.unknownCount).toBe(0);
	});

	it("#304: turns produced by different hosts are unknown, not leaks", () => {
		const t0 = new Date(NOW - 30 * 60 * 1000).toISOString();
		const t1 = new Date(NOW - 25 * 60 * 1000).toISOString();
		const t2 = new Date(NOW - 20 * 60 * 1000).toISOString();
		seedRetainedHistory(db, t0);
		insertColdTurn(db, "turn-1", "thread-A", t0, "hash-a", "fp-a", { host: "host-a" });
		// Different producer: `local` flags and host-local state differ.
		insertColdTurn(db, "turn-2", "thread-A", t1, "hash-b", "fp-b", { host: "host-b" });
		// Same fingerprint across hosts with different output is also unknown.
		insertColdTurn(db, "turn-3", "thread-A", t2, "hash-c", "fp-b", { host: "host-a" });

		const report = runStablePrefixDriftValidation(db, SITE_ID, NOW);
		expect(report.composeDriftCount).toBe(0);
		expect(report.collectDriftCount).toBe(0);
		expect(report.leaks).toHaveLength(0);
		expect(report.unknownCount).toBe(2);
		expect(report.unknown.map((u) => u.reason)).toEqual(["cross-host", "cross-host"]);
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
