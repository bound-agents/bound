import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { randomBytes, randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applySchema, createDatabase } from "@bound/core";
import type { Skill } from "@bound/shared";
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
});
