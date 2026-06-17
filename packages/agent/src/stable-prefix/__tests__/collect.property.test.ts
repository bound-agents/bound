/**
 * Property + integration tests for the stable-prefix `collect`
 * layer.
 *
 * `collect.ts` is the single DB-reading layer of the stable-prefix
 * subsystem. The pure projector (`projectStableVolatileInputs`) is
 * property-testable directly; the DB wrapper
 * (`collectStableVolatileInputs`) gets integration tests against
 * a real in-memory schema.
 *
 * Properties:
 *
 *   K1 Projector determinism — same `LoadedStableInputs`, same
 *      `StableVolatileInputs`. Pure function contract.
 *
 *   K2 Projector locality — fields outside the wider input shape
 *      that are NOT named in the projection don't influence the
 *      output. Asserted by passing extra StageEntry fields and
 *      verifying the output is unchanged from the same input
 *      without those extras.
 *
 *   K3 End-to-end fingerprint stability — for a stable DB,
 *      `hashStableVolatileInputs(collectStableVolatileInputs(db))`
 *      returns the same value across calls. This is the property
 *      the drift detector ultimately depends on.
 *
 *   K4 Integration — `collectStableVolatileInputs` produces a
 *      well-formed `StableVolatileInputs` from a fresh DB.
 *
 *   K5 Integration — adding a pinned memory entry changes the
 *      collected fingerprint.
 *
 *   K6 Integration — adding an unrelated row to a non-stable
 *      table (e.g. messages) does NOT change the fingerprint.
 */

import Database from "bun:sqlite";
import { describe, expect, it } from "bun:test";
import { applySchema, insertRow } from "@bound/core";
import fc from "fast-check";
import type { StageEntry, Vc15Tunables } from "../../summary-extraction";
import {
	type LoadedStableInputs,
	collectStableVolatileInputs,
	projectStableVolatileInputs,
} from "../collect";
import { hashStableVolatileInputs } from "../hash";

const SITE_ID = "test-site";

function freshDb(): Database {
	const db = new Database(":memory:");
	applySchema(db);
	return db;
}

function makeStageEntry(
	overrides: Partial<StageEntry> & { key: string; value: string },
): StageEntry {
	return {
		key: overrides.key,
		value: overrides.value,
		source: overrides.source ?? null,
		modifiedAt: overrides.modifiedAt ?? "2026-05-25T11:00:00Z",
		tier: overrides.tier ?? "default",
		tag: overrides.tag ?? "[summary]",
		taskName: overrides.taskName ?? null,
		threadId: overrides.threadId ?? null,
		threadTitle: overrides.threadTitle ?? null,
	};
}

const safeKey = fc.string({ minLength: 1, maxLength: 30 }).filter((s) => !/[\n\r]/.test(s));
const safeValue = fc.string({ minLength: 0, maxLength: 60 }).filter((s) => !/[\n\r]/.test(s));

const tunables: Vc15Tunables = { n: 1000, m: 20 };

const loadedArb: fc.Arbitrary<LoadedStableInputs> = fc.record({
	pinned: fc
		.uniqueArray(fc.record({ key: safeKey, value: safeValue }), {
			maxLength: 4,
			selector: (e) => e.key,
		})
		.map((arr) => arr.map(makeStageEntry)),
	summaries: fc
		.uniqueArray(fc.record({ key: safeKey, value: safeValue }), {
			maxLength: 4,
			selector: (e) => e.key,
		})
		.map((arr) => arr.map(makeStageEntry)),
	detailEntries: fc.uniqueArray(
		fc.record({
			key: safeKey,
			last_accessed_at: fc.constant("2026-05-25T11:00:00Z"),
		}),
		{ maxLength: 6, selector: (e) => e.key },
	),
	parentSummaryMap: fc
		.uniqueArray(fc.tuple(safeKey, safeKey), { maxLength: 4, selector: ([k]) => k })
		.map((pairs) => new Map(pairs)),
	staleChildrenMap: fc
		.uniqueArray(fc.tuple(safeKey, fc.array(fc.record({ key: safeKey }), { maxLength: 2 })), {
			maxLength: 3,
			selector: ([k]) => k,
		})
		.map((entries) => new Map(entries)),
	budgetPressure: fc.boolean(),
	activeSkills: fc.uniqueArray(fc.record({ name: safeKey, description: safeValue }), {
		maxLength: 3,
		selector: (s) => s.name,
	}),
	tunables: fc.constant(tunables),
	clusterModels: fc.array(
		fc.record({
			name: safeKey,
			hosts: fc.array(safeKey, { maxLength: 3 }),
			local: fc.boolean(),
		}),
		{ maxLength: 5 },
	),
});

describe("projectStableVolatileInputs — property tests", () => {
	it("K1: determinism — same loaded input, same projection", () => {
		fc.assert(
			fc.property(loadedArb, (loaded) => {
				const a = JSON.stringify(serialize(projectStableVolatileInputs(loaded)));
				const b = JSON.stringify(serialize(projectStableVolatileInputs(loaded)));
				return a === b;
			}),
			{ numRuns: 100 },
		);
	});

	it("K2: locality — non-projected fields on StageEntry don't influence output", () => {
		fc.assert(
			fc.property(loadedArb, (loaded) => {
				// The projection keeps key, value, and modifiedAt (the last drives
				// the `(modified YYYY-MM-DD)` capture-time prefix, #71). Every OTHER
				// field on the wider StageEntry shape (source, tier, tag, taskName,
				// threadId, threadTitle) MUST NOT affect the projection. modifiedAt
				// is held constant here so the pollution only exercises the
				// dropped fields.
				const polluted: LoadedStableInputs = {
					...loaded,
					pinned: loaded.pinned.map((e) =>
						makeStageEntry({
							key: e.key,
							value: e.value,
							modifiedAt: e.modifiedAt,
							source: "MUTATED",
							tier: "default",
							tag: "[MUTATED]",
							taskName: "MUTATED",
							threadId: "MUTATED",
							threadTitle: "MUTATED",
						}),
					),
				};
				const baseline = JSON.stringify(serialize(projectStableVolatileInputs(loaded)));
				const polluted2 = JSON.stringify(serialize(projectStableVolatileInputs(polluted)));
				return baseline === polluted2;
			}),
			{ numRuns: 50 },
		);
	});
});

describe("collectStableVolatileInputs — integration tests", () => {
	it("K3: end-to-end fingerprint stability across repeated calls on a stable DB", () => {
		const db = freshDb();
		insertSamplePinned(db, "_pinned:tone", "be terse");
		insertSampleSummary(db, "_summary:transit", "transit notes");

		const a = hashStableVolatileInputs(collectStableVolatileInputs(db, false));
		const b = hashStableVolatileInputs(collectStableVolatileInputs(db, false));
		const c = hashStableVolatileInputs(collectStableVolatileInputs(db, false));
		expect(a).toBe(b);
		expect(b).toBe(c);
		db.close();
	});

	it("K4: produces well-formed StableVolatileInputs on empty DB", () => {
		const db = freshDb();
		const inputs = collectStableVolatileInputs(db, false);
		expect(Array.isArray(inputs.pinned)).toBe(true);
		expect(Array.isArray(inputs.summaries)).toBe(true);
		expect(Array.isArray(inputs.detailEntries)).toBe(true);
		expect(inputs.parentSummaryByKey instanceof Map).toBe(true);
		expect(inputs.staleChildKeysInWorkingKnowledge instanceof Set).toBe(true);
		expect(typeof inputs.tunables.n).toBe("number");
		expect(typeof inputs.tunables.m).toBe("number");
		expect(Array.isArray(inputs.skillIndex)).toBe(true);
		db.close();
	});

	it("K5: adding a pinned entry changes the fingerprint", () => {
		const db = freshDb();
		const before = hashStableVolatileInputs(collectStableVolatileInputs(db, false));
		insertSamplePinned(db, "_pinned:new-key", "new value");
		const after = hashStableVolatileInputs(collectStableVolatileInputs(db, false));
		expect(before).not.toBe(after);
		db.close();
	});

	it("K6: adding a row to a non-stable table does NOT change the fingerprint", () => {
		const db = freshDb();
		insertSamplePinned(db, "_pinned:x", "x");
		const before = hashStableVolatileInputs(collectStableVolatileInputs(db, false));

		// `messages` rows are not part of the stable-prefix input set —
		// they belong to history, which sits OUTSIDE the cacheable
		// prefix per R-VC24.
		const ts = "2026-05-25T11:00:00Z";
		insertRow(
			db,
			"messages",
			{
				id: "msg-1",
				thread_id: "thread-1",
				role: "user",
				content: "hello",
				created_at: ts,
				modified_at: ts,
				host_origin: "test",
				deleted: 0,
			},
			SITE_ID,
		);
		const after = hashStableVolatileInputs(collectStableVolatileInputs(db, false));
		expect(before).toBe(after);
		db.close();
	});

	it("K7: budgetPressure flag flows through to the projected output", () => {
		const db = freshDb();
		insertSamplePinned(db, "_pinned:x", "x");
		const calm = hashStableVolatileInputs(collectStableVolatileInputs(db, false));
		const pressured = hashStableVolatileInputs(collectStableVolatileInputs(db, true));
		expect(calm).not.toBe(pressured);
		db.close();
	});
});

// --- Helpers ---

function insertSamplePinned(db: Database, key: string, value: string): void {
	const ts = "2026-05-25T11:00:00Z";
	insertRow(
		db,
		"semantic_memory",
		{
			id: `id-${key}`,
			key,
			value,
			tier: "pinned",
			source: "test",
			modified_at: ts,
			last_accessed_at: ts,
			created_at: ts,
			deleted: 0,
		},
		SITE_ID,
	);
}

function insertSampleSummary(db: Database, key: string, value: string): void {
	const ts = "2026-05-25T11:00:00Z";
	insertRow(
		db,
		"semantic_memory",
		{
			id: `id-${key}`,
			key,
			value,
			tier: "summary",
			source: "test",
			modified_at: ts,
			last_accessed_at: ts,
			created_at: ts,
			deleted: 0,
		},
		SITE_ID,
	);
}

interface SerializedInputs {
	pinned: ReadonlyArray<{ key: string; value: string }>;
	summaries: ReadonlyArray<{ key: string; value: string }>;
	detailEntries: ReadonlyArray<{ key: string; last_accessed_at: string | null }>;
	parentSummaryByKey: ReadonlyArray<[string, string]>;
	staleChildKeysInWorkingKnowledge: ReadonlyArray<string>;
	budgetPressure: boolean;
	tunables: Vc15Tunables;
	skillIndex: ReadonlyArray<{ name: string; description: string }>;
}

function serialize(i: ReturnType<typeof projectStableVolatileInputs>): SerializedInputs {
	return {
		...i,
		parentSummaryByKey: [...i.parentSummaryByKey.entries()].sort((a, b) =>
			a[0].localeCompare(b[0]),
		),
		staleChildKeysInWorkingKnowledge: [...i.staleChildKeysInWorkingKnowledge].sort(),
	};
}
