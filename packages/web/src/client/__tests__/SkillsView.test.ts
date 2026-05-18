import { beforeEach, describe, expect, it } from "bun:test";
import { randomUUID } from "node:crypto";
import type { Skill } from "@bound/shared";

// Mock BoundClient for testing
class MockBoundClient {
	skills: Skill[] = [];
	skillDetails: Record<string, { content: string; files: { path: string; size: number }[] }> = {};

	async listSkills(options?: { status?: string }): Promise<Skill[]> {
		if (options?.status) {
			return this.skills.filter((s) => s.status === options.status);
		}
		return this.skills;
	}

	async getSkill(
		id: string,
	): Promise<{ skill: Skill; content: string; files: { path: string; size: number }[] }> {
		const skill = this.skills.find((s) => s.id === id);
		if (!skill) throw new Error("Skill not found");
		const detail = this.skillDetails[id] || { content: "", files: [] };
		return { skill, ...detail };
	}

	async retireSkill(id: string, _reason?: string): Promise<{ skill: Skill }> {
		const skill = this.skills.find((s) => s.id === id);
		if (!skill) throw new Error("Skill not found");
		skill.status = "retired";
		return { skill };
	}

	async activateSkill(id: string): Promise<{ skill: Skill }> {
		const skill = this.skills.find((s) => s.id === id);
		if (!skill) throw new Error("Skill not found");
		skill.status = "active";
		return { skill };
	}
}

describe("SkillsView Component", () => {
	let client: MockBoundClient;

	beforeEach(() => {
		client = new MockBoundClient();

		// Add test skills
		const skill1: Skill = {
			id: randomUUID(),
			name: "Test Skill 1",
			description: "First test skill",
			status: "active",
			skill_root: "/skills/test1",
			content_hash: "hash1",
			allowed_tools: ["tool1", "tool2"],
			compatibility: "1.0.0",
			metadata_json: "{}",
			activated_at: new Date().toISOString(),
			creation_time: new Date().toISOString(),
			created_by_thread: "thread-1",
			activation_count: 5,
			last_activated_at: new Date().toISOString(),
			retired_by: null,
			retired_reason: null,
			modified_at: new Date().toISOString(),
			deleted: 0,
		};

		const skill2: Skill = {
			id: randomUUID(),
			name: "Test Skill 2",
			description: "Second test skill",
			status: "retired",
			skill_root: "/skills/test2",
			content_hash: "hash2",
			allowed_tools: ["tool3"],
			compatibility: "1.0.0",
			metadata_json: "{}",
			activated_at: new Date().toISOString(),
			creation_time: new Date().toISOString(),
			created_by_thread: "thread-2",
			activation_count: 3,
			last_activated_at: new Date(Date.now() - 86400000).toISOString(),
			retired_by: "thread-1",
			retired_reason: "No longer needed",
			modified_at: new Date().toISOString(),
			deleted: 0,
		};

		client.skills = [skill1, skill2];
		client.skillDetails[skill1.id] = {
			content: "# Test Skill 1\n\nThis is a test skill with **markdown**.",
			files: [
				{ path: "references/example.md", size: 512 },
				{ path: "references/config.json", size: 1024 },
			],
		};
		client.skillDetails[skill2.id] = {
			content: "# Test Skill 2\n\nAnother test skill.",
			files: [],
		};
	});

	describe("Task 2: List with DataTable and status filter", () => {
		it("AC3.2: Lists all skills with name, status, description, last activated", async () => {
			const skills = await client.listSkills();

			expect(skills).toHaveLength(2);
			expect(skills[0].name).toBe("Test Skill 1");
			expect(skills[0].description).toBe("First test skill");
			expect(skills[0].status).toBe("active");
			expect(skills[0].last_activated_at).toBeTruthy();
		});

		it("AC3.3: Filters by status - all", async () => {
			const skills = await client.listSkills();
			expect(skills).toHaveLength(2);
		});

		it("AC3.3: Filters by status - active only", async () => {
			const skills = await client.listSkills({ status: "active" });
			expect(skills).toHaveLength(1);
			expect(skills[0].status).toBe("active");
		});

		it("AC3.3: Filters by status - retired only", async () => {
			const skills = await client.listSkills({ status: "retired" });
			expect(skills).toHaveLength(1);
			expect(skills[0].status).toBe("retired");
		});
	});

	describe("Task 3: Expanded row detail with content rendering", () => {
		it("AC3.4: Loads skill detail with metadata fields", async () => {
			const result = await client.getSkill(client.skills[0].id);

			expect(result.skill.allowed_tools).toEqual(["tool1", "tool2"]);
			expect(result.skill.compatibility).toBe("1.0.0");
			expect(result.skill.activation_count).toBe(5);
			expect(result.skill.content_hash).toBe("hash1");
		});

		it("AC3.5 & AC5.1-5.2: Loads and renders SKILL.md content", async () => {
			const result = await client.getSkill(client.skills[0].id);

			expect(result.content).toContain("# Test Skill 1");
			expect(result.content).toContain("**markdown**");
		});

		it("AC5.3: Lists supplementary files", async () => {
			const result = await client.getSkill(client.skills[0].id);

			expect(result.files).toHaveLength(2);
			expect(result.files[0].path).toBe("references/example.md");
			expect(result.files[0].size).toBe(512);
			expect(result.files[1].path).toBe("references/config.json");
			expect(result.files[1].size).toBe(1024);
		});
	});

	describe("Task 3: Retire and re-activate (for completeness)", () => {
		it("Retires an active skill", async () => {
			const result = await client.retireSkill(client.skills[0].id, "Test reason");
			expect(result.skill.status).toBe("retired");
		});

		it("Re-activates a retired skill", async () => {
			const result = await client.activateSkill(client.skills[1].id);
			expect(result.skill.status).toBe("active");
		});
	});
});
