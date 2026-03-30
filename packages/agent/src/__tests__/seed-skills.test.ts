/**
 * Tests for seedSkillAuthoring startup seeding.
 * Verifies AC5.1–AC5.5: skill-authoring bundled skill is always present.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { createHash, randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applySchema, createDatabase, insertRow } from "@bound/core";
import { BOUND_NAMESPACE, deterministicUUID } from "@bound/shared";
import {
	SKILL_AUTHORING_FORMAT_REFERENCE_MD,
	SKILL_AUTHORING_SKILL_MD,
} from "../bundled-skills";
import { seedSkillAuthoring } from "../seed-skills";

describe("seedSkillAuthoring", () => {
	let tmpDir: string;
	let dbPath: string;
	let db: any;
	const siteId = "test-site-id";

	beforeEach(() => {
		tmpDir = mkdtempSync(join(tmpdir(), `seed-skills-test-${randomBytes(4).toString("hex")}-`));
		dbPath = join(tmpDir, "test.db");
		db = createDatabase(dbPath);
		applySchema(db);
	});

	afterEach(() => {
		try {
			db.close();
		} catch {
			// ignore
		}
		try {
			rmSync(tmpDir, { recursive: true, force: true });
		} catch {
			// ignore
		}
	});

	it("AC5.1: Creates skill-authoring files in files table after first startup", () => {
		seedSkillAuthoring(db, siteId);

		const skillMdFile = db
			.prepare("SELECT id, path, content FROM files WHERE path = ? AND deleted = 0")
			.get("/home/user/skills/skill-authoring/SKILL.md");

		expect(skillMdFile).toBeDefined();
		expect(skillMdFile?.path).toBe("/home/user/skills/skill-authoring/SKILL.md");
		expect(skillMdFile?.content).toBe(SKILL_AUTHORING_SKILL_MD);

		const refFile = db
			.prepare(
				"SELECT id, path, content FROM files WHERE path = ? AND deleted = 0",
			)
			.get("/home/user/skills/skill-authoring/references/format-reference.md");

		expect(refFile).toBeDefined();
		expect(refFile?.path).toBe("/home/user/skills/skill-authoring/references/format-reference.md");
		expect(refFile?.content).toBe(SKILL_AUTHORING_FORMAT_REFERENCE_MD);
	});

	it("AC5.2: Creates skills table row with correct ID and active status", () => {
		seedSkillAuthoring(db, siteId);

		const expectedSkillId = deterministicUUID(BOUND_NAMESPACE, "skill-authoring");
		const skillRow = db
			.prepare("SELECT id, name, status FROM skills WHERE id = ?")
			.get(expectedSkillId);

		expect(skillRow).toBeDefined();
		expect(skillRow?.id).toBe(expectedSkillId);
		expect(skillRow?.name).toBe("skill-authoring");
		expect(skillRow?.status).toBe("active");
	});

	it("AC5.3: Does not override retired skill if already retired", () => {
		const skillName = "skill-authoring";
		const skillId = deterministicUUID(BOUND_NAMESPACE, skillName);
		const skillRoot = `/home/user/skills/${skillName}`;
		const now = new Date().toISOString();

		// Pre-insert a retired skill-authoring row
		insertRow(
			db,
			"skills",
			{
				id: skillId,
				name: skillName,
				description: "Retired skill",
				status: "retired",
				skill_root: skillRoot,
				content_hash: "dummy-hash",
				allowed_tools: "",
				compatibility: null,
				metadata_json: "{}",
				activated_at: null,
				created_by_thread: null,
				activation_count: 0,
				last_activated_at: null,
				retired_by: "operator",
				retired_reason: "Testing",
				modified_at: now,
				deleted: 0,
			},
			siteId,
		);

		// Call seeding
		seedSkillAuthoring(db, siteId);

		// Verify status remains retired
		const skillRow = db
			.prepare("SELECT status, retired_by FROM skills WHERE id = ?")
			.get(skillId);

		expect(skillRow?.status).toBe("retired");
		expect(skillRow?.retired_by).toBe("operator");

		// Verify no duplicate rows exist
		const count = db
			.prepare("SELECT COUNT(*) as cnt FROM skills WHERE id = ?")
			.get(skillId) as { cnt: number };

		expect(count.cnt).toBe(1);
	});

	it("AC5.4: Restores soft-deleted files on next startup", () => {
		// First seed
		seedSkillAuthoring(db, siteId);

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
		seedSkillAuthoring(db, siteId);

		// Verify restored
		const restoredRow = db
			.prepare(
				"SELECT id, path, content FROM files WHERE path = ? AND deleted = 0",
			)
			.get(skillMdPath);

		expect(restoredRow).toBeDefined();
		expect(restoredRow?.path).toBe(skillMdPath);
		expect(restoredRow?.content).toBe(SKILL_AUTHORING_SKILL_MD);
	});

	it("AC5.5: Content hash of seeded files matches bundled-skills.ts", () => {
		seedSkillAuthoring(db, siteId);

		// Verify SKILL.md content and hash match
		const skillMdFile = db
			.prepare("SELECT content FROM files WHERE path = ? AND deleted = 0")
			.get("/home/user/skills/skill-authoring/SKILL.md");

		expect(skillMdFile?.content).toBe(SKILL_AUTHORING_SKILL_MD);

		const expectedSkillHash = createHash("sha256")
			.update(SKILL_AUTHORING_SKILL_MD)
			.digest("hex");

		const skillRowHash = db
			.prepare("SELECT content_hash FROM skills WHERE name = ?")
			.get("skill-authoring");

		expect(skillRowHash?.content_hash).toBe(expectedSkillHash);

		// Verify format-reference.md content matches
		const refFile = db
			.prepare("SELECT content FROM files WHERE path = ? AND deleted = 0")
			.get("/home/user/skills/skill-authoring/references/format-reference.md");

		expect(refFile?.content).toBe(SKILL_AUTHORING_FORMAT_REFERENCE_MD);
	});
});
