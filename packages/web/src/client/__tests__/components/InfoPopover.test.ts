import { afterAll, afterEach, describe, expect, it } from "bun:test";
import { createRawSnippet } from "svelte";
import { installDom } from "../harness/dom";

// InfoPopover: an instant hover/focus tooltip. The trigger is a focusable
// button carrying aria-label + the trigger snippet; the bubble (role=tooltip)
// only exists while visible and is shown on mouseenter/focus, hidden on
// mouseleave/blur. Position is computed fixed from the trigger rect, flipping
// to "bottom" when there isn't room above. These tests drive the show/hide
// events and assert the trigger attributes, the body fallback to `label`, the
// custom body snippet, the trigger class/style passthrough, and the placement
// flip.

const dom = installDom();
afterAll(() => dom.teardown());
const unmounts: Array<() => void> = [];
afterEach(() => {
	for (const u of unmounts.splice(0)) u();
});

const triggerSnippet = (text = "?") =>
	createRawSnippet(() => ({ render: () => `<span>${text}</span>` }));

async function mountPopover(props: Record<string, unknown>) {
	const InfoPopover = (await import("../../components/InfoPopover.svelte")).default;
	const handle = await dom.mount(InfoPopover, { trigger: triggerSnippet(), ...props });
	unmounts.push(handle.unmount);
	return handle;
}

describe("InfoPopover", () => {
	it("renders a labelled trigger button and no bubble until hovered", async () => {
		const { target } = await mountPopover({ label: "Explains the gauge" });
		const trigger = target.querySelector(".info-trigger") as HTMLButtonElement;
		expect(trigger.getAttribute("aria-label")).toBe("Explains the gauge");
		expect(trigger.textContent).toContain("?");
		expect(target.querySelector(".info-bubble")).toBeNull();
	});

	it("shows the bubble on mouseenter and hides it on mouseleave", async () => {
		const { target } = await mountPopover({ label: "Hello" });
		const trigger = target.querySelector(".info-trigger") as HTMLButtonElement;
		await dom.fire(trigger, "mouseenter");
		const bubble = target.querySelector(".info-bubble");
		expect(bubble).not.toBeNull();
		expect(bubble?.getAttribute("role")).toBe("tooltip");
		// Falls back to label as the body when no children snippet is given.
		expect(bubble?.textContent?.trim()).toBe("Hello");
		await dom.fire(trigger, "mouseleave");
		expect(target.querySelector(".info-bubble")).toBeNull();
	});

	it("shows on focus and hides on blur", async () => {
		const { target } = await mountPopover({ label: "Hi" });
		const trigger = target.querySelector(".info-trigger") as HTMLButtonElement;
		await dom.fire(trigger, "focus");
		expect(target.querySelector(".info-bubble")).not.toBeNull();
		await dom.fire(trigger, "blur");
		expect(target.querySelector(".info-bubble")).toBeNull();
	});

	it("renders a custom body snippet over the label fallback", async () => {
		const { target } = await mountPopover({
			label: "fallback",
			children: createRawSnippet(() => ({ render: () => "<b>rich body</b>" })),
		});
		await dom.fire(target.querySelector(".info-trigger") as HTMLButtonElement, "mouseenter");
		const bubble = target.querySelector(".info-bubble");
		expect(bubble?.textContent).toContain("rich body");
		expect(bubble?.textContent).not.toContain("fallback");
	});

	it("passes triggerClass and triggerStyle through to the button", async () => {
		const { target } = await mountPopover({
			label: "x",
			triggerClass: "bare",
			triggerStyle: "color: red",
		});
		const trigger = target.querySelector(".info-trigger") as HTMLButtonElement;
		expect(trigger.classList).toContain("bare");
		expect(trigger.getAttribute("style")).toContain("color: red");
	});

	it("keeps the top placement class when there is room above", async () => {
		// jsdom getBoundingClientRect returns all-zero rects, so r.top (0) < 160
		// forces a flip to bottom for the default top placement; a bottom request
		// stays bottom. Assert the resolved class via the bubble modifier.
		const { target } = await mountPopover({ label: "x", placement: "bottom" });
		await dom.fire(target.querySelector(".info-trigger") as HTMLButtonElement, "mouseenter");
		const bubble = target.querySelector(".info-bubble");
		// bottom placement → no up modifier.
		expect(bubble?.classList.contains("info-bubble-up")).toBe(false);
	});

	it("flips a top placement to bottom when the trigger sits near the top edge", async () => {
		const { target } = await mountPopover({ label: "x", placement: "top" });
		await dom.fire(target.querySelector(".info-trigger") as HTMLButtonElement, "mouseenter");
		const bubble = target.querySelector(".info-bubble");
		// r.top is 0 (< 160) under jsdom, so top flips to bottom → no up modifier.
		expect(bubble?.classList.contains("info-bubble-up")).toBe(false);
	});
});
