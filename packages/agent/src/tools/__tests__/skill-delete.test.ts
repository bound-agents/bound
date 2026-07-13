import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { applySchema, insertRow } from "@bound/core";
import { BOUND_NAMESPACE, deterministicUUID } from "@bound/shared";
import type { SkillFileEntry } from "@bound/shared";
import { deleteSkill, importSkillFromFiles } from "../skill-utils";

const SITE_ID = "test-site-delete";

/** Seed a skill row (deterministic UUID from name) plus a SKILL.md file under skill_root. */
function seedSkill(
	db: Database,
	name: string,
	opts: { skillRoot?: string; extraFiles?: string[] } = {},
): string {
	const id = deterministicUUID(BOUND_NAMESPACE, name);
	const skillRoot = opts.skillRoot ?? `/home/user/skills/${name}`;
	const now = new Date().toISOString();
	insertRow(
		db,
		"skills",
		{
			id,
			name,
			description: `Desc for ${name}`,
			skill_root: skillRoot,
			content_hash: "hash",
			allowed_tools: null,
			compatibility: null,
			metadata_json: null,
			activated_at: now,
			created_by_thread: null,
			activation_count: 1,
			last_activated_at: now,
			modified_at: now,
			deleted: 0,
		},
		SITE_ID,
	);
	const files = [
		`${skillRoot}/SKILL.md`,
		...(opts.extraFiles ?? []).map((f) => `${skillRoot}/${f}`),
	];
	for (const path of files) {
		insertRow(
			db,
			"files",
			{
				id: path,
				path,
				content: "content",
				is_binary: 0,
				size_bytes: 7,
				created_at: now,
				modified_at: now,
				deleted: 0,
				created_by: null,
				host_origin: null,
			},
			SITE_ID,
		);
	}
	return id;
}

describe("deleteSkill", () => {
	let db: Database;

	beforeEach(() => {
		db = new Database(":memory:");
		applySchema(db);
	});

	afterEach(() => {
		db.close();
	});

	it("soft-deletes an active skill and its files", () => {
		const id = seedSkill(db, "active-skill", { extraFiles: ["references/guide.md"] });

		const result = deleteSkill(db, SITE_ID, "active-skill", { by: "operator" });

		expect(result.ok).toBe(true);
		expect(result.filesDeleted).toBe(2);

		const skill = db.query("SELECT deleted FROM skills WHERE id = ?").get(id) as {
			deleted: number;
		};
		expect(skill.deleted).toBe(1);

		const activeFiles = db
			.query("SELECT COUNT(*) as c FROM files WHERE path LIKE ? AND deleted = 0")
			.get("/home/user/skills/active-skill/%") as { c: number };
		expect(activeFiles.c).toBe(0);
	});

	it("returns ok:false for a non-existent skill", () => {
		const result = deleteSkill(db, SITE_ID, "no-such-skill", { by: "operator" });
		expect(result.ok).toBe(false);
		expect(result.error).toMatch(/not found/i);
	});

	it("creates one advisory per active task referencing the deleted skill", () => {
		seedSkill(db, "referenced-skill");

		const now = new Date().toISOString();
		insertRow(
			db,
			"tasks",
			{
				id: "task-ref-1",
				type: "cron",
				status: "pending",
				trigger_spec: "0 * * * *",
				payload: JSON.stringify({ skill: "referenced-skill" }),
				thread_id: "thread-x",
				origin_thread_id: null,
				claimed_by: null,
				claimed_at: null,
				lease_id: null,
				next_run_at: null,
				last_run_at: null,
				run_count: 0,
				max_runs: null,
				requires: null,
				model_hint: null,
				no_history: 0,
				inject_mode: "results",
				depends_on: null,
				require_success: 0,
				alert_threshold: 3,
				consecutive_failures: 0,
				event_depth: 0,
				no_quiescence: 0,
				system_prompt_addition: null,
				heartbeat_at: null,
				result: null,
				error: null,
				created_at: now,
				created_by: null,
				modified_at: now,
				deleted: 0,
			},
			SITE_ID,
		);

		const result = deleteSkill(db, SITE_ID, "referenced-skill", { by: "operator" });

		expect(result.ok).toBe(true);
		expect(result.advisoryCount).toBe(1);

		const advisory = db.query("SELECT title, detail FROM advisories WHERE deleted = 0").get() as {
			title: string;
			detail: string;
		};
		expect(advisory.title).toMatch(/referenced-skill/);
		expect(advisory.detail).toMatch(/task-ref-1/);
	});

	it("allows re-importing a skill after it was deleted (tombstone does not block)", async () => {
		seedSkill(db, "reimport-skill");
		const delResult = deleteSkill(db, SITE_ID, "reimport-skill", { by: "operator" });
		expect(delResult.ok).toBe(true);

		const files: SkillFileEntry[] = [
			{
				path: "SKILL.md",
				content: `---
name: reimport-skill
description: Freshly re-imported
---

# Reimport`,
			},
		];
		const result = await importSkillFromFiles(db, SITE_ID, files, {});

		expect(result.ok).toBe(true);
		if (!result.ok) throw new Error("expected ok");

		const skill = db
			.query("SELECT deleted, description FROM skills WHERE id = ?")
			.get(deterministicUUID(BOUND_NAMESPACE, "reimport-skill")) as {
			deleted: number;
			description: string;
		};
		expect(skill.deleted).toBe(0);
		expect(skill.description).toBe("Freshly re-imported");
	});
});
