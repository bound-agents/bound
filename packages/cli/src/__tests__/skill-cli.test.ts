import { Database } from "bun:sqlite";
import { afterAll, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { applySchema, createDatabase } from "@bound/core";
import {
	skillImport,
	skillList,
	skillRetire,
	skillView,
} from "../commands/skill.js";

describe("boundctl skill commands", () => {
	let tempDir: string;
	let dbPath: string;
	let db: Database;
	let siteId: string;

	beforeEach(() => {
		// Create temp directory for test artifacts
		tempDir = mkdtempSync("skill-cli-test-");
		dbPath = join(tempDir, "bound.db");

		// Create and initialize database
		db = createDatabase(dbPath);
		applySchema(db);

		// Set up site_id in host_meta
		siteId = "test-site-id-12345678";
		db.run("INSERT INTO host_meta (key, value) VALUES (?, ?)", [
			"site_id",
			siteId,
		]);
	});

	afterAll(() => {
		if (db) {
			db.close();
		}
		rmSync(tempDir, { recursive: true, force: true });
	});

	describe("AC4.1: skillList outputs tabular data", () => {
		it("displays skills with NAME, STATUS, ACT, LAST USED, DESCRIPTION columns", () => {
			// Insert a test skill
			db.run(
				`INSERT INTO skills (
				id, name, description, status, skill_root,
				activation_count, last_activated_at, modified_at, deleted
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
				[
					"test-skill-id",
					"test-skill",
					"A test skill for CLI",
					"active",
					"/home/user/skills/test-skill",
					5,
					"2026-03-29T12:00:00Z",
					"2026-03-29T12:00:00Z",
					0,
				],
			);

			// Capture console.log output
			const logOutput: string[] = [];
			const originalLog = console.log;
			spyOn(console, "log").mockImplementation((msg: string) => {
				logOutput.push(msg);
			});

			skillList(db);

			console.log = originalLog;

			// Verify header line contains expected columns
			const headerLine = logOutput.find((line) => line.includes("NAME"));
			expect(headerLine).toBeDefined();
			expect(headerLine).toContain("STATUS");
			expect(headerLine).toContain("ACT");
			expect(headerLine).toContain("LAST USED");
			expect(headerLine).toContain("DESCRIPTION");

			// Verify skill name appears in output
			const skillLine = logOutput.find((line) => line.includes("test-skill"));
			expect(skillLine).toBeDefined();
			expect(skillLine).toContain("active");
		});
	});

	describe("AC4.2: skillView outputs SKILL.md and file listing", () => {
		it("displays SKILL.md content and file listing for a known skill", () => {
			// Insert test skill
			const skillId = "view-test-id";
			db.run(
				`INSERT INTO skills (
				id, name, description, status, skill_root, content_hash,
				activation_count, last_activated_at, modified_at, deleted
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
				[
					skillId,
					"view-test",
					"Test view skill",
					"active",
					"/home/user/skills/view-test",
					"abcd1234",
					1,
					"2026-03-29T10:00:00Z",
					"2026-03-29T10:00:00Z",
					0,
				],
			);

			// Insert SKILL.md file
			const skillMdPath = "/home/user/skills/view-test/SKILL.md";
			const skillMdContent = `---
name: view-test
description: Test view skill
---
# Test Skill

This is a test skill.`;

			db.run(
				`INSERT INTO files (
				id, path, content, is_binary, size_bytes, created_at, modified_at, deleted
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
				[
					skillMdPath,
					skillMdPath,
					skillMdContent,
					0,
					Buffer.byteLength(skillMdContent, "utf-8"),
					"2026-03-29T09:00:00Z",
					"2026-03-29T09:00:00Z",
					0,
				],
			);

			// Insert another file
			const otherFilePath = "/home/user/skills/view-test/helper.ts";
			const otherContent = "export function help() {}";
			db.run(
				`INSERT INTO files (
				id, path, content, is_binary, size_bytes, created_at, modified_at, deleted
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
				[
					otherFilePath,
					otherFilePath,
					otherContent,
					0,
					Buffer.byteLength(otherContent, "utf-8"),
					"2026-03-29T09:00:00Z",
					"2026-03-29T09:00:00Z",
					0,
				],
			);

			// Capture console.log
			const logOutput: string[] = [];
			const originalLog = console.log;
			spyOn(console, "log").mockImplementation((msg: string) => {
				logOutput.push(msg);
			});

			skillView(db, "view-test");

			console.log = originalLog;

			// Verify metadata is displayed
			const metaLine = logOutput.find((line) => line.includes("=== Skill:"));
			expect(metaLine).toBeDefined();

			// Verify SKILL.md section and content
			const skillMdHeader = logOutput.find((line) => line.includes("=== SKILL.md ==="));
			expect(skillMdHeader).toBeDefined();
			const skillMdLineIdx = logOutput.indexOf(skillMdHeader!);
			const content = logOutput.slice(skillMdLineIdx).join("\n");
			expect(content).toContain("Test Skill");

			// Verify file listing
			const filesHeader = logOutput.find((line) => line.includes("=== Files ==="));
			expect(filesHeader).toBeDefined();
			const filesOutput = logOutput.join("\n");
			expect(filesOutput).toContain("helper.ts");
		});
	});

	describe("AC4.3: skillRetire sets status and retired_by", () => {
		it("sets skill status to retired and retired_by to operator", () => {
			// Insert a skill
			const skillId = "retire-test-id";
			db.run(
				`INSERT INTO skills (
				id, name, description, status, skill_root,
				modified_at, deleted
			) VALUES (?, ?, ?, ?, ?, ?, ?)`,
				[
					skillId,
					"retire-test",
					"Test retire skill",
					"active",
					"/home/user/skills/retire-test",
					"2026-03-29T09:00:00Z",
					0,
				],
			);

			// Call skillRetire
			const logOutput: string[] = [];
			const originalLog = console.log;
			spyOn(console, "log").mockImplementation((msg: string) => {
				logOutput.push(msg);
			});

			skillRetire(db, siteId, "retire-test");

			console.log = originalLog;

			// Verify skill was updated
			const skill = db
				.query("SELECT status, retired_by FROM skills WHERE name = ?")
				.get("retire-test") as { status: string; retired_by: string | null };

			expect(skill.status).toBe("retired");
			expect(skill.retired_by).toBe("operator");

			// Verify change_log entry was created
			const changeLog = db
				.query("SELECT COUNT(*) as count FROM change_log WHERE table_name = 'skills'")
				.get() as { count: number };
			expect(changeLog.count).toBeGreaterThan(0);
		});
	});

	describe("AC4.4: skillRetire persists retirement reason", () => {
		it("stores the reason when provided", () => {
			// Insert a skill
			const skillId = "retire-reason-test-id";
			db.run(
				`INSERT INTO skills (
				id, name, description, status, skill_root,
				modified_at, deleted
			) VALUES (?, ?, ?, ?, ?, ?, ?)`,
				[
					skillId,
					"retire-reason-test",
					"Test retire reason skill",
					"active",
					"/home/user/skills/retire-reason-test",
					"2026-03-29T09:00:00Z",
					0,
				],
			);

			// Mock console to suppress output
			const originalLog = console.log;
			const originalWarn = console.warn;
			spyOn(console, "log").mockImplementation(() => {});
			spyOn(console, "warn").mockImplementation(() => {});

			skillRetire(db, siteId, "retire-reason-test", "Too noisy");

			console.log = originalLog;
			console.warn = originalWarn;

			// Verify reason was stored
			const skill = db
				.query("SELECT retired_reason FROM skills WHERE name = ?")
				.get("retire-reason-test") as { retired_reason: string | null };

			expect(skill.retired_reason).toBe("Too noisy");
		});
	});

	describe("AC4.5: skillImport writes files and creates skill row", () => {
		it("imports a skill from a local directory", () => {
			// Create a temporary skill directory
			const skillDir = mkdtempSync(join(tempDir, "skill-source-"));
			const skillMdPath = join(skillDir, "SKILL.md");
			const helperPath = join(skillDir, "helper.ts");

			const skillMdContent = `---
name: imported-skill
description: An imported test skill
allowed_tools: tool1,tool2
compatibility: "1.0"
---
# Imported Skill

This skill was imported.`;

			writeFileSync(skillMdPath, skillMdContent);
			writeFileSync(helperPath, "export function helper() {}");

			// Mock console to suppress output
			spyOn(console, "log").mockImplementation(() => {});

			// Call skillImport
			skillImport(db, siteId, skillDir);

			// Verify files table has entries
			const files = db
				.query(
					"SELECT path FROM files WHERE path LIKE ? AND deleted = 0 ORDER BY path",
				)
				.all("/home/user/skills/imported-skill/%") as Array<{ path: string }>;

			expect(files.length).toBeGreaterThan(0);
			const skillMdFile = files.find((f) => f.path.endsWith("SKILL.md"));
			expect(skillMdFile).toBeDefined();

			// Verify skills table has entry
			const skill = db
				.query("SELECT name, description, status FROM skills WHERE name = ?")
				.get("imported-skill") as {
				name: string;
				description: string;
				status: string;
			} | null;

			expect(skill).not.toBeNull();
			expect(skill?.description).toBe("An imported test skill");
			expect(skill?.status).toBe("active");
		});
	});

	describe("AC4.6: skillImport rejects invalid SKILL.md", () => {
		it("exits with code 1 when SKILL.md has no frontmatter", () => {
			// Create a directory with invalid SKILL.md
			const skillDir = mkdtempSync(join(tempDir, "invalid-skill-"));
			const skillMdPath = join(skillDir, "SKILL.md");

			const invalidContent = "# No Frontmatter\n\nJust plain text.";
			writeFileSync(skillMdPath, invalidContent);

			// Mock process.exit to prevent actual exit
			const exitMock = spyOn(process, "exit").mockImplementation(() => {
				throw new Error("process.exit called");
			});

			// Mock console to suppress error messages
			spyOn(console, "error").mockImplementation(() => {});

			// Call skillImport and expect it to throw
			expect(() => {
				skillImport(db, siteId, skillDir);
			}).toThrow("process.exit called");

			// Verify process.exit was called with code 1
			expect(exitMock).toHaveBeenCalledWith(1);
		});
	});
});
