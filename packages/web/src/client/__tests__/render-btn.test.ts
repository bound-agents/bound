import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { JSDOM } from "jsdom";

// Mounts a real compiled component under jsdom. Guards the test-preload
// svelte plugin: compiled .svelte imports and svelte's browser build.
const GLOBALS = ["window", "document", "Node", "Element", "HTMLElement", "Text", "navigator"];
const saved = new Map<string, unknown>();

beforeAll(() => {
	const dom = new JSDOM("<!doctype html><html><body></body></html>");
	for (const key of GLOBALS) {
		saved.set(key, (globalThis as Record<string, unknown>)[key]);
		(globalThis as Record<string, unknown>)[key] = (
			dom.window as unknown as Record<string, unknown>
		)[key];
	}
});

afterAll(() => {
	for (const [key, value] of saved) (globalThis as Record<string, unknown>)[key] = value;
});

describe("Btn", () => {
	it("renders its label and fires onclick", async () => {
		const { createRawSnippet, flushSync, mount, unmount } = await import("svelte");
		const Btn = (await import("../components/Btn.svelte")).default;
		const target = document.createElement("div");
		document.body.appendChild(target);
		let clicks = 0;
		const app = mount(Btn, {
			target,
			props: {
				children: createRawSnippet(() => ({ render: () => "<span>Save</span>" })),
				onclick: () => {
					clicks++;
				},
				variant: "primary",
			},
		});
		flushSync();
		const button = target.querySelector("button");
		expect(button?.textContent).toBe("Save");
		button?.click();
		expect(clicks).toBe(1);
		unmount(app);
	});
});
