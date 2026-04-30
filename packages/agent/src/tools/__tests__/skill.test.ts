import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { applySchema, insertRow } from "@bound/core";
import { InMemoryFs } from "just-bash";
import type { ToolContext } from "../../types";
import { createSkillTool } from "../skill";

function getExecute(tool: ReturnType<typeof createSkillTool>) {
	const execute = tool.execute;
	if (!execute) throw new Error("Tool execute is required");
	return execute;
}

describe("Native Skill Tool", () => {
	let db: Database;
	const siteId = "test-site";
	let toolContext: ToolContext;
	let fs: InMemoryFs;

	beforeEach(() => {
		db = new Database(":memory:");
		applySchema(db);
		fs = new InMemoryFs();

		toolContext = {
			db,
			siteId,
			eventBus: {
				on: () => {},
				off: () => {},
				emit: () => {},
				once: () => {},
			} as any,
			logger: {
				debug: () => {},
				info: () => {},
				warn: () => {},
				error: () => {},
			},
			fs,
		};
	});

	afterEach(() => {
		db.close();
	});

	describe("activate action", () => {
		it("should activate a valid skill and create skill row (AC3.4)", async () => {
			// Setup: Create valid SKILL.md in VFS
			const skillName = "test-skill";
			const skillRoot = `/home/user/skills/${skillName}`;
			const skillMdPath = `${skillRoot}/SKILL.md`;
			const skillContent = `---
name: test-skill
description: A test skill
compatibility: 1.0.0
---

# Test Skill

This is a test skill for unit testing.
`;

			await fs.writeFile(skillMdPath, skillContent);

			const tool = createSkillTool(toolContext);
			const result = await getExecute(tool)({
				action: "activate",
				name: skillName,
			});

			// Verify success
			expect(typeof result).toBe("string");
			expect(result).toMatch(/activated successfully/i);

			// Verify skill row exists in DB
			const skill = db
				.prepare("SELECT id, name, status, description FROM skills WHERE name = ? AND deleted = 0")
				.get(skillName) as any;
			expect(skill).not.toBeNull();
			expect(skill.name).toBe(skillName);
			expect(skill.status).toBe("active");
			expect(skill.description).toBe("A test skill");
		});

		it("should require 'name' parameter and return error when missing", async () => {
			const tool = createSkillTool(toolContext);
			const result = await getExecute(tool)({
				action: "activate",
			});

			expect(typeof result).toBe("string");
			expect(result).toMatch(/Error/i);
			expect(result).toMatch(/name/i);
		});

		it("should require ctx.fs and return error when not available", async () => {
			const toolContextNoFs: ToolContext = {
				db,
				siteId,
				eventBus: { emit: () => {} } as any,
				logger: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
				// fs is undefined
			};

			const tool = createSkillTool(toolContextNoFs);
			const result = await getExecute(tool)({
				action: "activate",
				name: "test-skill",
			});

			expect(typeof result).toBe("string");
			expect(result).toMatch(/Error/i);
			expect(result).toMatch(/filesystem/i);
		});

		it("should reject invalid skill name format", async () => {
			const tool = createSkillTool(toolContext);
			const result = await getExecute(tool)({
				action: "activate",
				name: "Invalid-Skill_Name",
			});

			expect(typeof result).toBe("string");
			expect(result).toMatch(/Error/i);
			expect(result).toMatch(/Invalid skill name/i);
		});

		it("should reject SKILL.md with missing frontmatter", async () => {
			const skillName = "no-frontmatter";
			const skillRoot = `/home/user/skills/${skillName}`;
			const skillMdPath = `${skillRoot}/SKILL.md`;

			await fs.writeFile(skillMdPath, "# No frontmatter\nJust content");

			const tool = createSkillTool(toolContext);
			const result = await getExecute(tool)({
				action: "activate",
				name: skillName,
			});

			expect(typeof result).toBe("string");
			expect(result).toMatch(/Error/i);
			expect(result).toMatch(/frontmatter/i);
		});

		it("should reject SKILL.md with missing description", async () => {
			const skillName = "no-desc";
			const skillRoot = `/home/user/skills/${skillName}`;
			const skillMdPath = `${skillRoot}/SKILL.md`;
			const skillContent = `---
name: no-desc
---

# Skill with no description`;

			await fs.writeFile(skillMdPath, skillContent);

			const tool = createSkillTool(toolContext);
			const result = await getExecute(tool)({
				action: "activate",
				name: skillName,
			});

			expect(typeof result).toBe("string");
			expect(result).toMatch(/Error/i);
			expect(result).toMatch(/description/i);
		});
	});

	describe("list action", () => {
		it("should return list of active skills (AC3.4)", async () => {
			// Setup: Create and activate a skill
			const now = new Date().toISOString();
			insertRow(
				db,
				"skills",
				{
					id: "skill-1",
					name: "skill-one",
					description: "First skill",
					status: "active",
					skill_root: "/home/user/skills/skill-one",
					content_hash: "abc123",
					allowed_tools: null,
					compatibility: null,
					metadata_json: "{}",
					activated_at: now,
					created_by_thread: null,
					activation_count: 1,
					last_activated_at: now,
					retired_by: null,
					retired_reason: null,
					modified_at: now,
					deleted: 0,
				},
				siteId,
			);

			const tool = createSkillTool(toolContext);
			const result = await getExecute(tool)({
				action: "list",
			});

			expect(typeof result).toBe("string");
			expect(result).toMatch(/skill-one/i);
			expect(result).toMatch(/active/i);
		});

		it("should filter by status when provided", async () => {
			// Setup: Create active and retired skills
			const now = new Date().toISOString();
			insertRow(
				db,
				"skills",
				{
					id: "skill-active",
					name: "active-skill",
					description: "Active",
					status: "active",
					skill_root: "/home/user/skills/active",
					content_hash: "abc",
					allowed_tools: null,
					compatibility: null,
					metadata_json: "{}",
					activated_at: now,
					created_by_thread: null,
					activation_count: 1,
					last_activated_at: now,
					retired_by: null,
					retired_reason: null,
					modified_at: now,
					deleted: 0,
				},
				siteId,
			);

			insertRow(
				db,
				"skills",
				{
					id: "skill-retired",
					name: "retired-skill",
					description: "Retired",
					status: "retired",
					skill_root: "/home/user/skills/retired",
					content_hash: "def",
					allowed_tools: null,
					compatibility: null,
					metadata_json: "{}",
					activated_at: now,
					created_by_thread: null,
					activation_count: 1,
					last_activated_at: now,
					retired_by: "test",
					retired_reason: null,
					modified_at: now,
					deleted: 0,
				},
				siteId,
			);

			const tool = createSkillTool(toolContext);
			const result = await getExecute(tool)({
				action: "list",
				status: "active",
			});

			expect(typeof result).toBe("string");
			expect(result).toMatch(/active-skill/i);
			expect(result).not.toMatch(/retired-skill/i);
		});
	});

	describe("read action", () => {
		it("should read skill metadata and content (AC3.4)", async () => {
			// Setup: Create skill and associated file
			const now = new Date().toISOString();
			const skillName = "readable-skill";
			const skillMdPath = `/home/user/skills/${skillName}/SKILL.md`;
			const skillContent = `---
name: readable-skill
description: A readable skill
---

# Readable Skill

Content here.`;

			insertRow(
				db,
				"skills",
				{
					id: "skill-read",
					name: skillName,
					description: "A readable skill",
					status: "active",
					skill_root: `/home/user/skills/${skillName}`,
					content_hash: "abc",
					allowed_tools: null,
					compatibility: null,
					metadata_json: "{}",
					activated_at: now,
					created_by_thread: null,
					activation_count: 1,
					last_activated_at: now,
					retired_by: null,
					retired_reason: null,
					modified_at: now,
					deleted: 0,
				},
				siteId,
			);

			insertRow(
				db,
				"files",
				{
					id: skillMdPath,
					path: skillMdPath,
					content: skillContent,
					is_binary: 0,
					size_bytes: skillContent.length,
					created_at: now,
					modified_at: now,
					deleted: 0,
				},
				siteId,
			);

			const tool = createSkillTool(toolContext);
			const result = await getExecute(tool)({
				action: "read",
				name: skillName,
			});

			expect(typeof result).toBe("string");
			expect(result).toMatch(/readable-skill/i);
			expect(result).toMatch(/active/i);
			expect(result).toMatch(/Content here/);
		});

		it("should return error when skill not found", async () => {
			const tool = createSkillTool(toolContext);
			const result = await getExecute(tool)({
				action: "read",
				name: "nonexistent",
			});

			expect(typeof result).toBe("string");
			expect(result).toMatch(/Error/i);
			expect(result).toMatch(/not found/i);
		});

		it("should require 'name' parameter", async () => {
			const tool = createSkillTool(toolContext);
			const result = await getExecute(tool)({
				action: "read",
			});

			expect(typeof result).toBe("string");
			expect(result).toMatch(/Error/i);
			expect(result).toMatch(/name/i);
		});
	});

	describe("retire action", () => {
		it("should retire a skill and update status (AC3.4)", async () => {
			// Setup: Create active skill
			const now = new Date().toISOString();
			const skillName = "retiring-skill";
			insertRow(
				db,
				"skills",
				{
					id: "skill-retire",
					name: skillName,
					description: "To retire",
					status: "active",
					skill_root: `/home/user/skills/${skillName}`,
					content_hash: "abc",
					allowed_tools: null,
					compatibility: null,
					metadata_json: "{}",
					activated_at: now,
					created_by_thread: null,
					activation_count: 1,
					last_activated_at: now,
					retired_by: null,
					retired_reason: null,
					modified_at: now,
					deleted: 0,
				},
				siteId,
			);

			const tool = createSkillTool(toolContext);
			const result = await getExecute(tool)({
				action: "retire",
				name: skillName,
				reason: "No longer needed",
			});

			expect(typeof result).toBe("string");
			expect(result).toMatch(/retired/i);

			// Verify skill status changed
			const skill = db
				.prepare("SELECT status, retired_reason FROM skills WHERE name = ?")
				.get(skillName) as any;
			expect(skill.status).toBe("retired");
			expect(skill.retired_reason).toBe("No longer needed");
		});

		it("should return error when skill not found", async () => {
			const tool = createSkillTool(toolContext);
			const result = await getExecute(tool)({
				action: "retire",
				name: "nonexistent",
			});

			expect(typeof result).toBe("string");
			expect(result).toMatch(/Error/i);
			expect(result).toMatch(/not found/i);
		});

		it("should require 'name' parameter", async () => {
			const tool = createSkillTool(toolContext);
			const result = await getExecute(tool)({
				action: "retire",
			});

			expect(typeof result).toBe("string");
			expect(result).toMatch(/Error/i);
			expect(result).toMatch(/name/i);
		});
	});

	describe("action validation", () => {
		it("should reject invalid action and list valid ones (AC3.5)", async () => {
			const tool = createSkillTool(toolContext);
			const result = await getExecute(tool)({
				action: "invalid",
			});

			expect(typeof result).toBe("string");
			expect(result).toMatch(/Error/i);
			expect(result).toMatch(/activate/i);
			expect(result).toMatch(/list/i);
			expect(result).toMatch(/read/i);
			expect(result).toMatch(/retire/i);
		});
	});
});
