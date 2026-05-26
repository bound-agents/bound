import Database from "bun:sqlite";
import { beforeEach, describe, expect, it } from "bun:test";
import { applySchema, insertRow } from "@bound/core";
import {
	runOutboxAuditValidation,
	shouldRunOutboxAuditValidation,
} from "../run-outbox-audit-validation";

const SITE_ID = "test-site";

// `change_log.timestamp` is stamped with real `Date.now()` inside
// `createChangeLogEntry` (HLC source), independent of the validator's
// `nowMs` parameter. Anchor test fixture timestamps to real time so
// the evidence horizon (= MIN(change_log.timestamp)) correctly
// orders against the test rows' `modified_at` values.
//
// FIXED_NOW is pinned 2 hours in the future so the validator's
// 30-min stability cutoff (FIXED_NOW - 30min) lands AFTER the
// change_log entries written during the test (at real now), which
// keeps freshly-seeded outbox rows out of the audit window only
// when they're explicitly stamped with a "recent" modified_at.
const FIXED_NOW = Date.now() + 2 * 60 * 60 * 1000;

// Pick a row created/modified far enough in the past that the audit's
// 30-min stability threshold lets it through, but recent enough
// (relative to real wall-clock now) that the evidence horizon does
// NOT exclude it.
const STABLE_PAST = new Date(FIXED_NOW - 60 * 60 * 1000).toISOString();

// Even older relative to FIXED_NOW, but still after real wall-clock
// now — used to seed a baseline outbox row whose change_log
// timestamp anchors the audit's evidence horizon at or before
// STABLE_PAST so subsequent test rows fall inside the audit window.
const HORIZON_ANCHOR_PAST = new Date(FIXED_NOW - 90 * 60 * 1000).toISOString();

/**
 * Seed one outbox-routed row so `change_log` is non-empty and the
 * audit has a horizon old enough to include rows at STABLE_PAST.
 * Without this anchor, the audit short-circuits with no claim space
 * and reports zero violations regardless of bypassed rows.
 */
function seedHorizonAnchor(db: Database): void {
	insertRow(
		db,
		"semantic_memory",
		{
			id: "horizon-anchor-id",
			key: "horizon-anchor-key",
			value: "v",
			tier: "default",
			source: "test",
			modified_at: HORIZON_ANCHOR_PAST,
			last_accessed_at: HORIZON_ANCHOR_PAST,
			created_at: HORIZON_ANCHOR_PAST,
			deleted: 0,
		},
		SITE_ID,
	);
}

describe("runOutboxAuditValidation (integration)", () => {
	let db: Database;

	beforeEach(() => {
		db = new Database(":memory:");
		applySchema(db);
	});

	it("returns zero violations on empty corpus", () => {
		// Empty change_log → no evidence horizon → audit cleanly skips.
		const report = runOutboxAuditValidation(db, SITE_ID, FIXED_NOW);
		expect(report.violationsFound).toBe(0);
		expect(report.evidenceHorizon).toBeNull();
		expect(report.tablesScanned).toBe(0);
	});

	it("finds no violations for rows inserted via the outbox helpers", () => {
		// Use the real outbox helper — produces a change_log entry.
		insertRow(
			db,
			"semantic_memory",
			{
				id: "good-row-id",
				key: "good-key",
				value: "v",
				tier: "default",
				source: "test",
				modified_at: STABLE_PAST,
				last_accessed_at: STABLE_PAST,
				created_at: STABLE_PAST,
				deleted: 0,
			},
			SITE_ID,
		);

		const report = runOutboxAuditValidation(db, SITE_ID, FIXED_NOW);
		expect(report.violationsFound).toBe(0);
		expect(report.rowsExamined).toBeGreaterThan(0);
	});

	it("flags a row inserted via raw SQL (bypassing the outbox)", () => {
		// Anchor the evidence horizon BEFORE the bypass row's
		// modified_at so the audit will examine it.
		seedHorizonAnchor(db);

		// Direct INSERT with no corresponding change_log entry —
		// the exact bug class the audit exists to detect.
		db.prepare(
			`INSERT INTO semantic_memory (id, key, value, tier, source, modified_at, last_accessed_at, created_at, deleted)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		).run(
			"bypass-row-id",
			"bypass-key",
			"v",
			"default",
			"test",
			STABLE_PAST,
			STABLE_PAST,
			STABLE_PAST,
			0,
		);

		const report = runOutboxAuditValidation(db, SITE_ID, FIXED_NOW);
		expect(report.violationsFound).toBeGreaterThan(0);
		expect(report.evidenceHorizon).not.toBeNull();

		// Verify the violation key was persisted.
		const finding = db
			.prepare(
				"SELECT key FROM semantic_memory WHERE key LIKE '_validation:outbox-audit:semantic_memory:%' AND deleted = 0",
			)
			.get() as { key: string } | null;
		expect(finding).not.toBeNull();
		expect(finding?.key).toContain("bypass-row-id");
	});

	it("does NOT flag rows within the 30-minute stability window", () => {
		seedHorizonAnchor(db);

		// Recently-inserted row with no change_log entry. In a real
		// snapshot-seeding scenario, the change_log replay would arrive
		// shortly after; the stability gate prevents false positives
		// during that window.
		const recent = new Date(FIXED_NOW - 5 * 60 * 1000).toISOString();
		db.prepare(
			`INSERT INTO semantic_memory (id, key, value, tier, source, modified_at, last_accessed_at, created_at, deleted)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		).run("recent-row", "k", "v", "default", "test", recent, recent, recent, 0);

		const report = runOutboxAuditValidation(db, SITE_ID, FIXED_NOW);
		expect(report.violationsFound).toBe(0);
	});

	it("does NOT flag rows older than the evidence horizon (pruned change_log)", () => {
		// Simulates a node with active changelog pruning: a row was
		// originally written via the outbox, but its change_log entry
		// has since been deleted. The row's modified_at is older than
		// every surviving change_log.timestamp. The audit must NOT
		// claim this is a bypass — provenance is ambiguous (legitimate
		// outbox write with pruned entry vs. true bypass), so the row
		// falls outside the audit's claim space.
		const ANCIENT = new Date(FIXED_NOW - 24 * 60 * 60 * 1000).toISOString();
		db.prepare(
			`INSERT INTO semantic_memory (id, key, value, tier, source, modified_at, last_accessed_at, created_at, deleted)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		).run("ancient-row", "k", "v", "default", "test", ANCIENT, ANCIENT, ANCIENT, 0);

		// Anchor the horizon AFTER the ancient row — the only
		// surviving change_log entry is from a much later write.
		seedHorizonAnchor(db);

		const report = runOutboxAuditValidation(db, SITE_ID, FIXED_NOW);
		expect(report.violationsFound).toBe(0);
		// Sanity: horizon exists and is after the ancient row's modified_at.
		const horizon = report.evidenceHorizon;
		expect(horizon).not.toBeNull();
		expect(horizon !== null && horizon > ANCIENT).toBe(true);
	});

	it("cadence gate fires once per hour", () => {
		expect(shouldRunOutboxAuditValidation(db, FIXED_NOW)).toBe(true);
		runOutboxAuditValidation(db, SITE_ID, FIXED_NOW);
		expect(shouldRunOutboxAuditValidation(db, FIXED_NOW + 30 * 60 * 1000)).toBe(false);
		expect(shouldRunOutboxAuditValidation(db, FIXED_NOW + 61 * 60 * 1000)).toBe(true);
	});

	it("scans every synced table that exists in the schema", () => {
		seedHorizonAnchor(db);

		const report = runOutboxAuditValidation(db, SITE_ID, FIXED_NOW);
		// applySchema creates the bulk of the synced tables; expect
		// most of them to appear in the scan count.
		expect(report.tablesScanned).toBeGreaterThanOrEqual(10);
	});
});
