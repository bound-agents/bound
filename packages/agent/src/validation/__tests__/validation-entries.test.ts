import Database from "bun:sqlite";
import { beforeEach, describe, expect, it } from "bun:test";
import { applySchema, softDelete } from "@bound/core";
import { BOUND_NAMESPACE, deterministicUUID } from "@bound/shared";
import { isValidationDue, recordValidationRun, writeValidationEntry } from "../validation-entries";

const SITE_ID = "test-site";
const KEY = "_validation:test-last-run";
const HOUR = 60 * 60 * 1000;
const NOW = Date.parse("2026-11-26T09:00:00.000Z");

function markerRow(db: Database): { value: string; deleted: number } | null {
	return db.prepare("SELECT value, deleted FROM semantic_memory WHERE key = ?").get(KEY) as {
		value: string;
		deleted: number;
	} | null;
}

describe("validation entries", () => {
	let db: Database;

	beforeEach(() => {
		db = new Database(":memory:");
		applySchema(db);
	});

	it("is due when no marker exists", () => {
		expect(isValidationDue(db, KEY, NOW, HOUR)).toBe(true);
	});

	it("is not due inside the interval and due after it", () => {
		recordValidationRun(db, SITE_ID, KEY, "validation:test", NOW);
		expect(isValidationDue(db, KEY, NOW + HOUR - 1, HOUR)).toBe(false);
		expect(isValidationDue(db, KEY, NOW + HOUR, HOUR)).toBe(true);
	});

	it("treats an unparseable marker as due instead of suppressing the run forever", () => {
		writeValidationEntry(db, SITE_ID, {
			key: KEY,
			value: "not-a-timestamp",
			source: "validation:test",
			nowMs: NOW,
		});
		expect(isValidationDue(db, KEY, NOW, HOUR)).toBe(true);
	});

	it("updates an existing marker in place", () => {
		recordValidationRun(db, SITE_ID, KEY, "validation:test", NOW);
		recordValidationRun(db, SITE_ID, KEY, "validation:test", NOW + HOUR);
		expect(markerRow(db)?.value).toBe(new Date(NOW + HOUR).toISOString());
		const count = db
			.prepare("SELECT COUNT(*) AS n FROM semantic_memory WHERE key = ?")
			.get(KEY) as {
			n: number;
		};
		expect(count.n).toBe(1);
	});

	it("revives a soft-deleted marker so the cadence gate sees it", () => {
		recordValidationRun(db, SITE_ID, KEY, "validation:test", NOW);
		softDelete(db, "semantic_memory", deterministicUUID(BOUND_NAMESPACE, KEY), SITE_ID);
		expect(isValidationDue(db, KEY, NOW + 1, HOUR)).toBe(true);

		recordValidationRun(db, SITE_ID, KEY, "validation:test", NOW + 1);
		expect(markerRow(db)).toEqual({ value: new Date(NOW + 1).toISOString(), deleted: 0 });
		expect(isValidationDue(db, KEY, NOW + 2, HOUR)).toBe(false);
	});
});
