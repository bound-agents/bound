import { afterAll, describe, expect, it } from "bun:test";
import { installDom } from "./harness/dom";

// Mounts a real compiled component under jsdom. Guards the test-preload
// svelte plugin: compiled .svelte imports and svelte's browser build. Uses the
// shared harness window: svelte caches the first window it renders into for
// the whole process, so a private JSDOM here would break every later file.
const dom = installDom();
afterAll(() => dom.teardown());

describe("Btn", () => {
	it("renders its label and fires onclick", async () => {
		const { createRawSnippet } = await import("svelte");
		const Btn = (await import("../components/Btn.svelte")).default;
		let clicks = 0;
		const { target, unmount } = await dom.mount(Btn, {
			children: createRawSnippet(() => ({ render: () => "<span>Save</span>" })),
			onclick: () => {
				clicks++;
			},
			variant: "primary",
		});
		const button = target.querySelector("button");
		expect(button?.textContent).toBe("Save");
		button?.click();
		expect(clicks).toBe(1);
		unmount();
	});
});
