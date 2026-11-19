import { afterAll, afterEach, beforeEach, describe, expect, it } from "bun:test";
import { installDom } from "../harness/dom";

// SkillEditModal: a dialog that pre-fills from an existing skill + its raw
// SKILL.md content (frontmatter stripped), validates (description required and
// ≤1024 chars, body required), PATCHes /api/skills/:id via the shared client,
// and reports success/error. These tests drive the real compiled component
// (plus its Btn child) under jsdom and assert the pre-fill, validation gating,
// the exact request sent on save, the error path, and close/escape behavior.

const dom = installDom();
afterAll(() => dom.teardown());

const unmounts: Array<() => void> = [];
afterEach(() => {
	for (const u of unmounts.splice(0)) u();
});

type Skill = {
	id: string;
	name: string;
	description: string;
	skill_root: string;
	content_hash: string | null;
	allowed_tools: string | null;
	compatibility: string | null;
	metadata_json: string | null;
	activated_at: string | null;
	created_by_thread: string | null;
	activation_count: number;
	last_activated_at: string | null;
	modified_at: string;
	deleted: number;
};

function skill(partial: Partial<Skill> = {}): Skill {
	return {
		id: "11111111-2222-3333-4444-555555555555",
		name: "my-skill",
		description: "Does a thing",
		skill_root: "skills/my-skill",
		content_hash: null,
		allowed_tools: null,
		compatibility: null,
		metadata_json: null,
		activated_at: null,
		created_by_thread: null,
		activation_count: 0,
		last_activated_at: null,
		modified_at: "2026-01-01T00:00:00.000Z",
		deleted: 0,
		...partial,
	};
}

let closed: number;
let saved: number;

async function mountModal(props: { skill?: Partial<Skill>; content?: string } = {}) {
	closed = 0;
	saved = 0;
	const SkillEditModal = (await import("../../components/SkillEditModal.svelte")).default;
	const handle = await dom.mount(SkillEditModal, {
		skill: skill(props.skill),
		content: props.content ?? "---\ndescription: Does a thing\n---\nThe skill body.",
		onClose: () => {
			closed++;
		},
		onSaved: () => {
			saved++;
		},
	});
	unmounts.push(handle.unmount);
	await dom.settle();
	return handle;
}

/** The "Save" submit button is the last footer button. */
function saveButton(target: HTMLElement): HTMLButtonElement {
	const buttons = [...target.querySelectorAll(".modal-footer button")] as HTMLButtonElement[];
	const last = buttons[buttons.length - 1];
	if (!last) throw new Error("no footer buttons");
	return last;
}

describe("SkillEditModal", () => {
	beforeEach(() => {
		dom.requests.length = 0;
	});

	it("pre-fills the name badge, description, and body (frontmatter stripped)", async () => {
		const { target } = await mountModal({
			content: "---\ndescription: x\n---\nBody goes here.",
		});
		expect(target.querySelector(".skill-name-badge")?.textContent).toContain("my-skill");
		const desc = target.querySelector("#edit-desc") as HTMLInputElement;
		expect(desc.value).toBe("Does a thing");
		const body = target.querySelector("#edit-body") as HTMLTextAreaElement;
		// Frontmatter block stripped, only the body remains.
		expect(body.value).toBe("Body goes here.");
	});

	it("treats content without frontmatter as the whole body", async () => {
		const { target } = await mountModal({ content: "no frontmatter at all" });
		const body = target.querySelector("#edit-body") as HTMLTextAreaElement;
		expect(body.value).toBe("no frontmatter at all");
	});

	it("auto-expands the advanced section when the skill has tools/compatibility", async () => {
		const { target } = await mountModal({
			skill: { allowed_tools: "bash, read", compatibility: "model >= opus-4" },
		});
		const tools = target.querySelector("#edit-tools") as HTMLInputElement;
		const compat = target.querySelector("#edit-compat") as HTMLInputElement;
		expect(tools).not.toBeNull();
		expect(tools.value).toBe("bash, read");
		expect(compat.value).toBe("model >= opus-4");
	});

	it("toggles the advanced section open and shut", async () => {
		const { target } = await mountModal();
		// No advanced fields when the skill has neither tools nor compatibility.
		expect(target.querySelector("#edit-tools")).toBeNull();
		await dom.fire(target.querySelector(".advanced-toggle") as HTMLButtonElement, "click");
		expect(target.querySelector("#edit-tools")).not.toBeNull();
		await dom.fire(target.querySelector(".advanced-toggle") as HTMLButtonElement, "click");
		expect(target.querySelector("#edit-tools")).toBeNull();
	});

	it("disables Save when the description is emptied and re-enables it when valid", async () => {
		const { target } = await mountModal();
		expect(saveButton(target).disabled).toBe(false);
		await dom.type(target.querySelector("#edit-desc") as HTMLInputElement, "");
		expect(saveButton(target).disabled).toBe(true);
		await dom.type(target.querySelector("#edit-desc") as HTMLInputElement, "valid again");
		expect(saveButton(target).disabled).toBe(false);
	});

	it("shows a field error and disables Save when the description exceeds the max length", async () => {
		const { target } = await mountModal();
		await dom.type(target.querySelector("#edit-desc") as HTMLInputElement, "x".repeat(1025));
		expect(target.querySelector(".field-error")?.textContent).toContain("1024 characters or fewer");
		expect(saveButton(target).disabled).toBe(true);
		// The char-count badge flips to the over state.
		expect(target.querySelector(".char-count")?.classList.contains("over")).toBe(true);
	});

	it("PATCHes /api/skills/:id with the edited fields and calls onSaved", async () => {
		const { target } = await mountModal();
		let patchBody: unknown;
		dom.route("PATCH", "/api/skills/11111111-2222-3333-4444-555555555555", (req) => {
			patchBody = req.body;
			return { skill: skill() };
		});
		await dom.type(target.querySelector("#edit-desc") as HTMLInputElement, "updated description");
		await dom.type(target.querySelector("#edit-body") as HTMLTextAreaElement, "updated body");
		await dom.fire(saveButton(target), "click");
		await dom.settle();
		const patches = dom.requests.filter(
			(r) => r.method === "PATCH" && r.path === "/api/skills/11111111-2222-3333-4444-555555555555",
		);
		expect(patches.length).toBe(1);
		expect(patchBody).toMatchObject({
			description: "updated description",
			body: "updated body",
		});
		expect(saved).toBe(1);
		expect(closed).toBe(0);
	});

	it("includes advanced fields in the PATCH when they are set", async () => {
		const { target } = await mountModal({
			skill: { allowed_tools: "bash", compatibility: "opus" },
		});
		let patchBody: Record<string, unknown> | undefined;
		dom.route("PATCH", "/api/skills/11111111-2222-3333-4444-555555555555", (req) => {
			patchBody = req.body as Record<string, unknown>;
			return { skill: skill() };
		});
		await dom.fire(saveButton(target), "click");
		await dom.settle();
		expect(patchBody?.allowed_tools).toBe("bash");
		expect(patchBody?.compatibility).toBe("opus");
	});

	it("surfaces the server error message and does not call onSaved on failure", async () => {
		const { target } = await mountModal();
		dom.route(
			"PATCH",
			"/api/skills/11111111-2222-3333-4444-555555555555",
			() => new Response(JSON.stringify({ error: "skill is locked" }), { status: 409 }),
		);
		await dom.fire(saveButton(target), "click");
		await dom.settle();
		expect(target.querySelector(".server-error")?.textContent).toContain("skill is locked");
		expect(saved).toBe(0);
		// Save is re-enabled after the failed attempt.
		expect(saveButton(target).disabled).toBe(false);
	});

	it("closes via the Cancel button and on Escape inside the panel", async () => {
		const { target } = await mountModal();
		const cancel = [...target.querySelectorAll(".modal-footer button")][0] as HTMLButtonElement;
		await dom.fire(cancel, "click");
		expect(closed).toBe(1);
		// Escape on the backdrop also closes.
		await dom.fire(target.querySelector(".modal-backdrop") as HTMLElement, "keydown", {
			key: "Escape",
		});
		expect(closed).toBe(2);
	});

	it("closes when the backdrop is clicked but not when the panel is clicked", async () => {
		const { target } = await mountModal();
		await dom.fire(target.querySelector(".modal-panel") as HTMLElement, "click");
		expect(closed).toBe(0);
		await dom.fire(target.querySelector(".modal-backdrop") as HTMLElement, "click");
		expect(closed).toBe(1);
	});
});
