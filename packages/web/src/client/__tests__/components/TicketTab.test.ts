import { afterAll, afterEach, describe, expect, it } from "bun:test";
import { createRawSnippet } from "svelte";
import { installDom } from "../harness/dom";

// TicketTab: a pill that renders a children snippet and derives a wash color.
// A CSS var color (var(...)) uses a fixed rgba wash; a literal hex color gets
// an `11` alpha suffix. These tests assert the rendered content and both
// branches of the wash derivation via the --tab-color / --tab-wash style vars.

const dom = installDom();
afterAll(() => dom.teardown());
const unmounts: Array<() => void> = [];
afterEach(() => {
	for (const u of unmounts.splice(0)) u();
});

const body = () => createRawSnippet(() => ({ render: () => "<span>GRAPH</span>" }));

async function mountTab(props: Record<string, unknown>) {
	const TicketTab = (await import("../../components/TicketTab.svelte")).default;
	const handle = await dom.mount(TicketTab, props);
	unmounts.push(handle.unmount);
	return handle;
}

describe("TicketTab", () => {
	it("renders the children snippet", async () => {
		const { target } = await mountTab({ children: body() });
		expect(target.querySelector(".ticket-tab")?.textContent).toContain("GRAPH");
	});

	it("uses the fixed wash for a CSS-var color (the default)", async () => {
		const { target } = await mountTab({ children: body() });
		const style = (target.querySelector(".ticket-tab") as HTMLElement).getAttribute("style") ?? "";
		expect(style).toContain("--tab-color: var(--ink)");
		expect(style).toContain("--tab-wash: rgba(26,24,20,0.05)");
	});

	it("derives an alpha-suffixed wash for a literal hex color", async () => {
		const { target } = await mountTab({ children: body(), color: "#ff8800" });
		const style = (target.querySelector(".ticket-tab") as HTMLElement).getAttribute("style") ?? "";
		expect(style).toContain("--tab-color: #ff8800");
		expect(style).toContain("--tab-wash: #ff880011");
	});
});
