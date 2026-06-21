import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { applySchema, insertRow } from "@bound/core";
import type { ToolContext } from "../../types";
import { createSkillTool } from "../skill";
import {
	SKILL_PIN_STALENESS_NOTE,
	collectThreadPinnedSkills,
	importSkillFromFiles,
	observeThreadActivatedSkills,
	renderPinnedSkillsBlock,
} from "../skill-utils";

const siteId = "test-site";

/** Insert a `skill` tool_call message into the thread log. */
function insertSkillToolCall(
	db: Database,
	threadId: string,
	action: string,
	name: string,
	createdAt: string,
): void {
	insertRow(
		db,
		"messages",
		{
			id: `msg-${threadId}-${createdAt}-${name}-${action}`,
			thread_id: threadId,
			role: "tool_call",
			content: JSON.stringify([
				{ type: "thinking", thinking: "..." },
				{ type: "tool_use", id: `tu-${createdAt}-${name}`, name: "skill", input: { action, name } },
			]),
			created_at: createdAt,
			host_origin: "test-host",
			deleted: 0,
		},
		siteId,
	);
}

/** Import an active skill with a SKILL.md body via the shared importer. */
async function importSkill(db: Database, name: string, body: string): Promise<void> {
	const result = await importSkillFromFiles(
		db,
		siteId,
		[
			{
				path: "SKILL.md",
				content: `---\nname: ${name}\ndescription: ${name} description\n---\n\n# ${name}\n\n${body}\n`,
			},
		],
		{},
	);
	if (!result.ok) throw new Error(`importSkill failed: ${result.error}`);
}

describe("skill pinning helpers (issue #173)", () => {
	let db: Database;
	const threadId = "thread-pin-1";

	beforeEach(() => {
		db = new Database(":memory:");
		applySchema(db);
	});

	afterEach(() => {
		db.close();
	});

	describe("observeThreadActivatedSkills", () => {
		it("returns skills activated and not deactivated, in first-activation order", () => {
			insertSkillToolCall(db, threadId, "activate", "alpha", "2026-01-01T00:00:00.000Z");
			insertSkillToolCall(db, threadId, "activate", "beta", "2026-01-01T00:01:00.000Z");
			expect(observeThreadActivatedSkills(db, threadId)).toEqual(["alpha", "beta"]);
		});

		it("drops a skill once deactivated (last action wins)", () => {
			insertSkillToolCall(db, threadId, "activate", "alpha", "2026-01-01T00:00:00.000Z");
			insertSkillToolCall(db, threadId, "activate", "beta", "2026-01-01T00:01:00.000Z");
			insertSkillToolCall(db, threadId, "deactivate", "alpha", "2026-01-01T00:02:00.000Z");
			expect(observeThreadActivatedSkills(db, threadId)).toEqual(["beta"]);
		});

		it("re-activation after deactivation restores the skill", () => {
			insertSkillToolCall(db, threadId, "activate", "alpha", "2026-01-01T00:00:00.000Z");
			insertSkillToolCall(db, threadId, "deactivate", "alpha", "2026-01-01T00:01:00.000Z");
			insertSkillToolCall(db, threadId, "activate", "alpha", "2026-01-01T00:02:00.000Z");
			expect(observeThreadActivatedSkills(db, threadId)).toEqual(["alpha"]);
		});

		it("ignores non-skill tool calls and other threads", () => {
			insertRow(
				db,
				"messages",
				{
					id: "msg-other-tool",
					thread_id: threadId,
					role: "tool_call",
					content: JSON.stringify([
						{
							type: "tool_use",
							id: "x",
							name: "memory",
							input: { action: "activate", name: "nope" },
						},
					]),
					created_at: "2026-01-01T00:00:00.000Z",
					host_origin: "test-host",
					deleted: 0,
				},
				siteId,
			);
			insertSkillToolCall(db, "other-thread", "activate", "alpha", "2026-01-01T00:01:00.000Z");
			expect(observeThreadActivatedSkills(db, threadId)).toEqual([]);
		});
	});

	describe("collectThreadPinnedSkills", () => {
		it("resolves activated skills to their SKILL.md bodies", async () => {
			await importSkill(db, "alpha", "Alpha body content.");
			insertSkillToolCall(db, threadId, "activate", "alpha", "2026-01-01T00:00:00.000Z");

			const result = collectThreadPinnedSkills(db, threadId);
			expect(result.pinnedNames).toEqual(["alpha"]);
			expect(result.block).toContain('<skill name="alpha"');
			expect(result.block).toContain("Alpha body content.");
			expect(result.block).toContain(SKILL_PIN_STALENESS_NOTE);
			expect(result.fingerprint).not.toBe("");
		});

		it("drops a skill that was activated then retired (status filter)", async () => {
			await importSkill(db, "alpha", "Alpha body.");
			insertSkillToolCall(db, threadId, "activate", "alpha", "2026-01-01T00:00:00.000Z");
			// Retire it globally.
			db.prepare("UPDATE skills SET status = 'retired' WHERE name = 'alpha'").run();

			const result = collectThreadPinnedSkills(db, threadId);
			expect(result.pinnedNames).toEqual([]);
			expect(result.block).toBe("");
			expect(result.fingerprint).toBe("");
		});

		it("excludes the task-referenced skill to avoid duplication", async () => {
			await importSkill(db, "alpha", "Alpha body.");
			await importSkill(db, "beta", "Beta body.");
			insertSkillToolCall(db, threadId, "activate", "alpha", "2026-01-01T00:00:00.000Z");
			insertSkillToolCall(db, threadId, "activate", "beta", "2026-01-01T00:01:00.000Z");

			const result = collectThreadPinnedSkills(db, threadId, "alpha");
			expect(result.pinnedNames).toEqual(["beta"]);
			expect(result.block).not.toContain("Alpha body.");
			expect(result.block).toContain("Beta body.");
		});

		it("fingerprint is stable for the same set but shifts when the set changes", async () => {
			await importSkill(db, "alpha", "Alpha body.");
			await importSkill(db, "beta", "Beta body.");
			insertSkillToolCall(db, threadId, "activate", "alpha", "2026-01-01T00:00:00.000Z");
			const fp1 = collectThreadPinnedSkills(db, threadId).fingerprint;
			const fp1Again = collectThreadPinnedSkills(db, threadId).fingerprint;
			expect(fp1Again).toBe(fp1);

			// Deactivating shrinks the set -> fingerprint must shift (this is the
			// signal that lets the drift detector classify a deactivate as benign
			// collect drift rather than a spurious compose leak).
			insertSkillToolCall(db, threadId, "activate", "beta", "2026-01-01T00:01:00.000Z");
			insertSkillToolCall(db, threadId, "deactivate", "beta", "2026-01-01T00:02:00.000Z");
			const fp2 = collectThreadPinnedSkills(db, threadId).fingerprint;
			expect(fp2).toBe(fp1); // back to {alpha}

			insertSkillToolCall(db, threadId, "deactivate", "alpha", "2026-01-01T00:03:00.000Z");
			const fp3 = collectThreadPinnedSkills(db, threadId).fingerprint;
			expect(fp3).toBe(""); // empty set
		});
	});

	describe("renderPinnedSkillsBlock", () => {
		it("returns empty string for no skills", () => {
			expect(renderPinnedSkillsBlock([])).toBe("");
		});

		it("wraps each body in a skill node with name and mtime", () => {
			const block = renderPinnedSkillsBlock([
				{ name: "alpha", body: "A body", mtime: "2026-01-01T00:00:00.000Z" },
			]);
			expect(block).toContain('<pinned-skills note="');
			expect(block).toContain('<skill name="alpha" mtime="2026-01-01T00:00:00.000Z">');
			expect(block).toContain("A body");
			expect(block).toContain("</pinned-skills>");
		});
	});
});

describe("skill tool deactivate action (issue #173)", () => {
	let db: Database;
	let toolContext: ToolContext;

	beforeEach(() => {
		db = new Database(":memory:");
		applySchema(db);
		toolContext = {
			db,
			siteId,
			eventBus: { on: () => {}, off: () => {}, emit: () => {}, once: () => {} } as any,
			logger: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
		} as unknown as ToolContext;
	});

	afterEach(() => {
		db.close();
	});

	function getExecute(tool: ReturnType<typeof createSkillTool>) {
		const execute = tool.execute;
		if (!execute) throw new Error("Tool execute is required");
		return execute;
	}

	it("requires a name", async () => {
		const result = await getExecute(createSkillTool(toolContext))({ action: "deactivate" });
		expect(result).toMatch(/name.*required/i);
	});

	it("reports when the skill does not exist", async () => {
		const result = await getExecute(createSkillTool(toolContext))({
			action: "deactivate",
			name: "ghost-skill",
		});
		expect(result).toMatch(/not found/i);
	});

	it("confirms deactivation for an existing skill without mutating its status", async () => {
		await importSkill(db, "alpha", "Alpha body.");
		const result = await getExecute(createSkillTool(toolContext))({
			action: "deactivate",
			name: "alpha",
		});
		expect(result).toMatch(/deactivated for this thread/i);
		// Global status untouched — deactivate is a per-thread, log-derived concern.
		const row = db.prepare("SELECT status FROM skills WHERE name = 'alpha'").get() as {
			status: string;
		};
		expect(row.status).toBe("active");
	});
});
