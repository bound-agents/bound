import { afterEach, describe, expect, it } from "bun:test";
import { installDom } from "../harness/dom";

let dom: ReturnType<typeof installDom> | null = null;

afterEach(() => {
	dom?.teardown();
	dom = null;
});

type PersonaResponse = { persona: string; modified_at: string | null; max_bytes: number };

async function mountWith(
	loadHandler: () => PersonaResponse | Response,
	saveHandler?: () => unknown | Response,
) {
	dom = installDom();
	dom.route("GET", "/api/persona", loadHandler);
	if (saveHandler) dom.route("POST", "/api/persona", saveHandler);
	const PersonaView = (await import("../../views/PersonaView.svelte")).default;
	const mounted = await dom.mount(PersonaView, {});
	await dom.settle();
	return mounted;
}

function okPersona(overrides: Partial<PersonaResponse> = {}): PersonaResponse {
	return {
		persona: "You are a helpful agent.",
		modified_at: "2026-03-01T00:00:00.000Z",
		max_bytes: 64 * 1024,
		...overrides,
	};
}

describe("PersonaView", () => {
	it("loads the persona and fills the editor", async () => {
		const { target } = await mountWith(() => okPersona({ persona: "voice text" }));
		expect(dom?.requests.some((r) => r.method === "GET" && r.path === "/api/persona")).toBe(true);
		const editor = target.querySelector("textarea.editor") as HTMLTextAreaElement;
		expect(editor).not.toBeNull();
		expect(editor.value).toBe("voice text");
		// Byte count shown.
		expect(target.querySelector(".count")?.textContent).toContain("/");
		// "last set" meta rendered from modified_at.
		expect(target.querySelector(".meta")?.textContent).toContain("last set");
	});

	it("surfaces a load error when the GET fails", async () => {
		const { target } = await mountWith(() => new Response("boom", { status: 500 }));
		expect(target.querySelector(".err")?.textContent).toContain("GET /api/persona failed: 500");
		// Editor still renders (loading finished).
		expect(target.querySelector("textarea.editor")).not.toBeNull();
	});

	it("marks the editor dirty on edit and enables Save/Revert", async () => {
		const { target } = await mountWith(() => okPersona({ persona: "orig" }));
		const editor = target.querySelector("textarea.editor") as HTMLTextAreaElement;
		const buttons = [...target.querySelectorAll("button")];
		const save = buttons.find((b) => b.textContent?.includes("Save")) as HTMLButtonElement;
		const revert = buttons.find((b) => b.textContent?.includes("Revert")) as HTMLButtonElement;
		// Initially clean → both disabled.
		expect(save.disabled).toBe(true);
		expect(revert.disabled).toBe(true);
		await dom?.type(editor, "orig changed");
		expect(save.disabled).toBe(false);
		expect(revert.disabled).toBe(false);
	});

	it("reverts to the original text and re-disables the buttons", async () => {
		const { target } = await mountWith(() => okPersona({ persona: "orig" }));
		const editor = target.querySelector("textarea.editor") as HTMLTextAreaElement;
		await dom?.type(editor, "orig changed");
		const revert = [...target.querySelectorAll("button")].find((b) =>
			b.textContent?.includes("Revert"),
		) as HTMLButtonElement;
		await dom?.fire(revert, "click");
		expect(editor.value).toBe("orig");
		expect(revert.disabled).toBe(true);
	});

	it("saves the edited persona via POST and shows the propagation confirmation", async () => {
		let saved: unknown = null;
		const { target } = await mountWith(
			() => okPersona({ persona: "orig" }),
			() => {
				saved = true;
				return { ok: true };
			},
		);
		const editor = target.querySelector("textarea.editor") as HTMLTextAreaElement;
		await dom?.type(editor, "new voice");
		const save = [...target.querySelectorAll("button")].find((b) =>
			b.textContent?.includes("Save"),
		) as HTMLButtonElement;
		await dom?.fire(save, "click");
		const post = dom?.requests.find((r) => r.method === "POST" && r.path === "/api/persona");
		expect(post).not.toBeUndefined();
		expect((post?.body as { persona: string }).persona).toBe("new voice");
		expect(saved).toBe(true);
		// After save, the editor is clean again and the ok banner shows.
		expect(target.querySelector(".ok")?.textContent).toContain("Syncing to cluster.");
	});

	it("surfaces a save error returned by the API", async () => {
		const { target } = await mountWith(
			() => okPersona({ persona: "orig" }),
			() => new Response(JSON.stringify({ error: "server refused" }), { status: 400 }),
		);
		const editor = target.querySelector("textarea.editor") as HTMLTextAreaElement;
		await dom?.type(editor, "new voice");
		const save = [...target.querySelectorAll("button")].find((b) =>
			b.textContent?.includes("Save"),
		) as HTMLButtonElement;
		await dom?.fire(save, "click");
		expect(target.querySelector(".err")?.textContent).toContain("server refused");
	});

	it("shows an over-cap warning and disables Save when the persona exceeds max_bytes", async () => {
		const { target } = await mountWith(() => okPersona({ persona: "orig", max_bytes: 10 }));
		const editor = target.querySelector("textarea.editor") as HTMLTextAreaElement;
		await dom?.type(editor, "this is clearly longer than ten bytes");
		expect(target.querySelector(".err")?.textContent).toContain("Over the");
		const save = [...target.querySelectorAll("button")].find((b) =>
			b.textContent?.includes("Save"),
		) as HTMLButtonElement;
		expect(save.disabled).toBe(true);
		// The byte count is marked over.
		expect(target.querySelector(".count.over")).not.toBeNull();
	});

	it("keeps Save disabled while the text is unchanged (no save path while clean)", async () => {
		const { target } = await mountWith(
			() => okPersona({ persona: "orig" }),
			() => ({ ok: true }),
		);
		const save = [...target.querySelectorAll("button")].find((b) =>
			b.textContent?.includes("Save"),
		) as HTMLButtonElement;
		// Clean → Save disabled, so the user has no path to POST an unchanged persona.
		expect(save.disabled).toBe(true);
		expect(dom?.requests.some((r) => r.method === "POST")).toBe(false);
	});
});
