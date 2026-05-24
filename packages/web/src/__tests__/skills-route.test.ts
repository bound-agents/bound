import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { randomBytes, randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applySchema, createDatabase } from "@bound/core";
import type { Skill } from "@bound/shared";
import { zipSync } from "fflate";
import { createSkillsRoutes } from "../server/routes/skills";

describe("Skills Route", () => {
	let dbPath: string;
	let db: Database;
	let siteId: string;

	beforeEach(() => {
		dbPath = join(tmpdir(), `bound-test-${randomBytes(4).toString("hex")}.db`);
		db = createDatabase(dbPath);
		applySchema(db);

		// Set up site_id in host_meta
		siteId = "test-site-123";
		db.run("INSERT INTO host_meta (key, value) VALUES (?, ?)", ["site_id", siteId]);
	});

	afterEach(() => {
		db.close();
		try {
			require("node:fs").unlinkSync(dbPath);
		} catch {
			// ignore
		}
	});

	describe("GET / - List skills", () => {
		it("AC2.1: Returns all non-deleted skills", async () => {
			const app = createSkillsRoutes(db);

			// Insert two skills: one active, one retired
			const skill1Id = randomUUID();
			const skill2Id = randomUUID();

			db.run(
				`INSERT INTO skills (
					id, name, description, status, skill_root, content_hash,
					allowed_tools, compatibility, metadata_json, activated_at,
					created_by_thread, activation_count, last_activated_at,
					retired_by, retired_reason, modified_at, deleted
				) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
				[
					skill1Id,
					"active-skill",
					"An active skill",
					"active",
					"skills/active-skill",
					"hash1",
					null,
					null,
					null,
					new Date().toISOString(),
					null,
					1,
					null,
					null,
					null,
					new Date().toISOString(),
					0,
				],
			);

			db.run(
				`INSERT INTO skills (
					id, name, description, status, skill_root, content_hash,
					allowed_tools, compatibility, metadata_json, activated_at,
					created_by_thread, activation_count, last_activated_at,
					retired_by, retired_reason, modified_at, deleted
				) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
				[
					skill2Id,
					"retired-skill",
					"A retired skill",
					"retired",
					"skills/retired-skill",
					"hash2",
					null,
					null,
					null,
					null,
					null,
					0,
					null,
					"web",
					null,
					new Date().toISOString(),
					0,
				],
			);

			const res = await app.request("/", { method: "GET" });
			expect(res.status).toBe(200);

			const data = (await res.json()) as Skill[];
			expect(Array.isArray(data)).toBe(true);
			expect(data.length).toBe(2);
			expect(data.map((s) => s.name).sort()).toEqual(["active-skill", "retired-skill"]);
		});

		it("AC2.2: Filters by status=active", async () => {
			const app = createSkillsRoutes(db);

			// Insert two skills: one active, one retired
			const skill1Id = randomUUID();
			const skill2Id = randomUUID();

			db.run(
				`INSERT INTO skills (
					id, name, description, status, skill_root, content_hash,
					allowed_tools, compatibility, metadata_json, activated_at,
					created_by_thread, activation_count, last_activated_at,
					retired_by, retired_reason, modified_at, deleted
				) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
				[
					skill1Id,
					"active-skill",
					"An active skill",
					"active",
					"skills/active-skill",
					"hash1",
					null,
					null,
					null,
					new Date().toISOString(),
					null,
					1,
					null,
					null,
					null,
					new Date().toISOString(),
					0,
				],
			);

			db.run(
				`INSERT INTO skills (
					id, name, description, status, skill_root, content_hash,
					allowed_tools, compatibility, metadata_json, activated_at,
					created_by_thread, activation_count, last_activated_at,
					retired_by, retired_reason, modified_at, deleted
				) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
				[
					skill2Id,
					"retired-skill",
					"A retired skill",
					"retired",
					"skills/retired-skill",
					"hash2",
					null,
					null,
					null,
					null,
					null,
					0,
					null,
					"web",
					null,
					new Date().toISOString(),
					0,
				],
			);

			const res = await app.request("/?status=active", { method: "GET" });
			expect(res.status).toBe(200);

			const data = (await res.json()) as Skill[];
			expect(data.length).toBe(1);
			expect(data[0].name).toBe("active-skill");
		});
	});

	describe("GET /:id - Get skill detail", () => {
		it("AC2.3: Returns skill metadata, SKILL.md content, and file list", async () => {
			const app = createSkillsRoutes(db);

			const skillId = randomUUID();

			// Insert skill
			db.run(
				`INSERT INTO skills (
					id, name, description, status, skill_root, content_hash,
					allowed_tools, compatibility, metadata_json, activated_at,
					created_by_thread, activation_count, last_activated_at,
					retired_by, retired_reason, modified_at, deleted
				) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
				[
					skillId,
					"test-skill",
					"A test skill",
					"active",
					"skills/test-skill",
					"hash123",
					null,
					null,
					null,
					new Date().toISOString(),
					null,
					1,
					null,
					null,
					null,
					new Date().toISOString(),
					0,
				],
			);

			// Insert SKILL.md file
			const skillMdContent = `---
name: test-skill
description: A test skill
---
# Test Skill

This is a test skill.`;

			const fileId1 = randomUUID();
			db.run(
				`INSERT INTO files (id, path, size_bytes, content, created_at, modified_at, deleted)
				 VALUES (?, ?, ?, ?, ?, ?, ?)`,
				[
					fileId1,
					"skills/test-skill/SKILL.md",
					skillMdContent.length,
					skillMdContent,
					new Date().toISOString(),
					new Date().toISOString(),
					0,
				],
			);

			// Insert another file
			const otherContent = "console.log('test');";
			const fileId2 = randomUUID();
			db.run(
				`INSERT INTO files (id, path, size_bytes, content, created_at, modified_at, deleted)
				 VALUES (?, ?, ?, ?, ?, ?, ?)`,
				[
					fileId2,
					"skills/test-skill/test.js",
					otherContent.length,
					otherContent,
					new Date().toISOString(),
					new Date().toISOString(),
					0,
				],
			);

			const res = await app.request(`/${skillId}`, { method: "GET" });
			expect(res.status).toBe(200);

			const data = (await res.json()) as {
				skill: Skill;
				content: string;
				files: Array<{ path: string; size: number }>;
			};

			expect(data.skill.id).toBe(skillId);
			expect(data.skill.name).toBe("test-skill");
			expect(data.content).toBe(skillMdContent);
			expect(Array.isArray(data.files)).toBe(true);
			expect(data.files.length).toBe(2);

			// Check relative paths
			const paths = data.files.map((f) => f.path).sort();
			expect(paths).toEqual(["SKILL.md", "test.js"]);
		});

		it("Returns 404 for non-existent skill", async () => {
			const app = createSkillsRoutes(db);
			const fakeId = randomUUID();

			const res = await app.request(`/${fakeId}`, { method: "GET" });
			expect(res.status).toBe(404);

			const data = (await res.json()) as { error: string };
			expect(data.error).toBe("Skill not found");
		});
	});

	describe("POST / - Create skill", () => {
		it("AC2.4: Creates skill from JSON body", async () => {
			const app = createSkillsRoutes(db);

			const body = {
				name: "test-skill",
				description: "A test skill",
				body: "# Test Skill\n\nThis is a test skill.",
			};

			const res = await app.request("/", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(body),
			});

			expect(res.status).toBe(201);

			const data = (await res.json()) as { skill: Skill };
			expect(data.skill.name).toBe("test-skill");
			expect(data.skill.description).toBe("A test skill");

			// Verify in DB
			const dbSkill = db.query("SELECT * FROM skills WHERE name = ?").get("test-skill");
			expect(dbSkill).toBeDefined();
		});

		it("AC2.5: Creates skill from multipart .md file", async () => {
			const app = createSkillsRoutes(db);

			const skillMdContent = `---
name: md-skill
description: From MD file
---
# MD Skill

This is from a file.`;

			const file = new File([skillMdContent], "skill.md", { type: "text/markdown" });
			const formData = new FormData();
			formData.append("skillfile", file);

			const res = await app.request("/", {
				method: "POST",
				body: formData,
			});

			expect(res.status).toBe(201);

			const data = (await res.json()) as { skill: Skill };
			expect(data.skill.name).toBe("md-skill");

			// Verify in DB
			const dbSkill = db.query("SELECT * FROM skills WHERE name = ?").get("md-skill");
			expect(dbSkill).toBeDefined();
		});

		it("AC2.6: Creates skill from multipart .zip file", async () => {
			const app = createSkillsRoutes(db);

			const skillMdContent = `---
name: zip-skill
description: From zip
---
# Zip Skill

This is from a zip.`;

			const zipData = zipSync({
				"SKILL.md": new TextEncoder().encode(skillMdContent),
				"helper.js": new TextEncoder().encode("console.log('test');"),
			});

			const file = new File([zipData], "skill.zip", { type: "application/zip" });
			const formData = new FormData();
			formData.append("skillfile", file);

			const res = await app.request("/", {
				method: "POST",
				body: formData,
			});

			expect(res.status).toBe(201);

			const data = (await res.json()) as { skill: Skill };
			expect(data.skill.name).toBe("zip-skill");

			// Verify in DB
			const dbSkill = db.query("SELECT * FROM skills WHERE name = ?").get("zip-skill");
			expect(dbSkill).toBeDefined();
		});
	});

	describe("POST / - Security tests", () => {
		it("AC4.1: Rejects zip with ../ in path", async () => {
			const app = createSkillsRoutes(db);

			const zipData = zipSync({
				"../etc/passwd": new TextEncoder().encode("malicious"),
				"SKILL.md": new TextEncoder().encode("---\nname: test\n---\nbody"),
			});

			const file = new File([zipData], "skill.zip", { type: "application/zip" });
			const formData = new FormData();
			formData.append("skillfile", file);

			const res = await app.request("/", {
				method: "POST",
				body: formData,
			});

			expect(res.status).toBe(400);

			const data = (await res.json()) as { error: string };
			expect(data.error).toContain("Invalid zip");
		});

		it("AC4.2: Rejects zip with absolute path", async () => {
			const app = createSkillsRoutes(db);

			const zipData = zipSync({
				"/absolute/path.md": new TextEncoder().encode("malicious"),
				"SKILL.md": new TextEncoder().encode("---\nname: test\n---\nbody"),
			});

			const file = new File([zipData], "skill.zip", { type: "application/zip" });
			const formData = new FormData();
			formData.append("skillfile", file);

			const res = await app.request("/", {
				method: "POST",
				body: formData,
			});

			expect(res.status).toBe(400);

			const data = (await res.json()) as { error: string };
			expect(data.error).toContain("Invalid zip");
		});

		it("AC4.3: Rejects zip without SKILL.md", async () => {
			const app = createSkillsRoutes(db);

			const zipData = zipSync({
				"helper.js": new TextEncoder().encode("console.log('test');"),
			});

			const file = new File([zipData], "skill.zip", { type: "application/zip" });
			const formData = new FormData();
			formData.append("skillfile", file);

			const res = await app.request("/", {
				method: "POST",
				body: formData,
			});

			expect(res.status).toBe(400);

			const data = (await res.json()) as { error: string };
			expect(data.error).toContain("SKILL.md");
		});

		it("AC4.4: Rejects zip exceeding 64KB", async () => {
			const app = createSkillsRoutes(db);

			const largeContent = "x".repeat(70 * 1024); // 70KB
			const zipData = zipSync({
				"large.txt": new TextEncoder().encode(largeContent),
				"SKILL.md": new TextEncoder().encode("---\nname: test\n---\nbody"),
			});

			const file = new File([zipData], "skill.zip", { type: "application/zip" });
			const formData = new FormData();
			formData.append("skillfile", file);

			const res = await app.request("/", {
				method: "POST",
				body: formData,
			});

			expect(res.status).toBe(400);

			const data = (await res.json()) as { error: string };
			expect(data.error).toContain("64KB");
		});
	});

	describe("POST /:id/retire - Retire skill", () => {
		it("AC2.7: Retires an active skill", async () => {
			const app = createSkillsRoutes(db);

			const skillId = randomUUID();

			// Insert active skill
			db.run(
				`INSERT INTO skills (
					id, name, description, status, skill_root, content_hash,
					allowed_tools, compatibility, metadata_json, activated_at,
					created_by_thread, activation_count, last_activated_at,
					retired_by, retired_reason, modified_at, deleted
				) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
				[
					skillId,
					"to-retire",
					"A skill to retire",
					"active",
					"skills/to-retire",
					"hash123",
					null,
					null,
					null,
					new Date().toISOString(),
					null,
					1,
					null,
					null,
					null,
					new Date().toISOString(),
					0,
				],
			);

			const res = await app.request(`/${skillId}/retire`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ reason: "No longer needed" }),
			});

			expect(res.status).toBe(200);

			const data = (await res.json()) as { skill: Skill };
			expect(data.skill.status).toBe("retired");
			expect(data.skill.retired_by).toBe("web");
			expect(data.skill.retired_reason).toBe("No longer needed");
		});

		it("AC2.9: Returns 404 for non-existent skill", async () => {
			const app = createSkillsRoutes(db);
			const fakeId = randomUUID();

			const res = await app.request(`/${fakeId}/retire`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({}),
			});

			expect(res.status).toBe(404);

			const data = (await res.json()) as { error: string };
			expect(data.error).toBe("Skill not found");
		});
	});

	describe("POST /:id/activate - Activate skill", () => {
		it("AC2.8: Re-activates a retired skill", async () => {
			const app = createSkillsRoutes(db);

			const skillId = randomUUID();

			// Insert retired skill
			db.run(
				`INSERT INTO skills (
					id, name, description, status, skill_root, content_hash,
					allowed_tools, compatibility, metadata_json, activated_at,
					created_by_thread, activation_count, last_activated_at,
					retired_by, retired_reason, modified_at, deleted
				) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
				[
					skillId,
					"to-activate",
					"A skill to activate",
					"retired",
					"/home/user/skills/to-activate",
					"hash123",
					null,
					null,
					null,
					null,
					null,
					0,
					null,
					"web",
					"testing",
					new Date().toISOString(),
					0,
				],
			);

			// Insert skill files
			const skillMdContent = `---
name: to-activate
description: A skill to activate
---
# Test`;

			const fileId1 = randomUUID();
			db.run(
				`INSERT INTO files (id, path, size_bytes, content, created_at, modified_at, deleted)
				 VALUES (?, ?, ?, ?, ?, ?, ?)`,
				[
					fileId1,
					"/home/user/skills/to-activate/SKILL.md",
					skillMdContent.length,
					skillMdContent,
					new Date().toISOString(),
					new Date().toISOString(),
					0,
				],
			);

			const res = await app.request(`/${skillId}/activate`, {
				method: "POST",
			});

			expect(res.status).toBe(200);

			const data = (await res.json()) as { skill: Skill };
			expect(data.skill.status).toBe("active");
			expect(data.skill.activation_count).toBeGreaterThan(0);
		});

		it("AC2.10: Returns 404 for non-existent skill", async () => {
			const app = createSkillsRoutes(db);
			const fakeId = randomUUID();

			const res = await app.request(`/${fakeId}/activate`, {
				method: "POST",
			});

			expect(res.status).toBe(404);

			const data = (await res.json()) as { error: string };
			expect(data.error).toBe("Skill not found");
		});
	});
});
