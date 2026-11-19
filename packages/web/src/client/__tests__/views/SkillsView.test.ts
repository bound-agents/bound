import { afterAll, beforeEach, describe, expect, it } from "bun:test";
import type { SkillResponse } from "@bound/shared";
import { installDom } from "../harness/dom";

// SkillsView loads skills via the BoundClient (GET /api/skills), renders them
// in a DataTable, expands a row to load + render SKILL.md detail (GET
// /api/skills/:id), and runs the two-step delete (DELETE /api/skills/:id).
// We drive the real component through the shared harness and fake routes.

const dom = installDom({ url: "http://localhost/#/connections/skills" });
afterAll(() => dom.teardown());

function skill(overrides: Partial<SkillResponse> & { id: string; name: string }): SkillResponse {
	return {
		description: `${overrides.name} description`,
		skill_root: `/skills/${overrides.name}`,
		content_hash: "abcdef0123456789",
		allowed_tools: "tool-a, tool-b",
		compatibility: "1.0.0",
		metadata_json: "{}",
		activated_at: "2026-01-01T00:00:00.000Z",
		created_by_thread: "thread-1",
		activation_count: 4,
		last_activated_at: "2026-01-02T00:00:00.000Z",
		modified_at: "2026-01-02T00:00:00.000Z",
		deleted: 0,
		is_builtin: false,
		...overrides,
	};
}

async function mountView() {
	const SkillsView = (await import("../../views/SkillsView.svelte")).default;
	return dom.mount(SkillsView, {});
}

let skills: SkillResponse[];

beforeEach(() => {
	skills = [
		skill({ id: "s1", name: "alpha-skill" }),
		skill({ id: "s2", name: "builtin-skill", is_builtin: true }),
	];
});

describe("SkillsView", () => {
	it("loads skills and renders them in the table", async () => {
		dom.route("GET", "/api/skills", () => skills);
		const { target, unmount } = await mountView();
		await dom.settle();
		expect(dom.requests.some((r) => r.path === "/api/skills")).toBe(true);
		expect(target.textContent).toContain("alpha-skill");
		expect(target.textContent).toContain("builtin-skill");
		expect(target.textContent).toContain("alpha-skill description");
		// Section header is present.
		expect(target.textContent).toContain("Skills");
		unmount();
	});

	it("shows the empty state when there are no skills", async () => {
		dom.route("GET", "/api/skills", () => []);
		const { target, unmount } = await mountView();
		await dom.settle();
		expect(target.textContent).toContain("No skills found.");
		unmount();
	});

	it("expands a row, loads its detail, renders markdown + file list", async () => {
		dom.route("GET", "/api/skills", () => skills);
		dom.route("GET", "/api/skills/s1", () => ({
			skill: skills[0],
			content: "# Alpha\n\nBody text.",
			files: [{ path: "references/a.md", size: 2048 }],
		}));
		const { target, unmount } = await mountView();
		await dom.settle();

		// Click the first data row to expand it.
		const row = target.querySelector("[data-row], tr, .data-row, [role='row']");
		// DataTable rows: find a clickable element containing the skill name.
		const clickable = Array.from(target.querySelectorAll("*")).find(
			(el) => el.textContent?.includes("alpha-skill") && el.children.length > 0,
		);
		const rowEl = (row as Element) ?? (clickable as Element);
		expect(rowEl).not.toBeUndefined();
		// Fire a click on an element inside the row that carries the name.
		const nameCell = Array.from(target.querySelectorAll("*")).find(
			(el) => el.textContent?.trim() === "alpha-skill",
		);
		await dom.fire((nameCell ?? rowEl) as Element, "click");
		await dom.settle();

		expect(dom.requests.some((r) => r.path === "/api/skills/s1")).toBe(true);
		// Detail metadata + rendered markdown + file list appear.
		expect(target.textContent).toContain("tool-a, tool-b");
		expect(target.textContent).toContain("Alpha");
		expect(target.textContent).toContain("references/a.md");
		// 2048 bytes → "2 KB".
		expect(target.textContent).toContain("2 KB");
		unmount();
	});

	it("deletes a skill through the confirm flow and reloads the list", async () => {
		let deleted = false;
		dom.route("GET", "/api/skills", () => (deleted ? [skills[1]] : skills));
		dom.route("GET", "/api/skills/s1", () => ({
			skill: skills[0],
			content: "# Alpha",
			files: [],
		}));
		dom.route("DELETE", "/api/skills/s1", () => {
			deleted = true;
			return null;
		});
		const { target, unmount } = await mountView();
		await dom.settle();

		// Expand the deletable (non-builtin) row.
		const nameCell = Array.from(target.querySelectorAll("*")).find(
			(el) => el.textContent?.trim() === "alpha-skill",
		);
		await dom.fire(nameCell as Element, "click");
		await dom.settle();

		// First Delete button arms the confirm.
		const deleteBtn = Array.from(target.querySelectorAll("button")).find(
			(b) => b.textContent?.trim() === "Delete",
		);
		expect(deleteBtn).not.toBeUndefined();
		await dom.fire(deleteBtn as Element, "click");
		await dom.settle();

		// Confirm Delete now present.
		const confirmBtn = Array.from(target.querySelectorAll("button")).find(
			(b) => b.textContent?.trim() === "Confirm Delete",
		);
		expect(confirmBtn).not.toBeUndefined();
		await dom.fire(confirmBtn as Element, "click");
		await dom.settle();

		expect(dom.requests.some((r) => r.method === "DELETE" && r.path === "/api/skills/s1")).toBe(
			true,
		);
		// List reloaded without the deleted skill.
		expect(deleted).toBe(true);
		expect(target.textContent).not.toContain("alpha-skill");
		unmount();
	});

	it("does not offer a delete control for built-in skills", async () => {
		dom.route("GET", "/api/skills", () => skills);
		dom.route("GET", "/api/skills/s2", () => ({
			skill: skills[1],
			content: "# Builtin",
			files: [],
		}));
		const { target, unmount } = await mountView();
		await dom.settle();

		const nameCell = Array.from(target.querySelectorAll("*")).find(
			(el) => el.textContent?.trim() === "builtin-skill",
		);
		await dom.fire(nameCell as Element, "click");
		await dom.settle();

		// The expanded builtin row has an Edit button but no Delete.
		const buttons = Array.from(target.querySelectorAll("button")).map((b) => b.textContent?.trim());
		expect(buttons).toContain("Edit");
		expect(buttons).not.toContain("Delete");
		unmount();
	});

	it("opens and closes the create-skill modal", async () => {
		dom.route("GET", "/api/skills", () => skills);
		const { target, unmount } = await mountView();
		await dom.settle();
		const createBtn = Array.from(target.querySelectorAll("button")).find(
			(b) => b.textContent?.trim() === "Create Skill",
		);
		expect(createBtn).not.toBeUndefined();
		await dom.fire(createBtn as Element, "click");
		await dom.settle();
		// The create modal mounts — its name/description inputs appear.
		expect(target.querySelector("#skill-name")).not.toBeNull();
		expect(target.querySelector("#skill-desc")).not.toBeNull();
		// Closing it via the modal's cancel/close removes the form.
		const closeBtn = Array.from(target.querySelectorAll("button")).find((b) =>
			["Cancel", "Close", "×"].includes(b.textContent?.trim() ?? ""),
		);
		if (closeBtn) {
			await dom.fire(closeBtn, "click");
			await dom.settle();
			expect(target.querySelector("#skill-name")).toBeNull();
		}
		unmount();
	});

	it("opens the edit-skill modal with the loaded detail content", async () => {
		dom.route("GET", "/api/skills", () => skills);
		dom.route("GET", "/api/skills/s1", () => ({
			skill: skills[0],
			content: "---\ndescription: alpha-skill description\n---\nAlpha body",
			files: [],
		}));
		const { target, unmount } = await mountView();
		await dom.settle();

		// Expand the non-builtin row, then click Edit.
		const nameCell = Array.from(target.querySelectorAll("*")).find(
			(el) => el.textContent?.trim() === "alpha-skill",
		);
		await dom.fire(nameCell as Element, "click");
		await dom.settle();
		const editBtn = Array.from(target.querySelectorAll("button")).find(
			(b) => b.textContent?.trim() === "Edit",
		);
		expect(editBtn).not.toBeUndefined();
		await dom.fire(editBtn as Element, "click");
		await dom.settle();

		// The edit modal mounts — its body textarea (#edit-body) carries the parsed body.
		const body = target.querySelector("#edit-body") as HTMLTextAreaElement | null;
		expect(body).not.toBeNull();
		expect(body?.value).toContain("Alpha body");
		unmount();
	});
});
