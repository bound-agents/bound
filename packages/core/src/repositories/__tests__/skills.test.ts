import type Database from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { Skill } from "@bound/shared";
import { createCoreTestDb } from "../../__tests__/test-database";
import { insertRow, softDelete } from "../../index";
import {
	findActiveSkillIdAndRootByName,
	findSkillById,
	findSkillByIdIncludingDeleted,
	findSkillByName,
	findSkillIdById,
	listActiveSkillNameDescriptions,
	listSkills,
} from "../skills";

const SITE_ID = "site-test";

function makeSkill(overrides: Partial<Skill> & Pick<Skill, "id" | "name">): Skill {
	return {
		description: "desc",
		skill_root: "skills/default/SKILL.md",
		content_hash: null,
		allowed_tools: null,
		compatibility: null,
		metadata_json: null,
		activated_at: null,
		created_by_thread: null,
		activation_count: 0,
		last_activated_at: null,
		modified_at: "2026-01-01T00:00:00.000Z",
		deleted: 0,
		...overrides,
	};
}

describe("skills repository finders", () => {
	let db: Database;

	beforeEach(() => {
		db = createCoreTestDb({ metrics: true });
	});

	afterEach(() => {
		db.close();
	});

	// ---- Simple by-name/by-id finders: happy + miss ----

	describe("findSkillByName", () => {
		it("returns the full row for an existing live skill (happy path)", () => {
			insertRow(
				db,
				"skills",
				makeSkill({ id: "s1", name: "alpha", description: "Alpha skill" }),
				SITE_ID,
			);

			const row = findSkillByName(db, "alpha");
			expect(row).not.toBeNull();
			expect(row?.id).toBe("s1");
			expect(row?.name).toBe("alpha");
			expect(row?.description).toBe("Alpha skill");
			expect(row?.deleted).toBe(0);
		});

		it("returns null for an absent name (miss path)", () => {
			expect(findSkillByName(db, "nope")).toBeNull();
		});

		it("returns null for a soft-deleted skill (deleted=0 filter)", () => {
			insertRow(db, "skills", makeSkill({ id: "s1", name: "alpha" }), SITE_ID);
			softDelete(db, "skills", "s1", SITE_ID);
			expect(findSkillByName(db, "alpha")).toBeNull();
		});
	});

	describe("findSkillById", () => {
		it("returns the live row by id (happy path)", () => {
			insertRow(db, "skills", makeSkill({ id: "s1", name: "alpha" }), SITE_ID);
			const row = findSkillById(db, "s1");
			expect(row?.id).toBe("s1");
			expect(row?.name).toBe("alpha");
		});

		it("returns null for an absent id (miss path)", () => {
			expect(findSkillById(db, "ghost")).toBeNull();
		});

		it("returns null for a soft-deleted id", () => {
			insertRow(db, "skills", makeSkill({ id: "s1", name: "alpha" }), SITE_ID);
			softDelete(db, "skills", "s1", SITE_ID);
			expect(findSkillById(db, "s1")).toBeNull();
		});
	});

	// ---- deleted-filter OMISSION variants ----
	// These finders intentionally have NO `deleted = 0` filter; pin that they
	// return tombstoned rows while their deleted=0 siblings do not.

	describe("findSkillByIdIncludingDeleted (deleted-omission variant)", () => {
		it("returns a soft-deleted row that findSkillById (deleted=0) hides", () => {
			insertRow(db, "skills", makeSkill({ id: "dead", name: "tombstone" }), SITE_ID);
			softDelete(db, "skills", "dead", SITE_ID);

			// The deleted=0 sibling hides it...
			expect(findSkillById(db, "dead")).toBeNull();
			// ...but the including-deleted variant surfaces it.
			const row = findSkillByIdIncludingDeleted(db, "dead");
			expect(row).not.toBeNull();
			expect(row?.id).toBe("dead");
			expect(row?.deleted).toBe(1);
		});

		it("also returns a live row (happy path)", () => {
			insertRow(db, "skills", makeSkill({ id: "live", name: "alive" }), SITE_ID);
			const row = findSkillByIdIncludingDeleted(db, "live");
			expect(row?.id).toBe("live");
			expect(row?.deleted).toBe(0);
		});

		it("returns null for an id that never existed (miss path)", () => {
			expect(findSkillByIdIncludingDeleted(db, "never")).toBeNull();
		});
	});

	describe("findSkillIdById (existence check, deleted-omission variant)", () => {
		it("returns {id} for a soft-deleted row that findSkillById hides", () => {
			insertRow(db, "skills", makeSkill({ id: "dead", name: "tombstone" }), SITE_ID);
			softDelete(db, "skills", "dead", SITE_ID);

			expect(findSkillById(db, "dead")).toBeNull();
			expect(findSkillIdById(db, "dead")).toEqual({ id: "dead" });
		});

		it("returns null for an absent id (miss path)", () => {
			expect(findSkillIdById(db, "never")).toBeNull();
		});
	});

	describe("findActiveSkillIdAndRootByName (deleted=0)", () => {
		it("returns id+skill_root for a live skill", () => {
			insertRow(
				db,
				"skills",
				makeSkill({
					id: "s1",
					name: "alpha",
					skill_root: "skills/alpha/SKILL.md",
				}),
				SITE_ID,
			);
			expect(findActiveSkillIdAndRootByName(db, "alpha")).toEqual({
				id: "s1",
				skill_root: "skills/alpha/SKILL.md",
			});
		});

		it("returns null for a soft-deleted skill (deleted filter)", () => {
			insertRow(db, "skills", makeSkill({ id: "s1", name: "alpha" }), SITE_ID);
			softDelete(db, "skills", "s1", SITE_ID);
			expect(findActiveSkillIdAndRootByName(db, "alpha")).toBeNull();
		});
	});

	// ---- listSkills (unordered, deleted=0) ----

	describe("listSkills", () => {
		it("returns all live skills and excludes soft-deleted ones", () => {
			insertRow(db, "skills", makeSkill({ id: "s1", name: "alpha" }), SITE_ID);
			insertRow(db, "skills", makeSkill({ id: "s2", name: "beta" }), SITE_ID);
			insertRow(db, "skills", makeSkill({ id: "s3", name: "gamma" }), SITE_ID);
			softDelete(db, "skills", "s3", SITE_ID);

			const ids = listSkills(db)
				.map((s) => s.id)
				.sort();
			expect(ids).toEqual(["s1", "s2"]);
		});

		it("returns [] when no live skills exist", () => {
			expect(listSkills(db)).toEqual([]);
		});
	});

	// ---- listActiveSkillNameDescriptions (ORDER BY last_activated_at DESC, deleted=0) ----

	describe("listActiveSkillNameDescriptions", () => {
		it("returns live skills as name+description ordered by last_activated_at DESC", () => {
			insertRow(
				db,
				"skills",
				makeSkill({
					id: "s1",
					name: "alpha",
					description: "A",
					last_activated_at: "2026-01-01T00:00:00.000Z",
				}),
				SITE_ID,
			);
			insertRow(
				db,
				"skills",
				makeSkill({
					id: "s2",
					name: "beta",
					description: "B",
					last_activated_at: "2026-03-01T00:00:00.000Z",
				}),
				SITE_ID,
			);
			insertRow(
				db,
				"skills",
				makeSkill({
					id: "s3",
					name: "gamma",
					description: "G",
					last_activated_at: "2026-02-01T00:00:00.000Z",
				}),
				SITE_ID,
			);
			// soft-deleted -> excluded
			insertRow(
				db,
				"skills",
				makeSkill({
					id: "s4",
					name: "delta",
					description: "D",
					last_activated_at: "2026-04-01T00:00:00.000Z",
				}),
				SITE_ID,
			);
			softDelete(db, "skills", "s4", SITE_ID);

			expect(listActiveSkillNameDescriptions(db)).toEqual([
				{ name: "beta", description: "B" },
				{ name: "gamma", description: "G" },
				{ name: "alpha", description: "A" },
			]);
		});

		it("returns [] when no live skills exist", () => {
			insertRow(db, "skills", makeSkill({ id: "s1", name: "alpha" }), SITE_ID);
			softDelete(db, "skills", "s1", SITE_ID);
			expect(listActiveSkillNameDescriptions(db)).toEqual([]);
		});
	});
});
