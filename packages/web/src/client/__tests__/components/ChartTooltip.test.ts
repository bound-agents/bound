import { afterAll, afterEach, describe, expect, it } from "bun:test";
import { installDom } from "../harness/dom";

// ChartTooltip: an absolutely-positioned tooltip that only renders when
// `visible` is true AND `lines` is non-empty. Position is offset from the
// (x, y) cursor by (+12, -8). These tests assert the visibility gate, the
// rendered lines, and the computed left/top offsets.

const dom = installDom();
afterAll(() => dom.teardown());
const unmounts: Array<() => void> = [];
afterEach(() => {
	for (const u of unmounts.splice(0)) u();
});

async function mountTooltip(props: Record<string, unknown>) {
	const ChartTooltip = (await import("../../components/ChartTooltip.svelte")).default;
	const handle = await dom.mount(ChartTooltip, props);
	unmounts.push(handle.unmount);
	return handle;
}

describe("ChartTooltip", () => {
	it("renders nothing when not visible", async () => {
		const { target } = await mountTooltip({ visible: false, x: 10, y: 20, lines: ["a"] });
		expect(target.querySelector(".chart-tooltip")).toBeNull();
	});

	it("renders nothing when lines is empty, even if visible", async () => {
		const { target } = await mountTooltip({ visible: true, x: 10, y: 20, lines: [] });
		expect(target.querySelector(".chart-tooltip")).toBeNull();
	});

	it("renders each line and offsets position from the cursor", async () => {
		const { target } = await mountTooltip({
			visible: true,
			x: 100,
			y: 50,
			lines: ["tokens: 1.2k", "cost: $0.03"],
		});
		const tip = target.querySelector(".chart-tooltip") as HTMLElement;
		expect(tip).not.toBeNull();
		const lineEls = tip.querySelectorAll(".tooltip-line");
		expect(lineEls.length).toBe(2);
		expect(lineEls[0].textContent).toBe("tokens: 1.2k");
		expect(lineEls[1].textContent).toBe("cost: $0.03");
		// offsetX = 12, offsetY = -8.
		expect(tip.style.left).toBe("112px");
		expect(tip.style.top).toBe("42px");
	});
});
