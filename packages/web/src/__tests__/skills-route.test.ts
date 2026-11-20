import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { randomUUID } from "node:crypto";
import { applySchema } from "@bound/core";
import type { Skill } from "@bound/shared";
import { createSkillsRoutes } from "../server/routes/skills";

// PATCH /:id clearing allowed_tools to null when an empty string is sent is the
// one behavior createSkillsRoutes owns that the sibling route tests
// (server/routes/__tests__/skills.test.ts, server/__tests__/skills-routes.test.ts)
// do not guard: they only set a non-empty value. The `newAllowedTools || null`
// clear branch in routes/skills.ts lives or dies by this test.
describe("Skills Route — PATCH clears allowed_tools on empty string", () => {
	let db: Database;

	beforeEach(() => {
		db = new Database(":memory:");
		applySchema(db);
		db.prepare("INSERT INTO host_meta (key, value) VALUES (?, ?)").run("site_id", "test-site");
	});

	afterEach(() => {
		db.close();
	});

	it("Clears allowed_tools when empty string is sent", async () => {
		const app = createSkillsRoutes(db);
		const skillId = randomUUID();
		const now = new Date().toISOString();
		db.run(
			`INSERT INTO skills (
				id, name, description, skill_root, content_hash,
				allowed_tools, compatibility, metadata_json, activated_at,
				created_by_thread, activation_count, last_activated_at,
				modified_at, deleted
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			[
				skillId,
				"clear-tools-skill",
				"Original description",
				"skills/clear-tools-skill",
				"originalhash",
				"tool1",
				"compat1",
				null,
				now,
				null,
				1,
				null,
				now,
				0,
			],
		);

		const res = await app.request(`/${skillId}`, {
			method: "PATCH",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ allowed_tools: "" }),
		});

		expect(res.status).toBe(200);
		const data = (await res.json()) as { skill: Skill };
		expect(data.skill.allowed_tools).toBeNull();
	});
});
