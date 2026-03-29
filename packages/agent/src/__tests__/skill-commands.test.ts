import type { Database } from "bun:sqlite";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applySchema, createDatabase, insertRow, updateRow } from "@bound/core";
import type { CommandContext } from "@bound/sandbox";
import { BOUND_NAMESPACE, deterministicUUID } from "@bound/shared";
import { TypedEventEmitter } from "@bound/shared";
import { InMemoryFs } from "just-bash";
import { skillActivate } from "../commands/skill-activate";
import { skillList } from "../commands/skill-list";
import { skillRead } from "../commands/skill-read";
import { skillRetire } from "../commands/skill-retire";

describe("skill commands", () => {
	let tmpDir: string;
	let dbPath: string;
	let db: Database;
	let ctx: CommandContext;
	let eventBus: TypedEventEmitter;
	let siteId: string;
	let inMemoryFs: InMemoryFs;

	beforeAll(() => {
		tmpDir = mkdtempSync(join(tmpdir(), "skill-commands-test-"));
		dbPath = join(tmpDir, "test.db");

		db = createDatabase(dbPath);
		applySchema(db);

		siteId = randomUUID();
		eventBus = new TypedEventEmitter();
	});

	afterAll(() => {
		db.close();
		if (tmpDir) {
			rmSync(tmpDir, { recursive: true, force: true });
		}
	});

	beforeEach(() => {
		inMemoryFs = new InMemoryFs();
		ctx = {
			db,
			siteId,
			eventBus,
			logger: {
				info: () => {},
				warn: () => {},
				error: () => {},
			},
			threadId: randomUUID(),
			taskId: randomUUID(),
			fs: inMemoryFs,
		};
	});

	describe("skill-activate command", () => {
		beforeEach(() => {
			// Clear skills table between tests to avoid cap conflicts
			db.run("DELETE FROM skills WHERE deleted = 0");
		});

		it("AC2.1: Success — activates a valid skill and persists to files and skills tables", async () => {
			const skillMdContent = `---
name: pr-review
description: Review pull requests with AI
---

This is a skill for reviewing pull requests.`;
			await inMemoryFs.writeFile(
				"/home/user/skills/pr-review/SKILL.md",
				skillMdContent,
			);

			const result = await skillActivate.handler(
				{ name: "pr-review" },
				ctx,
			);

			expect(result.exitCode).toBe(0);

			const skill = db
				.prepare("SELECT name, status FROM skills WHERE name = ?")
				.get("pr-review") as { name: string; status: string } | null;
			expect(skill).toBeTruthy();
			expect(skill?.status).toBe("active");

			const file = db
				.prepare(
					"SELECT path, content FROM files WHERE path = ? AND deleted = 0",
				)
				.get("/home/user/skills/pr-review/SKILL.md") as {
				path: string;
				content: string;
			} | null;
			expect(file).toBeTruthy();
		});

		it("AC2.2: Success — skill files appear in files table before skills row is upserted", async () => {
			const skillMdContent = `---
name: code-review
description: Review code changes
---

Code review skill.`;
			await inMemoryFs.writeFile(
				"/home/user/skills/code-review/SKILL.md",
				skillMdContent,
			);

			await skillActivate.handler({ name: "code-review" }, ctx);

			const skill = db
				.prepare("SELECT id FROM skills WHERE name = ?")
				.get("code-review");
			const file = db
				.prepare("SELECT id FROM files WHERE path = ?")
				.get("/home/user/skills/code-review/SKILL.md");

			expect(skill).toBeTruthy();
			expect(file).toBeTruthy();
		});

		it("AC2.3: Failure — missing SKILL.md exits non-zero and makes no DB writes", async () => {
			const result = await skillActivate.handler(
				{ name: "missing-skill" },
				ctx,
			);

			expect(result.exitCode).not.toBe(0);

			const skill = db
				.prepare("SELECT id FROM skills WHERE name = ?")
				.get("missing-skill");
			const file = db
				.prepare("SELECT id FROM files WHERE path LIKE ?")
				.get("%missing-skill%");

			expect(skill).toBeNull();
			expect(file).toBeNull();
		});

		it("AC2.4: Failure — name frontmatter field doesn't match directory name", async () => {
			const skillMdContent = `---
name: wrong-name
description: This skill has mismatched name
---

Skill content.`;
			await inMemoryFs.writeFile(
				"/home/user/skills/pr-review-v2/SKILL.md",
				skillMdContent,
			);

			const result = await skillActivate.handler(
				{ name: "pr-review-v2" },
				ctx,
			);

			expect(result.exitCode).not.toBe(0);
			expect(result.stderr).toContain("does not match");
		});

		it("AC2.5: Failure — missing description in frontmatter", async () => {
			const skillMdContent = `---
name: no-desc-skill
---

Skill without description.`;
			await inMemoryFs.writeFile(
				"/home/user/skills/no-desc-skill/SKILL.md",
				skillMdContent,
			);

			const result = await skillActivate.handler(
				{ name: "no-desc-skill" },
				ctx,
			);

			expect(result.exitCode).not.toBe(0);
			expect(result.stderr).toContain("missing required 'description'");
		});

		it("AC2.6: Failure — 20 skills already active, cannot activate 21st", async () => {
			const now = new Date().toISOString();
			for (let i = 0; i < 20; i++) {
				const skillName = `skill-${i}-${randomUUID().slice(0, 8)}`;
				const skillId = deterministicUUID(BOUND_NAMESPACE, skillName);
				insertRow(
					db,
					"skills",
					{
						id: skillId,
						name: skillName,
						description: `Skill ${i}`,
						status: "active",
						skill_root: `/home/user/skills/${skillName}`,
						content_hash: "",
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
			}

			const skillMdContent = `---
name: skill-21
description: 21st skill
---

This should fail.`;
			await inMemoryFs.writeFile(
				"/home/user/skills/skill-21/SKILL.md",
				skillMdContent,
			);

			const result = await skillActivate.handler(
				{ name: "skill-21" },
				ctx,
			);

			expect(result.exitCode).not.toBe(0);
			expect(result.stderr).toContain("Active skill cap reached");
		});

		it("AC2.7: Edge — re-activating a retired skill transitions it back to active", async () => {
			const uniqueName = `retired-skill-${randomUUID().slice(0, 8)}`;
			const skillMdContent = `---
name: ${uniqueName}
description: A skill that was retired and is now reactivated
---

Skill content.`;
			const skillPath = `/home/user/skills/${uniqueName}/SKILL.md`;
			await inMemoryFs.writeFile(skillPath, skillMdContent);

			// First activation
			let result = await skillActivate.handler({ name: uniqueName }, ctx);
			expect(result.exitCode).toBe(0);

			// Manually retire it
			const skillId = deterministicUUID(BOUND_NAMESPACE, uniqueName);
			updateRow(
				db,
				"skills",
				skillId,
				{
					status: "retired",
					retired_by: "test",
					modified_at: new Date().toISOString(),
				},
				siteId,
			);

			// Reactivate with same fs containing the skill
			result = await skillActivate.handler({ name: uniqueName }, ctx);
			expect(result.exitCode).toBe(0);

			// Verify both rows still exist
			const skill = db
				.prepare("SELECT status, activation_count FROM skills WHERE id = ?")
				.get(skillId) as {
				status: string;
				activation_count: number;
			} | null;
			expect(skill).toBeTruthy();
			expect(skill?.status).toBe("active");
			expect(skill?.activation_count).toBe(2);

			const count = db
				.prepare("SELECT COUNT(*) as cnt FROM skills WHERE name = ?")
				.get(uniqueName) as { cnt: number };
			expect(count.cnt).toBe(1);
		});

		it("AC2.8: Edge — skill ID is deterministic UUID, same name always produces same UUID", async () => {
			const uniqueName = `deterministic-skill-${randomUUID().slice(0, 8)}`;
			const skillMdContent = `---
name: ${uniqueName}
description: Test deterministic UUID
---

Skill content.`;
			await inMemoryFs.writeFile(
				`/home/user/skills/${uniqueName}/SKILL.md`,
				skillMdContent,
			);

			// First activation
			let result = await skillActivate.handler({ name: uniqueName }, ctx);
			expect(result.exitCode).toBe(0);

			const skill1 = db
				.prepare("SELECT id FROM skills WHERE name = ?")
				.get(uniqueName) as { id: string } | null;

			const expectedId = deterministicUUID(BOUND_NAMESPACE, uniqueName);
			expect(skill1).toBeTruthy();
			expect(skill1?.id).toBe(expectedId);

			// Second activation of same skill should result in same ID
			result = await skillActivate.handler({ name: uniqueName }, ctx);
			expect(result.exitCode).toBe(0);

			const skill2 = db
				.prepare("SELECT id FROM skills WHERE name = ?")
				.get(uniqueName) as { id: string } | null;
			expect(skill2?.id).toBe(expectedId);

			const count = db
				.prepare("SELECT COUNT(*) as cnt FROM skills WHERE name = ?")
				.get(uniqueName) as { cnt: number };
			expect(count.cnt).toBe(1);
		});
	});

	describe("skill-list command", () => {
		it("AC2.9: Success — outputs required columns: NAME, STATUS, ACTIVATIONS, LAST USED, DESCRIPTION", async () => {
			const now = new Date().toISOString();
			const skillId = randomUUID();

			insertRow(
				db,
				"skills",
				{
					id: skillId,
					name: "test-skill-list-" + randomUUID().slice(0, 8),
					description: "Test skill for listing",
					status: "active",
					skill_root: "/home/user/skills/test-skill",
					content_hash: "abc123",
					allowed_tools: null,
					compatibility: null,
					metadata_json: "{}",
					activated_at: now,
					created_by_thread: null,
					activation_count: 5,
					last_activated_at: now,
					retired_by: null,
					retired_reason: null,
					modified_at: now,
					deleted: 0,
				},
				siteId,
			);

			const result = await skillList.handler({}, ctx);

			expect(result.exitCode).toBe(0);
			expect(result.stdout).toContain("NAME");
			expect(result.stdout).toContain("STATUS");
			expect(result.stdout).toContain("ACTIVATIONS");
			expect(result.stdout).toContain("LAST USED");
			expect(result.stdout).toContain("DESCRIPTION");
		});

		it("AC2.10: Success — skill-list --status retired shows only retired skills", async () => {
			const now = new Date().toISOString();
			const uniqueId = randomUUID().slice(0, 8);

			insertRow(
				db,
				"skills",
				{
					id: randomUUID(),
					name: `active-skill-${uniqueId}`,
					description: "Active skill",
					status: "active",
					skill_root: "/home/user/skills/active-skill",
					content_hash: "hash1",
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
					id: randomUUID(),
					name: `retired-skill-${uniqueId}`,
					description: "Retired skill",
					status: "retired",
					skill_root: "/home/user/skills/retired-skill",
					content_hash: "hash2",
					allowed_tools: null,
					compatibility: null,
					metadata_json: "{}",
					activated_at: now,
					created_by_thread: null,
					activation_count: 2,
					last_activated_at: now,
					retired_by: "agent",
					retired_reason: "No longer needed",
					modified_at: now,
					deleted: 0,
				},
				siteId,
			);

			const result = await skillList.handler({ status: "retired" }, ctx);

			expect(result.exitCode).toBe(0);
			expect(result.stdout).toContain(`retired-skill-${uniqueId}`);
			expect(result.stdout).not.toContain(`active-skill-${uniqueId}`);
		});

		it("AC2.11: Success — skill-list --verbose shows ALLOWED_TOOLS, CONTENT_HASH, COMPATIBILITY, RETIRED_REASON", async () => {
			const now = new Date().toISOString();

			insertRow(
				db,
				"skills",
				{
					id: randomUUID(),
					name: `verbose-skill-${randomUUID().slice(0, 8)}`,
					description: "Test verbose output",
					status: "retired",
					skill_root: "/home/user/skills/verbose-skill",
					content_hash: "hash-abc123",
					allowed_tools: "tool1,tool2",
					compatibility: "v1.0",
					metadata_json: "{}",
					activated_at: now,
					created_by_thread: null,
					activation_count: 1,
					last_activated_at: now,
					retired_by: "agent",
					retired_reason: "Verbose test reason",
					modified_at: now,
					deleted: 0,
				},
				siteId,
			);

			const result = await skillList.handler({ verbose: "" }, ctx);

			expect(result.exitCode).toBe(0);
			expect(result.stdout).toContain("ALLOWED_TOOLS");
			expect(result.stdout).toContain("CONTENT_HASH");
			expect(result.stdout).toContain("RETIRED_REASON");
		});
	});

	describe("skill-read command", () => {
		it("AC2.12: Success — outputs SKILL.md content with status/telemetry header", async () => {
			const now = new Date().toISOString();
			const uniqueName = `test-skill-${randomUUID().slice(0, 8)}`;
			const skillMdContent = `---
name: ${uniqueName}
description: Test skill
---

This is the skill content.`;

			const skillId = randomUUID();

			insertRow(
				db,
				"skills",
				{
					id: skillId,
					name: uniqueName,
					description: "Test skill",
					status: "active",
					skill_root: `/home/user/skills/${uniqueName}`,
					content_hash: "hash-xyz",
					allowed_tools: null,
					compatibility: null,
					metadata_json: "{}",
					activated_at: now,
					created_by_thread: null,
					activation_count: 3,
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
					id: `/home/user/skills/${uniqueName}/SKILL.md`,
					path: `/home/user/skills/${uniqueName}/SKILL.md`,
					content: skillMdContent,
					is_binary: 0,
					size_bytes: skillMdContent.length,
					created_at: now,
					modified_at: now,
					deleted: 0,
				},
				siteId,
			);

			const result = await skillRead.handler(
				{ name: uniqueName },
				ctx,
			);

			expect(result.exitCode).toBe(0);
			expect(result.stdout).toContain(`--- Skill: ${uniqueName} ---`);
			expect(result.stdout).toContain("Status:      active");
			expect(result.stdout).toContain("Activations: 3");
			expect(result.stdout).toContain("Hash:        hash-xyz");
			expect(result.stdout).toContain("This is the skill content.");
		});

		it("AC2.13: Failure — skill-read unknown-skill exits non-zero", async () => {
			const result = await skillRead.handler(
				{ name: `unknown-skill-${randomUUID()}` },
				ctx,
			);

			expect(result.exitCode).not.toBe(0);
			expect(result.stderr).toContain("not found");
		});
	});

	describe("skill-retire command", () => {
		it("AC2.14: Success — skill-retire sets status to retired and retired_by to agent", async () => {
			const now = new Date().toISOString();
			const uniqueName = `retire-test-${randomUUID().slice(0, 8)}`;
			const skillId = deterministicUUID(BOUND_NAMESPACE, uniqueName);

			insertRow(
				db,
				"skills",
				{
					id: skillId,
					name: uniqueName,
					description: "Skill to retire",
					status: "active",
					skill_root: `/home/user/skills/${uniqueName}`,
					content_hash: "hash-retire",
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

			const result = await skillRetire.handler(
				{ name: uniqueName },
				ctx,
			);

			expect(result.exitCode).toBe(0);

			const skill = db
				.prepare("SELECT status, retired_by FROM skills WHERE id = ?")
				.get(skillId) as { status: string; retired_by: string };

			expect(skill.status).toBe("retired");
			expect(skill.retired_by).toBe("agent");
		});

		it("AC2.15: Success — skill-retire persists retired_reason", async () => {
			const now = new Date().toISOString();
			const uniqueName = `reason-test-${randomUUID().slice(0, 8)}`;
			const skillId = deterministicUUID(BOUND_NAMESPACE, uniqueName);

			insertRow(
				db,
				"skills",
				{
					id: skillId,
					name: uniqueName,
					description: "Skill to retire with reason",
					status: "active",
					skill_root: `/home/user/skills/${uniqueName}`,
					content_hash: "hash-reason",
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

			const reason = "Too noisy";
			const result = await skillRetire.handler(
				{ name: uniqueName, reason },
				ctx,
			);

			expect(result.exitCode).toBe(0);

			const skill = db
				.prepare("SELECT retired_reason FROM skills WHERE id = ?")
				.get(skillId) as { retired_reason: string };

			expect(skill.retired_reason).toBe(reason);
		});

		it("AC2.16: Success — skill-retire scans tasks and creates advisories for tasks referencing the skill", async () => {
			const now = new Date().toISOString();
			const uniqueName = `advisory-test-${randomUUID().slice(0, 8)}`;
			const skillId = deterministicUUID(BOUND_NAMESPACE, uniqueName);

			insertRow(
				db,
				"skills",
				{
					id: skillId,
					name: uniqueName,
					description: "Skill for advisory testing",
					status: "active",
					skill_root: `/home/user/skills/${uniqueName}`,
					content_hash: "hash-advisory",
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

			const taskId1 = randomUUID();
			const taskId2 = randomUUID();

			insertRow(
				db,
				"tasks",
				{
					id: taskId1,
					type: "deferred",
					status: "pending",
					trigger_spec: "now",
					thread_id: randomUUID(),
					payload: JSON.stringify({
						skill: uniqueName,
						other: "data",
					}),
					created_at: now,
					created_by: null,
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
					alert_threshold: 1,
					consecutive_failures: 0,
					event_depth: 0,
					no_quiescence: 0,
					heartbeat_at: null,
					result: null,
					error: null,
					modified_at: now,
					deleted: 0,
				},
				siteId,
			);

			insertRow(
				db,
				"tasks",
				{
					id: taskId2,
					type: "deferred",
					status: "pending",
					trigger_spec: "now",
					thread_id: randomUUID(),
					payload: JSON.stringify({
						skill: uniqueName,
						other: "more-data",
					}),
					created_at: now,
					created_by: null,
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
					alert_threshold: 1,
					consecutive_failures: 0,
					event_depth: 0,
					no_quiescence: 0,
					heartbeat_at: null,
					result: null,
					error: null,
					modified_at: now,
					deleted: 0,
				},
				siteId,
			);

			insertRow(
				db,
				"tasks",
				{
					id: randomUUID(),
					type: "deferred",
					status: "pending",
					trigger_spec: "now",
					thread_id: randomUUID(),
					payload: JSON.stringify({
						skill: "different-skill",
						other: "data",
					}),
					created_at: now,
					created_by: null,
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
					alert_threshold: 1,
					consecutive_failures: 0,
					event_depth: 0,
					no_quiescence: 0,
					heartbeat_at: null,
					result: null,
					error: null,
					modified_at: now,
					deleted: 0,
				},
				siteId,
			);

			const result = await skillRetire.handler(
				{ name: uniqueName },
				ctx,
			);

			expect(result.exitCode).toBe(0);
			expect(result.stdout).toContain("2 advisory");

			const advisories = db
				.prepare(
					"SELECT id, title, detail FROM advisories WHERE deleted = 0 ORDER BY proposed_at",
				)
				.all() as Array<{
				id: string;
				title: string;
				detail: string;
			}>;

			const relevantAdvisories = advisories.filter((a) =>
				a.title.includes(uniqueName),
			);
			expect(relevantAdvisories.length).toBe(2);

			for (const advisory of relevantAdvisories) {
				expect(advisory.title).toContain(uniqueName);
				expect(advisory.detail).toContain(uniqueName);
			}
		});
	});
});
