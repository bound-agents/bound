import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { applySchema, insertRow } from "@bound/core";
import { BOUND_NAMESPACE, deterministicUUID } from "@bound/shared";
import type { SkillFileEntry } from "@bound/shared";
import { importSkillFromFiles } from "../skill-utils";

describe("importSkillFromFiles", () => {
	let db: Database;
	const siteId = "test-site-001";

	beforeEach(() => {
		db = new Database(":memory:");
		applySchema(db);
	});

	afterEach(() => {
		db.close();
	});

	describe("web-skills-tab.AC1.1: Valid SKILL.md creates active skill", () => {
		it("should create a skill with status active when given valid SKILL.md", async () => {
			const files: SkillFileEntry[] = [
				{
					path: "SKILL.md",
					content: `---
name: valid-skill
description: A valid test skill
---

# Valid Skill

This is a valid skill.`,
				},
			];

			const result = await importSkillFromFiles(db, siteId, files, {});

			expect(result.ok).toBe(true);
			if (!result.ok) throw new Error("Expected ok: true");

			const skill = db
				.prepare("SELECT id, name, status, description FROM skills WHERE id = ? AND deleted = 0")
				.get(result.skillId) as any;

			expect(skill).toBeDefined();
			expect(skill.name).toBe("valid-skill");
			expect(skill.status).toBe("active");
			expect(skill.description).toBe("A valid test skill");
		});
	});

	describe("web-skills-tab.AC1.2: Multi-file skill persists all files", () => {
		it("should persist SKILL.md and reference files to files table", async () => {
			const files: SkillFileEntry[] = [
				{
					path: "SKILL.md",
					content: `---
name: multi-file-skill
description: A multi-file skill
---

# Multi-file Skill

This skill has references.`,
				},
				{
					path: "references/format.md",
					content: "# Format Guide\n\nThis is a format guide.",
				},
			];

			const result = await importSkillFromFiles(db, siteId, files, {});

			expect(result.ok).toBe(true);
			if (!result.ok) throw new Error("Expected ok: true");

			// Check both files exist in files table
			const skillMd = db
				.prepare("SELECT id, path FROM files WHERE id = ? AND deleted = 0")
				.get("skills/multi-file-skill/SKILL.md") as any;

			const refFile = db
				.prepare("SELECT id, path FROM files WHERE id = ? AND deleted = 0")
				.get("skills/multi-file-skill/references/format.md") as any;

			expect(skillMd).toBeDefined();
			expect(skillMd.path).toBe("skills/multi-file-skill/SKILL.md");

			expect(refFile).toBeDefined();
			expect(refFile.path).toBe("skills/multi-file-skill/references/format.md");
		});
	});

	describe("web-skills-tab.AC1.3: Missing SKILL.md returns error", () => {
		it("should return error when SKILL.md is not in file list", async () => {
			const files: SkillFileEntry[] = [
				{
					path: "references/format.md",
					content: "# Format Guide",
				},
			];

			const result = await importSkillFromFiles(db, siteId, files, {});

			expect(result.ok).toBe(false);
			if (result.ok) throw new Error("Expected ok: false");
			expect(result.error).toMatch(/SKILL\.md not found/i);
		});
	});

	describe("web-skills-tab.AC1.4: Invalid name format returns validation error", () => {
		it("should return error for uppercase letters in name", async () => {
			const files: SkillFileEntry[] = [
				{
					path: "SKILL.md",
					content: `---
name: InvalidSkill
description: Invalid name
---

Content`,
				},
			];

			const result = await importSkillFromFiles(db, siteId, files, {});

			expect(result.ok).toBe(false);
			if (result.ok) throw new Error("Expected ok: false");
			expect(result.error).toMatch(/invalid.*name|name.*invalid/i);
		});

		it("should return error for spaces in name", async () => {
			const files: SkillFileEntry[] = [
				{
					path: "SKILL.md",
					content: `---
name: invalid skill
description: Invalid name
---

Content`,
				},
			];

			const result = await importSkillFromFiles(db, siteId, files, {});

			expect(result.ok).toBe(false);
			if (result.ok) throw new Error("Expected ok: false");
			expect(result.error).toMatch(/invalid.*name|name.*invalid/i);
		});

		it("should return error for special characters in name", async () => {
			const files: SkillFileEntry[] = [
				{
					path: "SKILL.md",
					content: `---
name: invalid@skill!
description: Invalid name
---

Content`,
				},
			];

			const result = await importSkillFromFiles(db, siteId, files, {});

			expect(result.ok).toBe(false);
			if (result.ok) throw new Error("Expected ok: false");
			expect(result.error).toMatch(/invalid.*name|name.*invalid/i);
		});
	});

	describe("web-skills-tab.AC1.5: Exceeding active skill cap returns error", () => {
		it("should return error when creating 21st active skill", async () => {
			// Insert 20 active skills
			for (let i = 0; i < 20; i++) {
				const skillId = deterministicUUID(BOUND_NAMESPACE, `skill-${i}`);
				insertRow(
					db,
					"skills",
					{
						id: skillId,
						name: `skill-${i}`,
						description: `Skill ${i}`,
						status: "active",
						skill_root: `skills/skill-${i}`,
						content_hash: null,
						allowed_tools: null,
						compatibility: null,
						metadata_json: null,
						activated_at: new Date().toISOString(),
						created_by_thread: null,
						activation_count: 1,
						last_activated_at: new Date().toISOString(),
						retired_by: null,
						retired_reason: null,
						modified_at: new Date().toISOString(),
						deleted: 0,
					},
					siteId,
				);
			}

			// Try to create 21st skill with a new name
			const files: SkillFileEntry[] = [
				{
					path: "SKILL.md",
					content: `---
name: skill-21
description: 21st skill
---

Content`,
				},
			];

			const result = await importSkillFromFiles(db, siteId, files, {});

			expect(result.ok).toBe(false);
			if (result.ok) throw new Error("Expected ok: false");
			expect(result.error).toMatch(/cap.*20|skill cap|limit/i);
		});

		it("should allow re-importing a retired skill even when at cap", async () => {
			const skillName = "retired-skill";
			const skillId = deterministicUUID(BOUND_NAMESPACE, skillName);

			// Insert 20 active skills
			for (let i = 0; i < 19; i++) {
				const id = deterministicUUID(BOUND_NAMESPACE, `skill-${i}`);
				insertRow(
					db,
					"skills",
					{
						id,
						name: `skill-${i}`,
						description: `Skill ${i}`,
						status: "active",
						skill_root: `skills/skill-${i}`,
						content_hash: null,
						allowed_tools: null,
						compatibility: null,
						metadata_json: null,
						activated_at: new Date().toISOString(),
						created_by_thread: null,
						activation_count: 1,
						last_activated_at: new Date().toISOString(),
						retired_by: null,
						retired_reason: null,
						modified_at: new Date().toISOString(),
						deleted: 0,
					},
					siteId,
				);
			}

			// Insert a retired skill
			insertRow(
				db,
				"skills",
				{
					id: skillId,
					name: skillName,
					description: "Old description",
					status: "retired",
					skill_root: `skills/${skillName}`,
					content_hash: "old-hash",
					allowed_tools: null,
					compatibility: null,
					metadata_json: null,
					activated_at: new Date().toISOString(),
					created_by_thread: null,
					activation_count: 1,
					last_activated_at: new Date().toISOString(),
					retired_by: "user-id",
					retired_reason: "No longer needed",
					modified_at: new Date().toISOString(),
					deleted: 0,
				},
				siteId,
			);

			// Import should succeed because it's a re-activation
			const files: SkillFileEntry[] = [
				{
					path: "SKILL.md",
					content: `---
name: retired-skill
description: New description
---

Updated content`,
				},
			];

			const result = await importSkillFromFiles(db, siteId, files, {});

			expect(result.ok).toBe(true);
			if (!result.ok) throw new Error("Expected ok: true");
		});
	});

	describe("web-skills-tab.AC1.6: Re-importing retired skill reactivates it", () => {
		it("should update retired skill to active and increment activation_count", async () => {
			const skillName = "reactivate-skill";
			const skillId = deterministicUUID(BOUND_NAMESPACE, skillName);
			const oldHash = "old-content-hash";

			// Insert a retired skill
			insertRow(
				db,
				"skills",
				{
					id: skillId,
					name: skillName,
					description: "Old description",
					status: "retired",
					skill_root: `skills/${skillName}`,
					content_hash: oldHash,
					allowed_tools: null,
					compatibility: null,
					metadata_json: null,
					activated_at: new Date(Date.now() - 86400000).toISOString(),
					created_by_thread: null,
					activation_count: 1,
					last_activated_at: new Date(Date.now() - 86400000).toISOString(),
					retired_by: "user-id",
					retired_reason: "Temporarily disabled",
					modified_at: new Date().toISOString(),
					deleted: 0,
				},
				siteId,
			);

			// Re-import with new content
			const files: SkillFileEntry[] = [
				{
					path: "SKILL.md",
					content: `---
name: reactivate-skill
description: New description
---

# Reactivated Skill

This skill has been reactivated with new content.`,
				},
			];

			const result = await importSkillFromFiles(db, siteId, files, {});

			expect(result.ok).toBe(true);
			if (!result.ok) throw new Error("Expected ok: true");

			// Verify the skill was updated
			const skill = db
				.prepare("SELECT * FROM skills WHERE id = ? AND deleted = 0")
				.get(skillId) as any;

			expect(skill.status).toBe("active");
			expect(skill.activation_count).toBe(2);
			expect(skill.content_hash).not.toBe(oldHash);
			expect(skill.description).toBe("New description");
			expect(skill.retired_by).toBeNull();
			expect(skill.retired_reason).toBeNull();
		});
	});

	describe("Validation edge cases", () => {
		it("should reject missing name in frontmatter", async () => {
			const files: SkillFileEntry[] = [
				{
					path: "SKILL.md",
					content: `---
description: Missing name
---

Content`,
				},
			];

			const result = await importSkillFromFiles(db, siteId, files, {});

			expect(result.ok).toBe(false);
			if (result.ok) throw new Error("Expected ok: false");
			expect(result.error).toMatch(/name|missing|required/i);
		});

		it("should reject missing description in frontmatter", async () => {
			const files: SkillFileEntry[] = [
				{
					path: "SKILL.md",
					content: `---
name: missing-description
---

Content`,
				},
			];

			const result = await importSkillFromFiles(db, siteId, files, {});

			expect(result.ok).toBe(false);
			if (result.ok) throw new Error("Expected ok: false");
			expect(result.error).toMatch(/description|missing|required/i);
		});

		it("should reject invalid frontmatter", async () => {
			const files: SkillFileEntry[] = [
				{
					path: "SKILL.md",
					content: "No frontmatter here\n\nJust content",
				},
			];

			const result = await importSkillFromFiles(db, siteId, files, {});

			expect(result.ok).toBe(false);
			if (result.ok) throw new Error("Expected ok: false");
			expect(result.error).toMatch(/frontmatter|invalid|parse/i);
		});

		it("should accept valid hyphenated names", async () => {
			const files: SkillFileEntry[] = [
				{
					path: "SKILL.md",
					content: `---
name: valid-hyphenated-skill-name
description: Valid skill with hyphens
---

Content`,
				},
			];

			const result = await importSkillFromFiles(db, siteId, files, {});

			expect(result.ok).toBe(true);
		});

		it("should accept names with numbers", async () => {
			const files: SkillFileEntry[] = [
				{
					path: "SKILL.md",
					content: `---
name: skill-v2-improved
description: Skill with numbers
---

Content`,
				},
			];

			const result = await importSkillFromFiles(db, siteId, files, {});

			expect(result.ok).toBe(true);
		});
	});

	describe("File persistence", () => {
		it("should create changelog entries for all writes", async () => {
			const files: SkillFileEntry[] = [
				{
					path: "SKILL.md",
					content: `---
name: changelog-skill
description: Test changelog
---

Content`,
				},
				{
					path: "references/test.md",
					content: "Reference content",
				},
			];

			const result = await importSkillFromFiles(db, siteId, files, {});

			expect(result.ok).toBe(true);
			if (!result.ok) throw new Error("Expected ok: true");

			// Verify changelog entries exist
			const changelogCount = db.prepare("SELECT COUNT(*) as count FROM change_log").get() as any;

			expect(changelogCount.count).toBeGreaterThan(0);
		});

		it("should store files with correct metadata", async () => {
			const files: SkillFileEntry[] = [
				{
					path: "SKILL.md",
					content: `---
name: metadata-skill
description: Test metadata
---

Test content for file`,
				},
			];

			const result = await importSkillFromFiles(db, siteId, files, {});

			expect(result.ok).toBe(true);
			if (!result.ok) throw new Error("Expected ok: true");

			const file = db
				.prepare("SELECT * FROM files WHERE id = ? AND deleted = 0")
				.get("skills/metadata-skill/SKILL.md") as any;

			// File should exist with proper metadata
			expect(file).toBeDefined();
		});
	});
});
