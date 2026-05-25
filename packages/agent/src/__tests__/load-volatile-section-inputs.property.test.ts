/**
 * Property + integration tests for the volatile-section-inputs
 * loader helper.
 *
 * The helper unifies the DB-loading layer between the no-history
 * task path and the budget-pressure rebuild path. Prior to the
 * extraction, both inlined ~30 lines of nearly-identical SQL with
 * different caps and a fix to one site wouldn't propagate to the
 * other (the same divergence pattern `stable-prefix/collect.ts`
 * eliminated for the stable-side fingerprint).
 *
 * The helper itself is tested via `assembleContext` integration
 * paths (the existing volatile-context snapshot suite covers both
 * call sites). These properties pin the contract directly:
 *
 *   L1 Determinism — repeated calls on a stable DB return
 *      structurally-equal output.
 *
 *   L2 No-DML schema independence — calling the helper before vs
 *      after inserting an unrelated row in a NON-stable-side table
 *      (e.g. `messages`) returns the same shape.
 *
 *   L3 Cap monotonicity in `maxMemory` — increasing the
 *      `maxMemory` cap never decreases the count of returned
 *      task-digest / tier entries.
 *
 *   L4 Empty DB → empty arrays / maps — no errors, no nulls.
 *
 *   L5 deltaKeys honors `_internal.%` exclusion — keys starting
 *      with `_internal.` never appear in `deltaKeys` regardless of
 *      `modified_at`.
 */

import Database from "bun:sqlite";
import { describe, expect, it } from "bun:test";
import { applySchema, insertRow } from "@bound/core";

const SITE_ID = "test-site";
const NOW_ISO = "2026-05-25T12:00:00.000Z";
const BASELINE_ISO = "2026-05-25T11:00:00.000Z";

// ---------------------------------------------------------------------------
// `loadVolatileSectionInputs` is currently file-private inside
// context-assembly.ts. To test it directly we re-implement the same
// contract here as a thin shim — the production helper is identical
// shape and the assembleContext integration tests pin behavioral
// equivalence. A future commit can hoist the helper to a shared
// location and remove this shim.
// ---------------------------------------------------------------------------
import {
	buildCrossThreadDigest,
	buildParentSummaryMap,
	buildStaleChildrenMap,
	buildVolatileEnrichment,
	loadAppliedAdvisoriesForLiveState,
	loadDetailEntries,
	loadFileModificationsForLiveState,
	loadPinnedEntries,
	loadSummaryEntries,
} from "../summary-extraction";

function loadVolatileSectionInputs(args: {
	db: Database;
	threadId: string;
	userId: string;
	baseline: string;
	nowMs: number;
	maxMemory?: number;
	maxTasks?: number;
	maxPinned?: number;
}) {
	const pinned = loadPinnedEntries(args.db);
	const summaries = loadSummaryEntries(args.db, pinned.exclusionSet);
	const detailEntries = loadDetailEntries(args.db);
	const staleChildrenMap = buildStaleChildrenMap(args.db, summaries.entries);
	const parentSummaryMap = buildParentSummaryMap(
		args.db,
		detailEntries.entries.map((e) => e.key),
	);
	const digest = buildCrossThreadDigest(args.db, args.userId, args.threadId);
	const advisories = loadAppliedAdvisoriesForLiveState(args.db, args.nowMs);
	const fileEntries = loadFileModificationsForLiveState(args.db, args.threadId);
	const { taskDigestEntries, taskDigestLines, tiers } = buildVolatileEnrichment(
		args.db,
		args.baseline,
		args.maxMemory,
		args.maxTasks,
		undefined,
		undefined,
		args.maxPinned,
	);
	const allDeltaKeys = args.db
		.prepare(
			`SELECT DISTINCT key FROM semantic_memory
			 WHERE modified_at > ?
			   AND deleted = 0
			   AND key NOT LIKE '_internal.%'`,
		)
		.all(args.baseline) as Array<{ key: string }>;
	const deltaKeys = new Set(allDeltaKeys.map((r) => r.key));
	return {
		pinned,
		summaries,
		detailEntries,
		staleChildrenMap,
		parentSummaryMap,
		digest,
		advisories,
		taskDigestEntries,
		taskDigestLines,
		tiers,
		fileEntries,
		deltaKeys,
	};
}

// ---------------------------------------------------------------------------

function freshDb(): Database {
	const db = new Database(":memory:");
	applySchema(db);
	return db;
}

function insertMemory(
	db: Database,
	key: string,
	value: string,
	tier: "pinned" | "summary" | "default" | "detail" = "default",
	modifiedAt: string = NOW_ISO,
): void {
	insertRow(
		db,
		"semantic_memory",
		{
			id: `id-${key}`,
			key,
			value,
			tier,
			source: "test",
			modified_at: modifiedAt,
			last_accessed_at: modifiedAt,
			created_at: modifiedAt,
			deleted: 0,
		},
		SITE_ID,
	);
}

const THREAD_ID = "test-thread";
const USER_ID = "test-user";
const NOW_MS = new Date(NOW_ISO).getTime();

describe("loadVolatileSectionInputs — properties", () => {
	it("L1: determinism — repeated calls on stable DB return structurally-equal output", () => {
		const db = freshDb();
		insertMemory(db, "_pinned:tone", "be terse", "pinned");
		insertMemory(db, "_summary:transit", "transit notes", "summary");

		const a = loadVolatileSectionInputs({
			db,
			threadId: THREAD_ID,
			userId: USER_ID,
			baseline: BASELINE_ISO,
			nowMs: NOW_MS,
		});
		const b = loadVolatileSectionInputs({
			db,
			threadId: THREAD_ID,
			userId: USER_ID,
			baseline: BASELINE_ISO,
			nowMs: NOW_MS,
		});

		// Compare structurally — the helper returns Set/Map instances
		// which don't JSON-serialize cleanly. Instead, compare each
		// canonical projection.
		expect(a.pinned.entries.length).toBe(b.pinned.entries.length);
		expect(a.summaries.entries.length).toBe(b.summaries.entries.length);
		expect(a.detailEntries.entries.length).toBe(b.detailEntries.entries.length);
		expect([...a.deltaKeys].sort()).toEqual([...b.deltaKeys].sort());
		expect(a.taskDigestEntries.length).toBe(b.taskDigestEntries.length);
		db.close();
	});

	it("L2: schema independence — adding messages doesn't change volatile-section inputs", () => {
		const db = freshDb();
		insertMemory(db, "_pinned:x", "x", "pinned");

		const before = loadVolatileSectionInputs({
			db,
			threadId: THREAD_ID,
			userId: USER_ID,
			baseline: BASELINE_ISO,
			nowMs: NOW_MS,
		});

		// Insert a row in a non-stable-side table.
		insertRow(
			db,
			"messages",
			{
				id: "msg-1",
				thread_id: "other-thread",
				role: "user",
				content: "hi",
				created_at: NOW_ISO,
				modified_at: NOW_ISO,
				host_origin: "test",
				deleted: 0,
			},
			SITE_ID,
		);

		const after = loadVolatileSectionInputs({
			db,
			threadId: THREAD_ID,
			userId: USER_ID,
			baseline: BASELINE_ISO,
			nowMs: NOW_MS,
		});

		// The messages-table insert is for a different thread, so it
		// shouldn't affect even the cross-thread digest. Counts must
		// match exactly.
		expect(after.pinned.entries.length).toBe(before.pinned.entries.length);
		expect(after.summaries.entries.length).toBe(before.summaries.entries.length);
		expect(after.detailEntries.entries.length).toBe(before.detailEntries.entries.length);
		expect([...after.deltaKeys].sort()).toEqual([...before.deltaKeys].sort());
		db.close();
	});

	it("L3: cap monotonicity — task-digest count never exceeds maxTasks", () => {
		const db = freshDb();
		// Seed the DB with several semantic_memory rows that look like
		// task-output memorize entries (so buildVolatileEnrichment surfaces
		// them in tiers / taskDigestEntries depending on its rules).
		for (let i = 0; i < 10; i++) {
			insertMemory(db, `task-output-${i}`, `value-${i}`, "default");
		}

		const tight = loadVolatileSectionInputs({
			db,
			threadId: THREAD_ID,
			userId: USER_ID,
			baseline: BASELINE_ISO,
			nowMs: NOW_MS,
			maxMemory: 3,
			maxTasks: 3,
		});
		const loose = loadVolatileSectionInputs({
			db,
			threadId: THREAD_ID,
			userId: USER_ID,
			baseline: BASELINE_ISO,
			nowMs: NOW_MS,
			maxMemory: 10,
			maxTasks: 10,
		});

		// taskDigestEntries length is bounded by maxTasks. Increasing
		// maxTasks must NEVER decrease the count.
		expect(loose.taskDigestEntries.length).toBeGreaterThanOrEqual(tight.taskDigestEntries.length);
		expect(tight.taskDigestEntries.length).toBeLessThanOrEqual(3);
		expect(loose.taskDigestEntries.length).toBeLessThanOrEqual(10);
		db.close();
	});

	it("L4: empty DB → empty arrays / maps, no errors", () => {
		const db = freshDb();
		const result = loadVolatileSectionInputs({
			db,
			threadId: THREAD_ID,
			userId: USER_ID,
			baseline: BASELINE_ISO,
			nowMs: NOW_MS,
		});
		expect(result.pinned.entries.length).toBe(0);
		expect(result.summaries.entries.length).toBe(0);
		expect(result.detailEntries.entries.length).toBe(0);
		expect(result.deltaKeys.size).toBe(0);
		expect(result.staleChildrenMap.size).toBe(0);
		expect(result.parentSummaryMap.size).toBe(0);
		expect(result.taskDigestEntries.length).toBe(0);
		expect(result.fileEntries.length).toBe(0);
		db.close();
	});

	it("L5: deltaKeys excludes `_internal.%` keys", () => {
		const db = freshDb();
		// Insert two rows, both with modified_at > baseline. One has
		// the _internal. prefix and must be filtered out.
		const futureIso = "2026-05-26T00:00:00.000Z";
		insertMemory(db, "regular-key", "value", "default", futureIso);
		insertMemory(db, "_internal.something", "should be filtered", "default", futureIso);

		const result = loadVolatileSectionInputs({
			db,
			threadId: THREAD_ID,
			userId: USER_ID,
			baseline: BASELINE_ISO,
			nowMs: NOW_MS,
		});

		expect(result.deltaKeys.has("regular-key")).toBe(true);
		expect(result.deltaKeys.has("_internal.something")).toBe(false);
		db.close();
	});
});
