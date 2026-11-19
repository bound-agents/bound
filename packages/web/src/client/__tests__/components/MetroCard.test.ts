import { afterAll, afterEach, describe, expect, it } from "bun:test";
import { createRawSnippet } from "svelte";
import { installDom } from "../harness/dom";

// MetroCard: a card shell with optional accent stripe and interactive hover.
// The `accented` class (plus the --accent-color var) appears only when
// accentColor is set; the `interactive` class follows the interactive prop.
// These tests assert the class/style combinations and that children render.

const dom = installDom();
afterAll(() => dom.teardown());
const unmounts: Array<() => void> = [];
afterEach(() => {
	for (const u of unmounts.splice(0)) u();
});

const body = () => createRawSnippet(() => ({ render: () => "<p>card body</p>" }));

async function mountCard(props: Record<string, unknown>) {
	const MetroCard = (await import("../../components/MetroCard.svelte")).default;
	const handle = await dom.mount(MetroCard, props);
	unmounts.push(handle.unmount);
	return handle;
}

describe("MetroCard", () => {
	it("renders children and is plain by default", async () => {
		const { target } = await mountCard({ children: body() });
		const card = target.querySelector(".metro-card") as HTMLElement;
		expect(card.textContent).toContain("card body");
		expect(card.classList).not.toContain("accented");
		expect(card.classList).not.toContain("interactive");
		expect(card.getAttribute("style")).toBe("");
	});

	it("adds the accented class and --accent-color var when accentColor is set", async () => {
		const { target } = await mountCard({ children: body(), accentColor: "#123456" });
		const card = target.querySelector(".metro-card") as HTMLElement;
		expect(card.classList).toContain("accented");
		expect(card.getAttribute("style")).toContain("--accent-color: #123456");
	});

	it("adds the interactive class when interactive is true", async () => {
		const { target } = await mountCard({ children: body(), interactive: true });
		const card = target.querySelector(".metro-card") as HTMLElement;
		expect(card.classList).toContain("interactive");
		expect(card.classList).not.toContain("accented");
	});
});
