import type Database from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { Advisory } from "@bound/shared";
import { createCoreTestDb } from "../../__tests__/test-database";
import { insertRow, softDelete } from "../../index";
import {
	countProposedAdvisories,
	findActiveAdvisoryById,
	findAdvisoryById,
	findAdvisoryIdsByPrefix,
	listActiveAdvisories,
	listActiveAdvisorySummaries,
	listAdvisoriesByStatus,
	listAdvisoriesByType,
	listAdvisorySummariesByStatus,
	listAppliedAdvisoriesResolvedSince,
} from "../advisories";

const SITE = "site-test";

/** Build a fully-populated Advisory row; override only what a test cares about. */
function makeAdvisory(overrides: Partial<Advisory> & { id: string }): Advisory {
	return {
		id: overrides.id,
		type: "general",
		status: "proposed",
		title: `title-${overrides.id}`,
		detail: `detail-${overrides.id}`,
		action: null,
		impact: null,
		evidence: null,
		proposed_at: "2026-01-01T00:00:00.000Z",
		defer_until: null,
		resolved_at: null,
		created_by: SITE,
		thread_id: null,
		modified_at: "2026-01-01T00:00:00.000Z",
		deleted: 0,
		...overrides,
	};
}

function seed(db: Database, overrides: Partial<Advisory> & { id: string }): void {
	insertRow(db, "advisories", makeAdvisory(overrides), SITE);
}

describe("advisories repository finders", () => {
	let db: Database;

	beforeEach(() => {
		db = createCoreTestDb({ metrics: true });
	});

	afterEach(() => {
		db.close();
	});

	describe("findAdvisoryById (by-id, no deleted filter)", () => {
		it("returns the row on a hit", () => {
			seed(db, { id: "a1", title: "hello" });
			const row = findAdvisoryById(db, "a1");
			expect(row).not.toBeNull();
			expect(row?.id).toBe("a1");
			expect(row?.title).toBe("hello");
		});

		it("returns null on a miss", () => {
			expect(findAdvisoryById(db, "absent")).toBeNull();
		});

		// findAdvisoryById has NO deleted=0 filter — it returns tombstoned rows too.
		it("returns a soft-deleted row (no deleted filter)", () => {
			seed(db, { id: "a1" });
			softDelete(db, "advisories", "a1", SITE);
			const row = findAdvisoryById(db, "a1");
			expect(row).not.toBeNull();
			expect(row?.id).toBe("a1");
			expect(row?.deleted).toBe(1);
		});
	});

	describe("findActiveAdvisoryById (by-id, deleted=0)", () => {
		it("returns a live row", () => {
			seed(db, { id: "a1" });
			expect(findActiveAdvisoryById(db, "a1")?.id).toBe("a1");
		});

		it("returns null on a miss", () => {
			expect(findActiveAdvisoryById(db, "absent")).toBeNull();
		});

		// Contrast with findAdvisoryById: the deleted=0 filter excludes the tombstone.
		it("excludes a soft-deleted row", () => {
			seed(db, { id: "a1" });
			softDelete(db, "advisories", "a1", SITE);
			expect(findActiveAdvisoryById(db, "a1")).toBeNull();
			// sibling without the filter still sees it
			expect(findAdvisoryById(db, "a1")).not.toBeNull();
		});
	});

	describe("countProposedAdvisories (aggregate COUNT)", () => {
		it("counts only non-deleted proposed rows", () => {
			seed(db, { id: "p1", status: "proposed" });
			seed(db, { id: "p2", status: "proposed" });
			seed(db, { id: "approved", status: "approved" });
			seed(db, { id: "deleted", status: "proposed" });
			softDelete(db, "advisories", "deleted", SITE);
			expect(countProposedAdvisories(db)).toBe(2);
		});

		it("returns 0 over an empty table", () => {
			expect(countProposedAdvisories(db)).toBe(0);
		});
	});

	describe("listAdvisoriesByStatus (status filter + deleted=0)", () => {
		it("returns matching live rows newest-proposed first", () => {
			seed(db, { id: "d-old", status: "deferred", proposed_at: "2026-01-01T00:00:00.000Z" });
			seed(db, { id: "d-new", status: "deferred", proposed_at: "2026-02-01T00:00:00.000Z" });
			seed(db, { id: "other", status: "proposed" });
			seed(db, { id: "d-del", status: "deferred" });
			softDelete(db, "advisories", "d-del", SITE);
			expect(listAdvisoriesByStatus(db, "deferred").map((r) => r.id)).toEqual(["d-new", "d-old"]);
		});

		it("returns [] for an unmatched status", () => {
			seed(db, { id: "p1", status: "proposed" });
			expect(listAdvisoriesByStatus(db, "applied")).toEqual([]);
		});
	});

	describe("listActiveAdvisories (NOT IN terminal states + deleted=0)", () => {
		it("excludes applied/dismissed and tombstones", () => {
			seed(db, { id: "proposed", status: "proposed", proposed_at: "2026-01-01T00:00:00.000Z" });
			seed(db, { id: "approved", status: "approved", proposed_at: "2026-02-01T00:00:00.000Z" });
			seed(db, { id: "deferred", status: "deferred", proposed_at: "2026-03-01T00:00:00.000Z" });
			seed(db, { id: "applied", status: "applied" });
			seed(db, { id: "dismissed", status: "dismissed" });
			seed(db, { id: "del", status: "proposed" });
			softDelete(db, "advisories", "del", SITE);

			expect(listActiveAdvisories(db).map((r) => r.id)).toEqual([
				"deferred",
				"approved",
				"proposed",
			]);
		});
	});

	describe("listAppliedAdvisoriesResolvedSince (applied + resolved_at >= cutoff)", () => {
		it("returns applied rows resolved at-or-after cutoff, newest first", () => {
			seed(db, {
				id: "after",
				status: "applied",
				resolved_at: "2026-05-10T00:00:00.000Z",
				title: "A",
			});
			// exactly at cutoff — INCLUDED (>=)
			seed(db, {
				id: "boundary",
				status: "applied",
				resolved_at: "2026-05-01T00:00:00.000Z",
				title: "B",
			});
			// before cutoff — excluded
			seed(db, { id: "before", status: "applied", resolved_at: "2026-01-01T00:00:00.000Z" });
			// applied but null resolved_at — excluded
			seed(db, { id: "nullres", status: "applied", resolved_at: null });
			// wrong status
			seed(db, { id: "wrong", status: "approved", resolved_at: "2026-05-10T00:00:00.000Z" });

			expect(listAppliedAdvisoriesResolvedSince(db, "2026-05-01T00:00:00.000Z")).toEqual([
				{ id: "after", title: "A", resolved_at: "2026-05-10T00:00:00.000Z" },
				{ id: "boundary", title: "B", resolved_at: "2026-05-01T00:00:00.000Z" },
			]);
		});
	});

	describe("findAdvisoryIdsByPrefix (LIKE prefix, deleted=0, LIMIT 2)", () => {
		it("returns matching ids, capped at 2", () => {
			seed(db, { id: "abc-1" });
			seed(db, { id: "abc-2" });
			seed(db, { id: "abc-3" });
			seed(db, { id: "xyz-1" });
			const rows = findAdvisoryIdsByPrefix(db, "abc-");
			expect(rows.length).toBe(2);
			for (const r of rows) {
				expect(r.id.startsWith("abc-")).toBe(true);
			}
		});

		it("excludes soft-deleted rows and returns [] on no match", () => {
			seed(db, { id: "abc-1" });
			softDelete(db, "advisories", "abc-1", SITE);
			expect(findAdvisoryIdsByPrefix(db, "abc-")).toEqual([]);
			expect(findAdvisoryIdsByPrefix(db, "none-")).toEqual([]);
		});

		it("returns a single match", () => {
			seed(db, { id: "uniq-1" });
			seed(db, { id: "other-1" });
			expect(findAdvisoryIdsByPrefix(db, "uniq-")).toEqual([{ id: "uniq-1" }]);
		});
	});

	describe("listAdvisorySummariesByStatus (summary fields, deleted=0, LIMIT 20)", () => {
		it("returns summary fields newest-proposed first, capped at 20", () => {
			// seed 22 proposed rows with strictly increasing proposed_at
			for (let i = 0; i < 22; i++) {
				const month = String(i + 1).padStart(2, "0");
				seed(db, {
					id: `p-${month}`,
					status: "proposed",
					// stagger by minute so ordering is deterministic
					proposed_at: `2026-01-01T00:${month}:00.000Z`,
					type: "cost",
					title: `T-${month}`,
					detail: `D-${month}`,
				});
			}
			const rows = listAdvisorySummariesByStatus(db, "proposed");
			expect(rows.length).toBe(20);
			// newest first => p-22 down to p-03
			expect(rows[0]).toEqual({
				id: "p-22",
				type: "cost",
				status: "proposed",
				title: "T-22",
				detail: "D-22",
			});
			expect(rows[19].id).toBe("p-03");
		});

		it("returns [] for an unmatched status", () => {
			seed(db, { id: "p1", status: "proposed" });
			expect(listAdvisorySummariesByStatus(db, "applied")).toEqual([]);
		});
	});

	describe("listActiveAdvisorySummaries (NOT IN terminal, deleted=0, LIMIT 20)", () => {
		it("excludes applied/dismissed/tombstones and caps at 20", () => {
			for (let i = 0; i < 21; i++) {
				const idx = String(i + 1).padStart(2, "0");
				seed(db, {
					id: `act-${idx}`,
					status: "proposed",
					proposed_at: `2026-01-01T00:${idx}:00.000Z`,
				});
			}
			seed(db, { id: "applied", status: "applied" });
			seed(db, { id: "dismissed", status: "dismissed" });
			seed(db, { id: "del", status: "proposed" });
			softDelete(db, "advisories", "del", SITE);

			const rows = listActiveAdvisorySummaries(db);
			expect(rows.length).toBe(20);
			expect(rows[0].id).toBe("act-21");
			// none of the terminal/deleted ids present
			const ids = new Set(rows.map((r) => r.id));
			expect(ids.has("applied")).toBe(false);
			expect(ids.has("dismissed")).toBe(false);
			expect(ids.has("del")).toBe(false);
		});
	});

	describe("listAdvisoriesByType (type filter, all non-terminal and terminal, deleted=0)", () => {
		it("returns every non-deleted row of the type regardless of status, incl. applied/dismissed", () => {
			seed(db, {
				id: "prop",
				type: "model_reference_dangling",
				status: "proposed",
				created_by: "alice",
			});
			seed(db, {
				id: "appl",
				type: "model_reference_dangling",
				status: "applied",
				created_by: "alice",
			});
			seed(db, {
				id: "dism",
				type: "model_reference_dangling",
				status: "dismissed",
				created_by: "bob",
			});
			seed(db, { id: "other", type: "general", status: "proposed", created_by: "alice" });
			seed(db, {
				id: "del",
				type: "model_reference_dangling",
				status: "proposed",
				created_by: "alice",
			});
			softDelete(db, "advisories", "del", SITE);

			const rows = listAdvisoriesByType(db, "model_reference_dangling");
			const ids = new Set(rows.map((r) => r.id));
			expect(ids).toEqual(new Set(["prop", "appl", "dism"]));
			// created_by and status survive so the reconciler can scope auto-resolve.
			const byId = new Map(rows.map((r) => [r.id, r]));
			expect(byId.get("appl")?.status).toBe("applied");
			expect(byId.get("dism")?.created_by).toBe("bob");
		});

		it("returns [] for a type with no rows", () => {
			seed(db, { id: "g1", type: "general", status: "proposed" });
			expect(listAdvisoriesByType(db, "model_reference_dangling")).toEqual([]);
		});
	});
});
