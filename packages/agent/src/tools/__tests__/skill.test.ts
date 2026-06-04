import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { applySchema, insertRow } from "@bound/core";
import { hydrateWorkspace } from "@bound/sandbox";
import { BOUND_NAMESPACE, deterministicUUID } from "@bound/shared";
import { InMemoryFs, MountableFs } from "just-bash";
import type { ToolContext } from "../../types";
import { createSkillTool } from "../skill";
import { importSkillFromFiles } from "../skill-utils";

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

		it("should re-activate an existing skill whose files live in the files table at a non-/home/user skill_root (canonical store, not VFS)", async () => {
			// Reproduces the production bug: skills imported with the documented
			// default skill_root `skills/<name>` (not `/home/user/skills/<name>`)
			// could not be re-activated, because handleActivate hardcoded the VFS
			// prefix `/home/user/skills/<name>/` and found zero files.
			const now = new Date().toISOString();
			const skillName = "reactivate-from-files";
			const skillRoot = `skills/${skillName}`; // NOT /home/user/skills/...
			const skillMd = `---
name: ${skillName}
description: Reactivated from the canonical files table
---

# Reactivate From Files

Body content.
`;

			insertRow(
				db,
				"skills",
				{
					// MUST be the deterministic UUID, because importSkillFromFiles
					// looks up the existing skill by deterministicUUID(name), not by
					// name — production rows are keyed this way.
					id: deterministicUUID(BOUND_NAMESPACE, skillName),
					name: skillName,
					description: "stale description",
					status: "retired",
					skill_root: skillRoot,
					content_hash: "stalehash",
					allowed_tools: null,
					compatibility: null,
					metadata_json: "{}",
					activated_at: now,
					created_by_thread: null,
					activation_count: 2,
					last_activated_at: now,
					retired_by: "test",
					retired_reason: "manually retired",
					modified_at: now,
				},
				siteId,
			);

			// SKILL.md lives in the files table at skill_root — the canonical store.
			// Deliberately NOT written into the VFS (fs), to prove re-activation
			// reads from the files table, not the VFS.
			insertRow(
				db,
				"files",
				{
					id: `${skillRoot}/SKILL.md`,
					path: `${skillRoot}/SKILL.md`,
					content: skillMd,
					is_binary: 0,
					size_bytes: Buffer.byteLength(skillMd, "utf8"),
					created_at: now,
					modified_at: now,
					created_by: null,
					host_origin: null,
				},
				siteId,
			);

			const tool = createSkillTool(toolContext);
			const result = await getExecute(tool)({
				action: "activate",
				name: skillName,
			});

			expect(result).toMatch(/activated successfully/i);

			const skill = db
				.prepare(
					"SELECT status, skill_root, description FROM skills WHERE name = ? AND deleted = 0",
				)
				.get(skillName) as { status: string; skill_root: string; description: string };
			expect(skill.status).toBe("active");
			// skill_root must be preserved, not clobbered to /home/user/skills/<name>
			expect(skill.skill_root).toBe(skillRoot);
			// content was re-read from the files table and refreshed
			expect(skill.description).toBe("Reactivated from the canonical files table");
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

	describe("web UI skill → skill activate tool (integration)", () => {
		it("should activate a skill created via the web UI after VFS hydration", async () => {
			// Step 1: Simulate web UI creating a skill.
			// The web route calls importSkillFromFiles(), which stores files in the
			// DB at "skills/{name}/SKILL.md" (relative path, no /home/user prefix).
			const skillName = "web-ui-skill";
			const skillMdContent = `---
name: ${skillName}
description: A skill created via the web UI
compatibility: 1.0.0
---

# Web UI Skill

This skill was created via the web UI.
`;
			const webImportResult = await importSkillFromFiles(
				db,
				siteId,
				[{ path: "SKILL.md", content: skillMdContent }],
				{},
			);
			expect(webImportResult.ok).toBe(true); // Web UI creation must succeed

			// Verify where the file was stored in DB
			const dbFile = db
				.prepare("SELECT path FROM files WHERE path LIKE ? AND deleted = 0")
				.get(`%${skillName}%`) as { path: string } | null;
			expect(dbFile).not.toBeNull();
			expect(dbFile?.path).toBe(`/home/user/skills/${skillName}/SKILL.md`);

			// Step 2: Hydrate a fresh VFS from the DB, as the production startup does.
			const baseFs = new InMemoryFs();
			const vfs = new MountableFs({ base: baseFs });
			const homeUserFs = new InMemoryFs();
			vfs.mount("/home/user", homeUserFs);
			await hydrateWorkspace(vfs, db);

			// Step 3: Call "skill activate" with this hydrated VFS.
			// importSkillFromFiles now stores at "/home/user/skills/{name}/", so hydration
			// writes the file to the same path the tool searches.
			const webToolContext: ToolContext = {
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
				fs: vfs,
			};

			const tool = createSkillTool(webToolContext);
			const activateResult = await getExecute(tool)({
				action: "activate",
				name: skillName,
			});

			expect(typeof activateResult).toBe("string");
			expect(activateResult).toMatch(/activated successfully/i);
		});
	});
});
