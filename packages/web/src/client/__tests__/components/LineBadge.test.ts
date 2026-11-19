import { afterAll, describe, expect, it } from "bun:test";
import { getLineCode, getLineColor } from "../../lib/metro-lines";
import { installDom } from "../harness/dom";

const dom = installDom();
afterAll(() => dom.teardown());

async function mountBadge(props: Record<string, unknown>) {
	const LineBadge = (await import("../../components/LineBadge.svelte")).default;
	return dom.mount(LineBadge, props);
}

describe("LineBadge", () => {
	it("renders the derived line code for an index when no label is given", async () => {
		const { target } = await mountBadge({ lineIndex: 3 });
		const span = target.querySelector("span");
		expect(span).not.toBeNull();
		// Index 3 is the Tozai line, code "T".
		expect(getLineCode(3)).toBe("T");
		expect(span?.textContent?.trim()).toBe("T");
		expect(span?.getAttribute("aria-label")).toBe("Line T");
		expect(span?.getAttribute("role")).toBe("img");
	});

	it("prefers an explicit label over the derived code", async () => {
		const { target } = await mountBadge({ lineIndex: 0, label: "ZZ" });
		const span = target.querySelector("span");
		expect(span?.textContent?.trim()).toBe("ZZ");
		expect(span?.getAttribute("aria-label")).toBe("Line ZZ");
	});

	it("paints the ring in the line's color", async () => {
		const { target } = await mountBadge({ lineIndex: 1 });
		const span = target.querySelector("span") as HTMLElement;
		// jsdom normalizes the hex #C8331C to rgb(200, 51, 28) in the style attribute.
		expect(span.style.borderColor).toBe("rgb(200, 51, 28)");
		expect(getLineColor(1)).toBe("#C8331C");
	});

	it("scales diameter, font-size and ring width for compact size", async () => {
		const { target } = await mountBadge({ lineIndex: 2, size: "compact" });
		const style = target.querySelector("span")?.getAttribute("style") ?? "";
		expect(style).toContain("width: 18px");
		expect(style).toContain("height: 18px");
		expect(style).toContain("font-size: 9px");
		expect(style).toContain("border: 3px solid");
	});

	it("scales up for large size", async () => {
		const { target } = await mountBadge({ lineIndex: 2, size: "large" });
		const style = target.querySelector("span")?.getAttribute("style") ?? "";
		expect(style).toContain("width: 40px");
		expect(style).toContain("height: 40px");
		expect(style).toContain("font-size: 17px");
		expect(style).toContain("border: 7px solid");
	});

	it("uses standard dimensions by default", async () => {
		const { target } = await mountBadge({ lineIndex: 4 });
		const style = target.querySelector("span")?.getAttribute("style") ?? "";
		expect(style).toContain("width: 26px");
		expect(style).toContain("height: 26px");
		expect(style).toContain("font-size: 12px");
		expect(style).toContain("border: 4px solid");
	});

	it("wraps the palette for out-of-range indices", async () => {
		// Index 10 wraps to 0 (code "G").
		const { target } = await mountBadge({ lineIndex: 10 });
		const span = target.querySelector("span");
		expect(span?.textContent?.trim()).toBe(getLineCode(10));
		expect(getLineCode(10)).toBe("G");
	});
});
