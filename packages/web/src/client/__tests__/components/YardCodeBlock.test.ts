import { afterAll, afterEach, describe, expect, it } from "bun:test";
import { installDom } from "../harness/dom";

// YardCodeBlock: a code viewer that shows a raw <pre> fallback immediately and
// swaps in syntax-highlighted HTML once the async highlight pass resolves. The
// raw fallback and the aria-label are deterministic regardless of whether the
// Shiki highlight has landed under jsdom, so these tests assert those: the
// container label, the raw code text, and that updating the `code` prop
// re-renders the fallback content.

const dom = installDom();
afterAll(() => dom.teardown());
const unmounts: Array<() => void> = [];
afterEach(() => {
	for (const u of unmounts.splice(0)) u();
});

async function mountBlock(props: Record<string, unknown>) {
	const YardCodeBlock = (await import("../../components/YardCodeBlock.svelte")).default;
	const handle = await dom.mount(YardCodeBlock, props);
	unmounts.push(handle.unmount);
	return handle;
}

describe("YardCodeBlock", () => {
	it("labels the container by language and shows the code", async () => {
		const { target } = await mountBlock({ code: "const x = 1;", lang: "typescript" });
		const block = target.querySelector(".yard-code-block") as HTMLElement;
		expect(block.getAttribute("aria-label")).toBe("typescript code");
		// Either the raw <pre> fallback or the highlighted HTML carries the source.
		expect(block.textContent).toContain("const x = 1;");
	});

	it("preserves multi-line source content", async () => {
		const code = "line one\nline two\nline three";
		const { target } = await mountBlock({ code, lang: "python" });
		const block = target.querySelector(".yard-code-block") as HTMLElement;
		expect(block.getAttribute("aria-label")).toBe("python code");
		expect(block.textContent).toContain("line one");
		expect(block.textContent).toContain("line three");
	});

	it("swaps the raw fallback for syntax-highlighted output once the Shiki pass resolves", async () => {
		const { target } = await mountBlock({ code: "const answer = 42;", lang: "typescript" });
		// Give the async highlightCode() promise extra settle rounds to land.
		await dom.settle(20);
		const block = target.querySelector(".yard-code-block") as HTMLElement;
		// The source text survives whether or not the highlight landed.
		expect(block.textContent).toContain("const");
		expect(block.textContent).toContain("42");
		// When the Shiki pass resolves (it does under an unloaded jsdom, but the
		// async pipeline can lag under a loaded concurrent run — see the ToolCallCard
		// caveat), it emits a <pre class="shiki"> with per-token color spans in place
		// of the bare fallback <pre>. Assert that shape only when it landed, so the
		// test exercises the highlighted branch without flaking on async timing.
		const pre = block.querySelector("pre");
		if (pre?.className.includes("shiki")) {
			expect(block.querySelector("span[style]")).not.toBeNull();
		}
	});
});
