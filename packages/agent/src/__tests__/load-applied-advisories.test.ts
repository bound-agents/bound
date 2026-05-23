import BunDatabase from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { applySchema, insertRow } from "@bound/core";
import { loadAppliedAdvisoriesForLiveState } from "../summary-extraction";

let db: BunDatabase.Database;

beforeEach(() => {
	db = new BunDatabase(":memory:");
	applySchema(db);
});

afterEach(() => {
	db.close();
});

describe("loadAppliedAdvisoriesForLiveState", () => {
	const siteId = "test-site";

	test("Empty advisories table returns empty result", () => {
		const nowMs = Date.now();
		const result = loadAppliedAdvisoriesForLiveState(db, nowMs);
		expect(result).toEqual([]);
	});

	test("Status filter — only 'applied' is returned", () => {
		const nowMs = Date.now();
		const resolvedAt = new Date(nowMs - 1 * 60 * 60 * 1000).toISOString(); // 1h ago

		// Insert advisories with different statuses
		insertRow(
			db,
			"advisories",
			{
				id: "adv-1",
				type: "general",
				status: "proposed",
				title: "Proposed Advisory",
				detail: "Detail",
				proposed_at: resolvedAt,
				modified_at: resolvedAt,
				resolved_at: resolvedAt,
			},
			siteId,
		);

		insertRow(
			db,
			"advisories",
			{
				id: "adv-2",
				type: "general",
				status: "approved",
				title: "Approved Advisory",
				detail: "Detail",
				proposed_at: resolvedAt,
				modified_at: resolvedAt,
				resolved_at: resolvedAt,
			},
			siteId,
		);

		insertRow(
			db,
			"advisories",
			{
				id: "adv-3",
				type: "general",
				status: "applied",
				title: "Applied Advisory",
				detail: "Detail",
				proposed_at: resolvedAt,
				modified_at: resolvedAt,
				resolved_at: resolvedAt,
			},
			siteId,
		);

		insertRow(
			db,
			"advisories",
			{
				id: "adv-4",
				type: "general",
				status: "dismissed",
				title: "Dismissed Advisory",
				detail: "Detail",
				proposed_at: resolvedAt,
				modified_at: resolvedAt,
				resolved_at: resolvedAt,
			},
			siteId,
		);

		const result = loadAppliedAdvisoriesForLiveState(db, nowMs);
		expect(result).toHaveLength(1);
		expect(result[0].title).toBe("Applied Advisory");
	});

	test("24-hour window filter", () => {
		const nowMs = Date.now();

		// Insert advisory 1h ago (should be included)
		const at1h = new Date(nowMs - 1 * 60 * 60 * 1000).toISOString();
		insertRow(
			db,
			"advisories",
			{
				id: "adv-1",
				type: "general",
				status: "applied",
				title: "Advisory 1h ago",
				detail: "Detail",
				proposed_at: at1h,
				modified_at: at1h,
				resolved_at: at1h,
			},
			siteId,
		);

		// Insert advisory 23h ago (should be included)
		const at23h = new Date(nowMs - 23 * 60 * 60 * 1000).toISOString();
		insertRow(
			db,
			"advisories",
			{
				id: "adv-2",
				type: "general",
				status: "applied",
				title: "Advisory 23h ago",
				detail: "Detail",
				proposed_at: at23h,
				modified_at: at23h,
				resolved_at: at23h,
			},
			siteId,
		);

		// Insert advisory 25h ago (should NOT be included)
		const at25h = new Date(nowMs - 25 * 60 * 60 * 1000).toISOString();
		insertRow(
			db,
			"advisories",
			{
				id: "adv-3",
				type: "general",
				status: "applied",
				title: "Advisory 25h ago",
				detail: "Detail",
				proposed_at: at25h,
				modified_at: at25h,
				resolved_at: at25h,
			},
			siteId,
		);

		const result = loadAppliedAdvisoriesForLiveState(db, nowMs);
		expect(result).toHaveLength(2);
		expect(result.map((r) => r.title).sort()).toEqual(["Advisory 1h ago", "Advisory 23h ago"]);
	});

	test("Soft-delete filter", () => {
		const nowMs = Date.now();
		const resolvedAt = new Date(nowMs - 1 * 60 * 60 * 1000).toISOString();

		// Insert applied advisory (not deleted)
		insertRow(
			db,
			"advisories",
			{
				id: "adv-1",
				type: "general",
				status: "applied",
				title: "Not Deleted",
				detail: "Detail",
				proposed_at: resolvedAt,
				modified_at: resolvedAt,
				resolved_at: resolvedAt,
				deleted: 0,
			},
			siteId,
		);

		// Insert applied advisory (soft-deleted)
		insertRow(
			db,
			"advisories",
			{
				id: "adv-2",
				type: "general",
				status: "applied",
				title: "Soft Deleted",
				detail: "Detail",
				proposed_at: resolvedAt,
				modified_at: resolvedAt,
				resolved_at: resolvedAt,
				deleted: 1,
			},
			siteId,
		);

		const result = loadAppliedAdvisoriesForLiveState(db, nowMs);
		expect(result).toHaveLength(1);
		expect(result[0].title).toBe("Not Deleted");
	});

	test("Ordering by resolved_at DESC", () => {
		const nowMs = Date.now();

		const at1h = new Date(nowMs - 1 * 60 * 60 * 1000).toISOString();
		insertRow(
			db,
			"advisories",
			{
				id: "adv-1",
				type: "general",
				status: "applied",
				title: "First",
				detail: "Detail",
				proposed_at: at1h,
				modified_at: at1h,
				resolved_at: at1h,
			},
			siteId,
		);

		const at5h = new Date(nowMs - 5 * 60 * 60 * 1000).toISOString();
		insertRow(
			db,
			"advisories",
			{
				id: "adv-2",
				type: "general",
				status: "applied",
				title: "Second",
				detail: "Detail",
				proposed_at: at5h,
				modified_at: at5h,
				resolved_at: at5h,
			},
			siteId,
		);

		const result = loadAppliedAdvisoriesForLiveState(db, nowMs);
		expect(result).toHaveLength(2);
		expect(result[0].title).toBe("First"); // most recent first
		expect(result[1].title).toBe("Second");
	});

	test("Title preserved verbatim with special characters", () => {
		const nowMs = Date.now();
		const resolvedAt = new Date(nowMs - 1 * 60 * 60 * 1000).toISOString();

		const titleWithSpecialChars = 'Advisory "with em-dash — and quotes"';
		insertRow(
			db,
			"advisories",
			{
				id: "adv-1",
				type: "general",
				status: "applied",
				title: titleWithSpecialChars,
				detail: "Detail",
				proposed_at: resolvedAt,
				modified_at: resolvedAt,
				resolved_at: resolvedAt,
			},
			siteId,
		);

		const result = loadAppliedAdvisoriesForLiveState(db, nowMs);
		expect(result).toHaveLength(1);
		expect(result[0].title).toBe(titleWithSpecialChars);
	});

	test("No duplicate suppression — same title twice both returned", () => {
		const nowMs = Date.now();

		const at1h = new Date(nowMs - 1 * 60 * 60 * 1000).toISOString();
		insertRow(
			db,
			"advisories",
			{
				id: "adv-1",
				type: "general",
				status: "applied",
				title: "Duplicate Title",
				detail: "Detail 1",
				proposed_at: at1h,
				modified_at: at1h,
				resolved_at: at1h,
			},
			siteId,
		);

		const at2h = new Date(nowMs - 2 * 60 * 60 * 1000).toISOString();
		insertRow(
			db,
			"advisories",
			{
				id: "adv-2",
				type: "general",
				status: "applied",
				title: "Duplicate Title",
				detail: "Detail 2",
				proposed_at: at2h,
				modified_at: at2h,
				resolved_at: at2h,
			},
			siteId,
		);

		const result = loadAppliedAdvisoriesForLiveState(db, nowMs);
		expect(result).toHaveLength(2);
		expect(result[0].title).toBe("Duplicate Title");
		expect(result[1].title).toBe("Duplicate Title");
	});
});
