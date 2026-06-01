import Database from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { applyMetricsSchema, applySchema, insertRow, recordTurn } from "@bound/core";
import { CACHE_TTL_MS } from "../cache-prediction";
import { WARM_POKE_MARKER, selectWarmPokeTargets } from "../cache-warm-poke";

const TTL = CACHE_TTL_MS["1h"];
const SCAN_INTERVAL = 2 * 60_000; // 2m
const ACTIVE_WINDOW = 24 * 60 * 60_000; // 24h
const MAX_POKES = 3;

function baseOptions(overrides: Record<string, unknown> = {}) {
	return {
		resolvePokePolicy: () => ({ ttlMs: TTL, maxPokes: MAX_POKES }),
		scanIntervalMs: SCAN_INTERVAL,
		activeWindowMs: ACTIVE_WINDOW,
		...overrides,
	};
}

describe("selectWarmPokeTargets", () => {
	let db: Database.Database;

	beforeEach(() => {
		db = new Database(":memory:");
		applySchema(db);
		applyMetricsSchema(db);
	});

	afterEach(() => {
		db.close();
	});

	function insertThread(id: string, iface = "web", createdMsAgo = ACTIVE_WINDOW): void {
		const ts = new Date(Date.now() - createdMsAgo).toISOString();
		const now = new Date().toISOString();
		insertRow(
			db,
			"threads",
			{
				id,
				user_id: "user-1",
				interface: iface,
				host_origin: "localhost",
				color: 0,
				title: null,
				summary: null,
				summary_through: null,
				summary_model_id: null,
				extracted_through: null,
				created_at: ts,
				last_message_at: now,
				modified_at: now,
				deleted: 0,
			},
			"local-site",
		);
	}

	let msgCounter = 0;
	function insertUserMessage(threadId: string, msAgo: number): void {
		const ts = new Date(Date.now() - msAgo).toISOString();
		insertRow(
			db,
			"messages",
			{
				id: `umsg-${msgCounter++}`,
				thread_id: threadId,
				role: "user",
				content: "hello",
				model_id: null,
				tool_name: null,
				created_at: ts,
				modified_at: null,
				host_origin: "localhost",
				deleted: 0,
			},
			"local-site",
		);
	}

	function insertPokeMessage(threadId: string, msAgo: number): void {
		const ts = new Date(Date.now() - msAgo).toISOString();
		insertRow(
			db,
			"messages",
			{
				id: `poke-${msgCounter++}`,
				thread_id: threadId,
				role: "developer",
				content: `${WARM_POKE_MARKER} keep the prefix warm`,
				model_id: null,
				tool_name: null,
				created_at: ts,
				modified_at: null,
				host_origin: "localhost",
				deleted: 0,
			},
			"local-site",
		);
	}

	function insertWarmTurn(threadId: string, msAgo: number): void {
		recordTurn(db, {
			thread_id: threadId,
			model_id: "opus",
			tokens_in: 100,
			tokens_out: 50,
			tokens_cache_read: 200_000,
			tokens_cache_write: 500,
			created_at: new Date(Date.now() - msAgo).toISOString(),
		});
	}

	function insertColdTurn(threadId: string, msAgo: number): void {
		recordTurn(db, {
			thread_id: threadId,
			model_id: "opus",
			tokens_in: 100,
			tokens_out: 50,
			tokens_cache_read: 0,
			tokens_cache_write: 0,
			created_at: new Date(Date.now() - msAgo).toISOString(),
		});
	}

	function insertNoHistoryTask(threadId: string, lastRunMsAgo: number): void {
		const ts = new Date(Date.now() - lastRunMsAgo).toISOString();
		db.run(
			`INSERT INTO tasks (id, type, status, trigger_spec, created_at, modified_at, thread_id, no_history, last_run_at, deleted)
			 VALUES (?, 'cron', 'pending', '{}', ?, ?, ?, 1, ?, 0)`,
			[`task-${threadId}`, ts, ts, threadId, ts],
		);
	}

	function insertHost(siteId: string, agoMs: number): void {
		const ts = new Date(Date.now() - agoMs).toISOString();
		insertRow(
			db,
			"hosts",
			{
				site_id: siteId,
				host_name: siteId,
				sync_url: null,
				online_at: ts,
				modified_at: ts,
				deleted: 0,
			},
			"writer-site",
		);
	}

	function insertSession(threadId: string, siteId: string): void {
		const now = new Date().toISOString();
		insertRow(
			db,
			"client_sessions",
			{
				id: `conn::${threadId}`,
				connection_id: "conn",
				thread_id: threadId,
				site_id: siteId,
				created_at: now,
				deleted: 0,
				modified_at: now,
			},
			"writer-site",
		);
	}

	// near-expiry = msSinceTurn >= TTL - SCAN_INTERVAL = 60m - 2m = 58m. The poke
	// window is derived per-thread from the resolved TTL; with a 2m scan the
	// thread is only poked in the last 2m before its cache would lapse.
	const NEAR_EXPIRY = 59 * 60_000; // 59m ago: still warm (< 60m TTL) AND near expiry (>= 58m)
	const FRESH = 5 * 60_000; // 5m ago: warm but NOT near expiry

	it("selects a warm, near-expiry thread with a recent user message", () => {
		insertThread("t1");
		insertUserMessage("t1", 30 * 60_000);
		insertWarmTurn("t1", NEAR_EXPIRY);
		expect(selectWarmPokeTargets(db, baseOptions())).toEqual(["t1"]);
	});

	it("skips a warm thread that is not yet near expiry", () => {
		insertThread("t1");
		insertUserMessage("t1", 10 * 60_000);
		insertWarmTurn("t1", FRESH);
		expect(selectWarmPokeTargets(db, baseOptions())).toEqual([]);
	});

	it("skips a cold thread (never re-warm a cold cache)", () => {
		insertThread("t1");
		insertUserMessage("t1", 30 * 60_000);
		insertColdTurn("t1", NEAR_EXPIRY);
		expect(selectWarmPokeTargets(db, baseOptions())).toEqual([]);
	});

	it("skips a thread whose last turn is past the TTL (cold by expiry)", () => {
		insertThread("t1");
		insertUserMessage("t1", 90 * 60_000);
		insertWarmTurn("t1", 70 * 60_000); // > 60m TTL → predictCacheState cold
		expect(selectWarmPokeTargets(db, baseOptions())).toEqual([]);
	});

	it("skips a thread with no prior inference (nothing cached)", () => {
		insertThread("t1");
		insertUserMessage("t1", 30 * 60_000);
		// no turn
		expect(selectWarmPokeTargets(db, baseOptions())).toEqual([]);
	});

	it("skips a thread whose last user message is outside the active window", () => {
		insertThread("t1", "web", 30 * 60 * 60_000);
		insertUserMessage("t1", 26 * 60 * 60_000); // 26h ago, window is 24h
		insertWarmTurn("t1", NEAR_EXPIRY);
		expect(selectWarmPokeTargets(db, baseOptions())).toEqual([]);
	});

	it("enforces the per-active-period poke cap", () => {
		insertThread("t1");
		insertUserMessage("t1", 60 * 60_000); // anchor 60m ago
		insertWarmTurn("t1", NEAR_EXPIRY);
		// 3 pokes already since the anchor → at cap
		insertPokeMessage("t1", 50 * 60_000);
		insertPokeMessage("t1", 40 * 60_000);
		insertPokeMessage("t1", 30 * 60_000);
		expect(selectWarmPokeTargets(db, baseOptions())).toEqual([]);
	});

	it("counts only pokes since the latest user message (a new message resets the period)", () => {
		insertThread("t1");
		// old pokes before the most recent user message should not count
		insertPokeMessage("t1", 120 * 60_000);
		insertPokeMessage("t1", 110 * 60_000);
		insertPokeMessage("t1", 100 * 60_000);
		insertUserMessage("t1", 30 * 60_000); // fresh activity resets the period
		insertWarmTurn("t1", NEAR_EXPIRY);
		expect(selectWarmPokeTargets(db, baseOptions())).toEqual(["t1"]);
	});

	it("includes a noHistory cron thread that ran within the window", () => {
		insertThread("cron1", "scheduler");
		insertNoHistoryTask("cron1", 30 * 60_000);
		insertWarmTurn("cron1", NEAR_EXPIRY);
		expect(selectWarmPokeTargets(db, baseOptions())).toEqual(["cron1"]);
	});

	it("excludes a boundless thread with no live client session", () => {
		insertThread("b1", "boundless");
		insertUserMessage("b1", 30 * 60_000);
		insertWarmTurn("b1", NEAR_EXPIRY);
		// no client_sessions row → not live
		expect(selectWarmPokeTargets(db, baseOptions())).toEqual([]);
	});

	it("includes a boundless thread with a live client session", () => {
		insertThread("b1", "boundless");
		insertUserMessage("b1", 30 * 60_000);
		insertWarmTurn("b1", NEAR_EXPIRY);
		insertHost("site-a", 0);
		insertSession("b1", "site-a");
		expect(selectWarmPokeTargets(db, baseOptions())).toEqual(["b1"]);
	});

	it("excludes a boundless thread whose session host is stale", () => {
		insertThread("b1", "boundless");
		insertUserMessage("b1", 30 * 60_000);
		insertWarmTurn("b1", NEAR_EXPIRY);
		insertHost("site-a", 10 * 60_000); // 10m old, past 5m staleness
		insertSession("b1", "site-a");
		expect(selectWarmPokeTargets(db, baseOptions())).toEqual([]);
	});

	it("returns multiple eligible threads", () => {
		insertThread("t1");
		insertUserMessage("t1", 30 * 60_000);
		insertWarmTurn("t1", NEAR_EXPIRY);
		insertThread("t2");
		insertUserMessage("t2", 30 * 60_000);
		insertWarmTurn("t2", NEAR_EXPIRY);
		expect(selectWarmPokeTargets(db, baseOptions()).sort()).toEqual(["t1", "t2"]);
	});
});
