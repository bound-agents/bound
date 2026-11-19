import { afterAll, afterEach, describe, expect, it } from "bun:test";
import { createRawSnippet } from "svelte";
import { installDom } from "../harness/dom";

// Page: a scroll container. In the default (non-flush) mode it wraps children
// in a `.page-inner` that carries the --page-pad var; in flush mode it renders
// children directly with no inner container. These tests assert both modes and
// the pad passthrough.

const dom = installDom();
afterAll(() => dom.teardown());
const unmounts: Array<() => void> = [];
afterEach(() => {
	for (const u of unmounts.splice(0)) u();
});

const body = () => createRawSnippet(() => ({ render: () => "<p>content</p>" }));

async function mountPage(props: Record<string, unknown>) {
	const Page = (await import("../../components/Page.svelte")).default;
	const handle = await dom.mount(Page, props);
	unmounts.push(handle.unmount);
	return handle;
}

describe("Page", () => {
	it("wraps children in a padded inner container by default", async () => {
		const { target } = await mountPage({ children: body() });
		const inner = target.querySelector(".page-inner") as HTMLElement;
		expect(inner).not.toBeNull();
		expect(inner.textContent).toContain("content");
		expect(inner.getAttribute("style")).toContain("--page-pad: 28px 36px");
	});

	it("passes a custom pad through to the inner container", async () => {
		const { target } = await mountPage({ children: body(), pad: "10px" });
		const inner = target.querySelector(".page-inner") as HTMLElement;
		expect(inner.getAttribute("style")).toContain("--page-pad: 10px");
	});

	it("renders children directly without an inner container when flush", async () => {
		const { target } = await mountPage({ children: body(), flush: true });
		expect(target.querySelector(".page-inner")).toBeNull();
		expect(target.querySelector(".page")?.textContent).toContain("content");
	});
});
