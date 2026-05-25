import Database from "bun:sqlite";
import { beforeEach, describe, expect, it } from "bun:test";
import { applySchema, insertRow } from "@bound/core";
import {
	runOutboxAuditValidation,
	shouldRunOutboxAuditValidation,
} from "../run-outbox-audit-validation";

const SITE_ID = "test-site";
const FIXED_NOW = new Date("2026-05-25T12:00:00Z").getTime();

// Pick a row created/modified far enough in the past that the audit's
// 30-min stability threshold lets it through.
const STABLE_PAST = new Date(FIXED_NOW - 60 * 60 * 1000).toISOString();

describe("runOutboxAuditValidation (integration)", () => {
	let db: Database;

	beforeEach(() => {
		db = new Database(":memory:");
		applySchema(db);
	});

	it("returns zero violations on empty corpus", () => {
		const report = runOutboxAuditValidation(db, SITE_ID, FIXED_NOW);
		expect(report.violationsFound).toBe(0);
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

	it("cadence gate fires once per hour", () => {
		expect(shouldRunOutboxAuditValidation(db, FIXED_NOW)).toBe(true);
		runOutboxAuditValidation(db, SITE_ID, FIXED_NOW);
		expect(shouldRunOutboxAuditValidation(db, FIXED_NOW + 30 * 60 * 1000)).toBe(false);
		expect(shouldRunOutboxAuditValidation(db, FIXED_NOW + 61 * 60 * 1000)).toBe(true);
	});

	it("scans every synced table that exists in the schema", () => {
		const report = runOutboxAuditValidation(db, SITE_ID, FIXED_NOW);
		// applySchema creates the bulk of the synced tables; expect
		// most of them to appear in the scan count.
		expect(report.tablesScanned).toBeGreaterThanOrEqual(10);
	});
});
