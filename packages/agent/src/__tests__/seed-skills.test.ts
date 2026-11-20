/**
 * Tests for seedBundledSkills startup seeding.
 * Verifies AC5.1–AC5.5 against the skill-authoring bundled skill, plus that
 * every bundled skill (not just skill-authoring) is seeded.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { createHash, randomBytes } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applySchema, createDatabase, insertRow } from "@bound/core";
import { BOUND_NAMESPACE, deterministicUUID } from "@bound/shared";
import { cleanupTmpDir } from "@bound/shared/test-utils";
import { BUNDLED_SKILLS } from "../bundled-skills";
import { seedBundledSkills } from "../seed-skills";

const SKILL_AUTHORING = BUNDLED_SKILLS.find((s) => s.name === "skill-authoring");
if (!SKILL_AUTHORING) throw new Error("skill-authoring missing from BUNDLED_SKILLS");
const SKILL_AUTHORING_SKILL_MD = SKILL_AUTHORING.files.find((f) => f.path === "SKILL.md")?.content;

describe("seedBundledSkills", () => {
	let tmpDir: string;
	let dbPath: string;
	let db: ReturnType<typeof createDatabase>;
	const siteId = "test-site-id";

	beforeEach(() => {
		tmpDir = mkdtempSync(join(tmpdir(), `seed-skills-test-${randomBytes(4).toString("hex")}-`));
		dbPath = join(tmpDir, "test.db");
		db = createDatabase(dbPath);
		applySchema(db);
	});

	afterEach(async () => {
		try {
			db.close();
		} catch {
			// ignore
		}
		try {
			await cleanupTmpDir(tmpDir);
		} catch {
			// ignore
		}
	});

	it("AC5.3: Does not override an existing skill row on re-seed", () => {
		const skillName = "skill-authoring";
		const skillId = deterministicUUID(BOUND_NAMESPACE, skillName);
		const skillRoot = `/home/user/skills/${skillName}`;
		const now = new Date().toISOString();

		// Pre-insert a skill-authoring row with a distinctive description
		insertRow(
			db,
			"skills",
			{
				id: skillId,
				name: skillName,
				description: "Pre-existing description",
				skill_root: skillRoot,
				content_hash: "dummy-hash",
				allowed_tools: "",
				compatibility: null,
				metadata_json: "{}",
				activated_at: null,
				created_by_thread: null,
				activation_count: 0,
				last_activated_at: null,
				modified_at: now,
				deleted: 0,
			},
			siteId,
		);

		// Call seeding
		seedBundledSkills(db, siteId);

		// Verify the pre-existing row is left unchanged
		const skillRow = db.prepare("SELECT description FROM skills WHERE id = ?").get(skillId) as {
			description: string;
		} | null;

		expect(skillRow?.description).toBe("Pre-existing description");

		// Verify no duplicate rows exist
		const count = db.prepare("SELECT COUNT(*) as cnt FROM skills WHERE id = ?").get(skillId) as {
			cnt: number;
		};

		expect(count.cnt).toBe(1);
	});

	it("AC5.4: Restores soft-deleted files on next startup", () => {
		// First seed
		seedBundledSkills(db, siteId);

		const skillMdPath = "/home/user/skills/skill-authoring/SKILL.md";
		const fileRow = db
			.prepare("SELECT id FROM files WHERE path = ? AND deleted = 0")
			.get(skillMdPath);

		expect(fileRow).toBeDefined();

		// Soft-delete the file
		db.prepare("UPDATE files SET deleted = 1 WHERE path = ?").run(skillMdPath);

		// Verify deleted
		const deletedRow = db
			.prepare("SELECT id FROM files WHERE path = ? AND deleted = 0")
			.get(skillMdPath);

		expect(deletedRow).toBeNull();

		// Seed again
		seedBundledSkills(db, siteId);

		// Verify restored
		const restoredRow = db
			.prepare("SELECT id, path, content FROM files WHERE path = ? AND deleted = 0")
			.get(skillMdPath);

		expect(restoredRow).toBeDefined();
		expect(restoredRow?.path).toBe(skillMdPath);
		expect(restoredRow?.content).toBe(SKILL_AUTHORING_SKILL_MD);
	});

	it("AC5.5: Content hash on the skills row matches the sha256 of the bundled SKILL.md", () => {
		seedBundledSkills(db, siteId);

		const expectedSkillHash = createHash("sha256")
			.update(SKILL_AUTHORING_SKILL_MD ?? "")
			.digest("hex");

		const skillRowHash = db
			.prepare("SELECT content_hash FROM skills WHERE name = ?")
			.get("skill-authoring");

		expect(skillRowHash?.content_hash).toBe(expectedSkillHash);
	});

	it("seeds every bundled skill (files + active skills row)", () => {
		seedBundledSkills(db, siteId);

		for (const skill of BUNDLED_SKILLS) {
			const skillId = deterministicUUID(BOUND_NAMESPACE, skill.name);
			const row = db.prepare("SELECT name FROM skills WHERE id = ?").get(skillId) as {
				name: string;
			} | null;
			expect(row?.name).toBe(skill.name);

			for (const file of skill.files) {
				const path = `/home/user/skills/${skill.name}/${file.path}`;
				const fileRow = db
					.prepare("SELECT content FROM files WHERE path = ? AND deleted = 0")
					.get(path) as { content: string } | null;
				expect(fileRow?.content).toBe(file.content);
			}
		}
	});
});
