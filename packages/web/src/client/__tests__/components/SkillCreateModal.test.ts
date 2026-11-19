import { afterAll, afterEach, beforeEach, describe, expect, it } from "bun:test";
import { installDom } from "../harness/dom";

// SkillCreateModal: a two-mode (form / upload) dialog that validates input and
// POSTs to /api/skills via the shared BoundClient. These tests drive the real
// compiled component under jsdom and assert the rendered validation feedback,
// mode switching, enable/disable gating of the submit button, and the exact
// request the client sends on submit.

const dom = installDom();
afterAll(() => dom.teardown());

const unmounts: Array<() => void> = [];
afterEach(() => {
	for (const u of unmounts.splice(0)) u();
});

let closed: number;
let created: number;

async function mountModal() {
	const SkillCreateModal = (await import("../../components/SkillCreateModal.svelte")).default;
	const handle = await dom.mount(SkillCreateModal, {
		onClose: () => {
			closed++;
		},
		onCreated: () => {
			created++;
		},
	});
	unmounts.push(handle.unmount);
	return handle;
}

/** The "Create" submit button is the last footer button. */
function submitButton(target: HTMLElement): HTMLButtonElement {
	const buttons = Array.from(
		target.querySelectorAll(".modal-footer button"),
	) as HTMLButtonElement[];
	return buttons[buttons.length - 1];
}

function cancelButton(target: HTMLElement): HTMLButtonElement {
	return target.querySelector(".modal-footer button") as HTMLButtonElement;
}

describe("SkillCreateModal", () => {
	beforeEach(() => {
		closed = 0;
		created = 0;
		dom.requests.length = 0;
	});

	it("renders the form fields in form mode by default", async () => {
		const { target } = await mountModal();
		expect(target.querySelector("#skill-name")).not.toBeNull();
		expect(target.querySelector("#skill-desc")).not.toBeNull();
		expect(target.querySelector("#skill-body")).not.toBeNull();
		expect(target.textContent).toContain("Create Skill");
	});

	it("keeps the submit button disabled until the form is valid", async () => {
		const { target } = await mountModal();
		expect(submitButton(target).disabled).toBe(true);
		await dom.type(target.querySelector("#skill-name") as HTMLInputElement, "my-skill");
		await dom.type(target.querySelector("#skill-desc") as HTMLInputElement, "does things");
		await dom.type(target.querySelector("#skill-body") as HTMLTextAreaElement, "# instructions");
		expect(submitButton(target).disabled).toBe(false);
	});

	it("shows a name-format error for invalid names", async () => {
		const { target } = await mountModal();
		await dom.type(target.querySelector("#skill-name") as HTMLInputElement, "Bad Name!");
		expect(target.textContent).toContain("lowercase alphanumeric with hyphens");
		expect(submitButton(target).disabled).toBe(true);
	});

	it("shows a name-length error past 64 characters", async () => {
		const { target } = await mountModal();
		await dom.type(target.querySelector("#skill-name") as HTMLInputElement, "a".repeat(65));
		expect(target.textContent).toContain("64 characters or fewer");
	});

	it("tracks the description character count and flags over-length", async () => {
		const { target } = await mountModal();
		const desc = target.querySelector("#skill-desc") as HTMLInputElement;
		await dom.type(desc, "short");
		expect(target.textContent).toContain("5/1024");
		await dom.type(desc, "x".repeat(1025));
		expect(target.textContent).toContain("Description must be 1024 characters or fewer");
		expect((target.querySelector(".char-count") as HTMLElement).classList.contains("over")).toBe(
			true,
		);
	});

	it("reveals advanced fields when the advanced toggle is clicked", async () => {
		const { target } = await mountModal();
		expect(target.querySelector("#skill-tools")).toBeNull();
		const toggle = target.querySelector(".advanced-toggle") as HTMLButtonElement;
		await dom.fire(toggle, "click");
		expect(target.querySelector("#skill-tools")).not.toBeNull();
		expect(target.querySelector("#skill-compat")).not.toBeNull();
	});

	it("submits the form and POSTs to /api/skills with the entered fields", async () => {
		let body: Record<string, unknown> | null = null;
		dom.route("POST", "/api/skills", (req) => {
			body = req.body as Record<string, unknown>;
			return { skill: { id: "s1", name: "my-skill" } };
		});
		const { target } = await mountModal();
		await dom.type(target.querySelector("#skill-name") as HTMLInputElement, "my-skill");
		await dom.type(target.querySelector("#skill-desc") as HTMLInputElement, "does things");
		await dom.type(target.querySelector("#skill-body") as HTMLTextAreaElement, "# body");
		// Fill advanced fields so the optional params are included.
		await dom.fire(target.querySelector(".advanced-toggle") as HTMLButtonElement, "click");
		await dom.type(target.querySelector("#skill-tools") as HTMLInputElement, "tool1, tool2");
		await dom.fire(submitButton(target), "click");
		await dom.settle();
		expect(created).toBe(1);
		expect(body).toEqual({
			name: "my-skill",
			description: "does things",
			body: "# body",
			allowed_tools: "tool1, tool2",
			compatibility: undefined,
		});
		const posts = dom.requests.filter((r) => r.path === "/api/skills" && r.method === "POST");
		expect(posts.length).toBe(1);
	});

	it("surfaces a server error and does not call onCreated when the POST fails", async () => {
		dom.route(
			"POST",
			"/api/skills",
			() => new Response(JSON.stringify({ error: "duplicate skill" }), { status: 409 }),
		);
		const { target } = await mountModal();
		await dom.type(target.querySelector("#skill-name") as HTMLInputElement, "dup-skill");
		await dom.type(target.querySelector("#skill-desc") as HTMLInputElement, "d");
		await dom.type(target.querySelector("#skill-body") as HTMLTextAreaElement, "b");
		await dom.fire(submitButton(target), "click");
		await dom.settle();
		expect(created).toBe(0);
		expect(target.querySelector(".server-error")?.textContent).toContain("duplicate skill");
	});

	it("switches to upload mode and validates the chosen file extension", async () => {
		const { target } = await mountModal();
		const tabs = Array.from(target.querySelectorAll(".mode-tabs button")) as HTMLButtonElement[];
		await dom.fire(tabs[1], "click");
		expect(target.querySelector(".upload-area")).not.toBeNull();
		const fileInput = target.querySelector(".file-input") as HTMLInputElement;
		// A disallowed extension surfaces the upload error and keeps submit disabled.
		const badFile = new dom.window.File(["x"], "notes.txt", { type: "text/plain" });
		Object.defineProperty(fileInput, "files", { value: [badFile], configurable: true });
		await dom.fire(fileInput, "change");
		expect(target.textContent).toContain("Only .md and .zip files are accepted");
		expect(submitButton(target).disabled).toBe(true);
	});

	it("uploads a .zip file as FormData and reports creation", async () => {
		let sawFormData = false;
		dom.route("POST", "/api/skills", (req) => {
			// Harness records string/JSON bodies; a FormData body stays a non-plain value.
			sawFormData = !(typeof req.body === "object" && req.body !== null && "name" in req.body);
			return { skill: { id: "s2", name: "bundle" } };
		});
		const { target } = await mountModal();
		await dom.fire(target.querySelectorAll(".mode-tabs button")[1] as HTMLButtonElement, "click");
		const fileInput = target.querySelector(".file-input") as HTMLInputElement;
		const zip = new dom.window.File(["PK"], "bundle.zip", { type: "application/zip" });
		Object.defineProperty(fileInput, "files", { value: [zip], configurable: true });
		await dom.fire(fileInput, "change");
		expect(target.textContent).toContain("bundle.zip");
		expect(submitButton(target).disabled).toBe(false);
		await dom.fire(submitButton(target), "click");
		await dom.settle();
		expect(created).toBe(1);
		expect(sawFormData).toBe(true);
	});

	it("calls onClose when the backdrop is clicked", async () => {
		const { target } = await mountModal();
		await dom.fire(target.querySelector(".modal-backdrop") as HTMLElement, "click");
		expect(closed).toBe(1);
	});

	it("calls onClose on Escape and does not close on clicks inside the panel", async () => {
		const { target } = await mountModal();
		await dom.fire(target.querySelector(".modal-backdrop") as HTMLElement, "keydown", {
			key: "Escape",
		});
		expect(closed).toBe(1);
		await dom.fire(target.querySelector(".modal-panel") as HTMLElement, "click");
		expect(closed).toBe(1);
	});

	it("calls onClose from the Cancel button", async () => {
		const { target } = await mountModal();
		await dom.fire(cancelButton(target), "click");
		expect(closed).toBe(1);
	});
});
