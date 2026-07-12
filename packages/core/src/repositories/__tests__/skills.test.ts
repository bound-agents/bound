import Database from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { Skill } from "@bound/shared";
import { applyMetricsSchema, applySchema, insertRow, softDelete } from "../../index";
import {
	findActiveSkillIdAndRootByName,
	findActiveSkillSourceByName,
	findSkillById,
	findSkillByIdIncludingDeleted,
	findSkillByName,
	findSkillDetailByName,
	findSkillIdById,
	findSkillMetadataByName,
	findSkillRootByName,
	listActiveSkillNameDescriptions,
	listActiveSkills,
	listSkills,
	listSkillsForCliView,
	listSkillsForToolView,
} from "../skills";

const SITE_ID = "site-test";

function makeSkill(overrides: Partial<Skill> & Pick<Skill, "id" | "name">): Skill {
	return {
		description: "desc",
		status: "active",
		skill_root: "skills/default/SKILL.md",
		content_hash: null,
		allowed_tools: null,
		compatibility: null,
		metadata_json: null,
		activated_at: null,
		created_by_thread: null,
		activation_count: 0,
		last_activated_at: null,
		retired_by: null,
		retired_reason: null,
		modified_at: "2026-01-01T00:00:00.000Z",
		deleted: 0,
		...overrides,
	};
}

describe("skills repository finders", () => {
	let db: Database;

	beforeEach(() => {
		db = new Database(":memory:");
		applySchema(db);
		applyMetricsSchema(db);
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

	// ---- Projection-by-name finders (share the same `name = ? AND deleted = 0` shape) ----

	describe("findSkillRootByName", () => {
		it("returns the skill_root for a live skill", () => {
			insertRow(
				db,
				"skills",
				makeSkill({ id: "s1", name: "alpha", skill_root: "skills/alpha/SKILL.md" }),
				SITE_ID,
			);
			expect(findSkillRootByName(db, "alpha")).toEqual({ skill_root: "skills/alpha/SKILL.md" });
		});

		it("returns null for a soft-deleted skill (deleted=0 filter)", () => {
			insertRow(db, "skills", makeSkill({ id: "s1", name: "alpha" }), SITE_ID);
			softDelete(db, "skills", "s1", SITE_ID);
			expect(findSkillRootByName(db, "alpha")).toBeNull();
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

	describe("findActiveSkillSourceByName (deleted=0)", () => {
		it("returns skill_root, content_hash, modified_at for a live skill", () => {
			insertRow(
				db,
				"skills",
				makeSkill({
					id: "s1",
					name: "alpha",
					skill_root: "skills/alpha/SKILL.md",
					content_hash: "abc123",
					modified_at: "2026-02-02T00:00:00.000Z",
				}),
				SITE_ID,
			);
			expect(findActiveSkillSourceByName(db, "alpha")).toEqual({
				skill_root: "skills/alpha/SKILL.md",
				content_hash: "abc123",
				modified_at: "2026-02-02T00:00:00.000Z",
			});
		});

		it("returns null for a soft-deleted skill", () => {
			insertRow(db, "skills", makeSkill({ id: "s1", name: "alpha" }), SITE_ID);
			softDelete(db, "skills", "s1", SITE_ID);
			expect(findActiveSkillSourceByName(db, "alpha")).toBeNull();
		});
	});

	describe("findSkillMetadataByName", () => {
		it("returns the projected metadata columns for a live skill", () => {
			insertRow(
				db,
				"skills",
				makeSkill({
					id: "s1",
					name: "alpha",
					description: "Alpha",
					activation_count: 4,
					last_activated_at: "2026-03-03T00:00:00.000Z",
					content_hash: "h1",
					skill_root: "skills/alpha/SKILL.md",
				}),
				SITE_ID,
			);
			expect(findSkillMetadataByName(db, "alpha")).toEqual({
				id: "s1",
				name: "alpha",
				activation_count: 4,
				last_activated_at: "2026-03-03T00:00:00.000Z",
				description: "Alpha",
				content_hash: "h1",
				skill_root: "skills/alpha/SKILL.md",
			});
		});

		it("returns null for a soft-deleted skill", () => {
			insertRow(db, "skills", makeSkill({ id: "s1", name: "alpha" }), SITE_ID);
			softDelete(db, "skills", "s1", SITE_ID);
			expect(findSkillMetadataByName(db, "alpha")).toBeNull();
		});
	});

	describe("findSkillDetailByName", () => {
		it("returns the projected detail columns for a live skill", () => {
			insertRow(
				db,
				"skills",
				makeSkill({
					id: "s1",
					name: "alpha",
					description: "Alpha",
					activation_count: 2,
					last_activated_at: null,
					content_hash: null,
					skill_root: "skills/alpha/SKILL.md",
				}),
				SITE_ID,
			);
			expect(findSkillDetailByName(db, "alpha")).toEqual({
				id: "s1",
				name: "alpha",
				activation_count: 2,
				last_activated_at: null,
				description: "Alpha",
				content_hash: null,
				skill_root: "skills/alpha/SKILL.md",
			});
		});

		it("returns null for an absent name", () => {
			expect(findSkillDetailByName(db, "nope")).toBeNull();
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

	// ---- listActiveSkills (ORDER BY name ASC, deleted=0) ----

	describe("listActiveSkills", () => {
		it("returns live skills ordered by name ascending", () => {
			insertRow(db, "skills", makeSkill({ id: "s1", name: "gamma" }), SITE_ID);
			insertRow(db, "skills", makeSkill({ id: "s2", name: "alpha" }), SITE_ID);
			insertRow(db, "skills", makeSkill({ id: "s3", name: "beta" }), SITE_ID);
			insertRow(db, "skills", makeSkill({ id: "s4", name: "delta" }), SITE_ID);
			softDelete(db, "skills", "s4", SITE_ID);

			const names = listActiveSkills(db).map((s) => s.name);
			expect(names).toEqual(["alpha", "beta", "gamma"]);
		});

		it("returns [] when empty", () => {
			expect(listActiveSkills(db)).toEqual([]);
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

	// ---- listSkillsForCliView / listSkillsForToolView
	//      (all live skills, ORDER BY last_activated_at DESC, name ASC) ----

	describe("listSkillsForCliView", () => {
		function seedOrderingSet() {
			// Two rows share an identical last_activated_at to exercise the secondary
			// `name ASC` tiebreak.
			insertRow(
				db,
				"skills",
				makeSkill({
					id: "s1",
					name: "zeta",
					last_activated_at: "2026-03-01T00:00:00.000Z",
					skill_root: "skills/zeta/SKILL.md",
				}),
				SITE_ID,
			);
			insertRow(
				db,
				"skills",
				makeSkill({
					id: "s2",
					name: "beta",
					last_activated_at: "2026-03-01T00:00:00.000Z",
					skill_root: "skills/beta/SKILL.md",
				}),
				SITE_ID,
			);
			insertRow(
				db,
				"skills",
				makeSkill({
					id: "s3",
					name: "alpha",
					last_activated_at: "2026-05-01T00:00:00.000Z",
					skill_root: "skills/alpha/SKILL.md",
				}),
				SITE_ID,
			);
			insertRow(
				db,
				"skills",
				makeSkill({
					id: "s4",
					name: "gone",
					last_activated_at: "2026-09-01T00:00:00.000Z",
					skill_root: "skills/gone/SKILL.md",
				}),
				SITE_ID,
			);
			softDelete(db, "skills", "s4", SITE_ID);
		}

		it("returns all live skills ordered by last_activated_at DESC then name ASC", () => {
			seedOrderingSet();
			const view = listSkillsForCliView(db).map((r) => r.name);
			// s3 (2026-05-01) first; then the 2026-03-01 pair tie-broken by name ASC: beta, zeta.
			// s4 is soft-deleted and excluded.
			expect(view).toEqual(["alpha", "beta", "zeta"]);
		});

		it("projects the skill_root column (distinguishes it from the tool view)", () => {
			insertRow(
				db,
				"skills",
				makeSkill({
					id: "s1",
					name: "alpha",
					skill_root: "skills/alpha/SKILL.md",
					allowed_tools: '["read"]',
					compatibility: "v1",
					content_hash: "h1",
				}),
				SITE_ID,
			);
			const row = listSkillsForCliView(db)[0];
			expect(row).toEqual({
				name: "alpha",
				activation_count: 0,
				last_activated_at: null,
				description: "desc",
				allowed_tools: '["read"]',
				compatibility: "v1",
				content_hash: "h1",
				skill_root: "skills/alpha/SKILL.md",
			});
		});

		it("returns [] over an empty table", () => {
			expect(listSkillsForCliView(db)).toEqual([]);
		});
	});

	describe("listSkillsForToolView", () => {
		it("returns the same ordering as the CLI view but omits skill_root", () => {
			insertRow(
				db,
				"skills",
				makeSkill({
					id: "s1",
					name: "zeta",
					last_activated_at: "2026-03-01T00:00:00.000Z",
				}),
				SITE_ID,
			);
			insertRow(
				db,
				"skills",
				makeSkill({
					id: "s2",
					name: "beta",
					last_activated_at: "2026-03-01T00:00:00.000Z",
				}),
				SITE_ID,
			);

			const rows = listSkillsForToolView(db);
			expect(rows.map((r) => r.name)).toEqual(["beta", "zeta"]);
			// skill_root must NOT be present on tool-view rows.
			expect("skill_root" in rows[0]).toBe(false);
		});

		it("returns [] over an empty table", () => {
			expect(listSkillsForToolView(db)).toEqual([]);
		});
	});
});
