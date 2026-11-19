import { afterAll, afterEach, beforeEach, describe, expect, it } from "bun:test";
import { createRawSnippet } from "svelte";
import { installDom } from "../harness/dom";

// TextInput: a controlled text field that reports changes via an `onchange`
// callback and optionally renders a leading icon snippet. These tests drive
// the real compiled component under jsdom and assert what the user sees and
// what the parent receives.

const dom = installDom();
afterAll(() => dom.teardown());

// Unmount each mounted component before the async teardown restores globals,
// so svelte's deferred effect-teardown doesn't fire after `document` is gone.
const unmounts: Array<() => void> = [];
afterEach(() => {
	for (const u of unmounts.splice(0)) u();
});

async function mountTextInput(props: Record<string, unknown>) {
	const TextInput = (await import("../../components/TextInput.svelte")).default;
	const handle = await dom.mount(TextInput, props);
	unmounts.push(handle.unmount);
	return handle;
}

describe("TextInput", () => {
	let received: string[];
	beforeEach(() => {
		received = [];
	});

	it("renders the initial value and placeholder", async () => {
		const { target } = await mountTextInput({
			value: "seed",
			onchange: (v: string) => received.push(v),
			placeholder: "Search…",
		});
		const input = target.querySelector("input") as HTMLInputElement;
		expect(input).not.toBeNull();
		expect(input.value).toBe("seed");
		expect(input.getAttribute("placeholder")).toBe("Search…");
	});

	it("calls onchange with the new value on input", async () => {
		const { target } = await mountTextInput({
			value: "",
			onchange: (v: string) => received.push(v),
		});
		const input = target.querySelector("input") as HTMLInputElement;
		input.value = "hello";
		await dom.fire(input, "input");
		expect(received).toEqual(["hello"]);
	});

	it("reports each successive edit", async () => {
		const { target } = await mountTextInput({
			value: "",
			onchange: (v: string) => received.push(v),
		});
		const input = target.querySelector("input") as HTMLInputElement;
		input.value = "a";
		await dom.fire(input, "input");
		input.value = "ab";
		await dom.fire(input, "input");
		expect(received).toEqual(["a", "ab"]);
	});

	it("renders the icon snippet when provided", async () => {
		const { target } = await mountTextInput({
			value: "",
			onchange: (v: string) => received.push(v),
			icon: createRawSnippet(() => ({ render: () => "<span>★</span>" })),
		});
		expect(target.querySelector(".icon")).not.toBeNull();
		expect(target.textContent).toContain("★");
	});

	it("omits the icon slot when no icon is given", async () => {
		const { target } = await mountTextInput({
			value: "",
			onchange: (v: string) => received.push(v),
		});
		expect(target.querySelector(".icon")).toBeNull();
	});

	it("applies the full-width modifier class when fullWidth is set", async () => {
		const { target } = await mountTextInput({
			value: "",
			onchange: (v: string) => received.push(v),
			fullWidth: true,
		});
		const label = target.querySelector(".input-wrap") as HTMLElement;
		expect(label.classList.contains("full")).toBe(true);
	});

	it("does not apply the full-width class by default", async () => {
		const { target } = await mountTextInput({
			value: "",
			onchange: (v: string) => received.push(v),
		});
		const label = target.querySelector(".input-wrap") as HTMLElement;
		expect(label.classList.contains("full")).toBe(false);
	});
});
