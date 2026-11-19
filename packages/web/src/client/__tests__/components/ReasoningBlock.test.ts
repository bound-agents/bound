import { afterAll, afterEach, describe, expect, it } from "bun:test";
import { installDom } from "../harness/dom";

// ReasoningBlock: a collapsible disclosure for model reasoning. The toggle is a
// button carrying aria-expanded + a word count; the body (rendered markdown or
// a raw-text fallback) only exists while open. A redacted block shows a count
// of "redacted" and, when open with no text, a redaction note. These tests
// drive the open/close toggle (click + Enter/Space keydown), the word-count
// pluralization, the redacted label, and the border line-color — all
// deterministic, independent of whether the async markdown pass has landed.

const dom = installDom();
afterAll(() => dom.teardown());
const unmounts: Array<() => void> = [];
afterEach(() => {
	for (const u of unmounts.splice(0)) u();
});

async function mountBlock(props: Record<string, unknown>) {
	const ReasoningBlock = (await import("../../components/ReasoningBlock.svelte")).default;
	const handle = await dom.mount(ReasoningBlock, props);
	unmounts.push(handle.unmount);
	return handle;
}

describe("ReasoningBlock", () => {
	it("is collapsed by default with a pluralized word count and no body", async () => {
		const { target } = await mountBlock({ text: "one two three" });
		const toggle = target.querySelector(".reasoning-toggle") as HTMLButtonElement;
		expect(toggle.getAttribute("aria-expanded")).toBe("false");
		expect(target.querySelector(".reasoning-meta")?.textContent).toContain("3 words");
		expect(target.querySelector(".reasoning-body")).toBeNull();
	});

	it("uses the singular word form for a one-word reasoning", async () => {
		const { target } = await mountBlock({ text: "solo" });
		expect(target.querySelector(".reasoning-meta")?.textContent).toContain("1 word");
		expect(target.querySelector(".reasoning-meta")?.textContent).not.toContain("1 words");
	});

	it("opens on click and shows the reasoning text (fallback or rendered)", async () => {
		const { target } = await mountBlock({ text: "the model considered X" });
		const toggle = target.querySelector(".reasoning-toggle") as HTMLButtonElement;
		await dom.fire(toggle, "click");
		expect(toggle.getAttribute("aria-expanded")).toBe("true");
		const body = target.querySelector(".reasoning-body");
		expect(body).not.toBeNull();
		expect(body?.textContent).toContain("the model considered X");
	});

	it("toggles open and shut on repeated clicks", async () => {
		const { target } = await mountBlock({ text: "abc" });
		const toggle = target.querySelector(".reasoning-toggle") as HTMLButtonElement;
		await dom.fire(toggle, "click");
		expect(target.querySelector(".reasoning-body")).not.toBeNull();
		await dom.fire(toggle, "click");
		expect(target.querySelector(".reasoning-body")).toBeNull();
	});

	it("opens on Enter and Space keydown but not other keys", async () => {
		const { target } = await mountBlock({ text: "abc" });
		const toggle = target.querySelector(".reasoning-toggle") as HTMLButtonElement;
		await dom.fire(toggle, "keydown", { key: "x" });
		expect(target.querySelector(".reasoning-body")).toBeNull();
		await dom.fire(toggle, "keydown", { key: "Enter" });
		expect(target.querySelector(".reasoning-body")).not.toBeNull();
		await dom.fire(toggle, "keydown", { key: " " });
		expect(target.querySelector(".reasoning-body")).toBeNull();
	});

	it("applies the line color to the open body border", async () => {
		const { target } = await mountBlock({ text: "abc", lineColor: "#ff0000" });
		await dom.fire(target.querySelector(".reasoning-toggle") as HTMLButtonElement, "click");
		const body = target.querySelector(".reasoning-body") as HTMLElement;
		// jsdom normalizes #ff0000 to rgb(255, 0, 0) in the style attribute.
		expect(body.getAttribute("style")).toContain("border-left-color: rgb(255, 0, 0)");
	});

	it("shows a redacted marker and the redaction note when open with no text", async () => {
		const { target } = await mountBlock({ text: "", redacted: true });
		expect(target.querySelector(".reasoning-meta")?.textContent).toContain("redacted");
		await dom.fire(target.querySelector(".reasoning-toggle") as HTMLButtonElement, "click");
		expect(target.querySelector(".reasoning-redacted-note")?.textContent).toContain(
			"redacted by the provider",
		);
	});
});
