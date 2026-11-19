import { afterAll, afterEach, describe, expect, it } from "bun:test";
import { installDom } from "../harness/dom";

// ContextSparkline: an SVG area+line chart over per-turn context usage, with a
// transparent clickable hit-rect per turn and a highlight circle on the
// selected point. These tests assert the point geometry (single vs multi turn,
// empty), the per-turn hit rects, keyboard/click selection callbacks, and the
// selected-index fallback to the last point.

type Turn = { context_debug: { totalEstimated: number; contextWindow: number } };
const turn = (totalEstimated: number, contextWindow = 1000): Turn => ({
	context_debug: { totalEstimated, contextWindow },
});

const dom = installDom();
afterAll(() => dom.teardown());
const unmounts: Array<() => void> = [];
afterEach(() => {
	for (const u of unmounts.splice(0)) u();
});

async function mountSparkline(props: Record<string, unknown>) {
	const ContextSparkline = (await import("../../components/ContextSparkline.svelte")).default;
	const handle = await dom.mount(ContextSparkline, props);
	unmounts.push(handle.unmount);
	return handle;
}

describe("ContextSparkline", () => {
	it("renders no path, polyline or hit rects when there are no turns", async () => {
		const { target } = await mountSparkline({ turns: [], selectedIdx: -1 });
		expect(target.querySelector("path")).toBeNull();
		expect(target.querySelector("polyline")).toBeNull();
		expect(target.querySelectorAll("rect").length).toBe(0);
		// No points → no selected circle.
		expect(target.querySelector("circle")).toBeNull();
	});

	it("centers a single turn and draws a hit rect but no polyline", async () => {
		const { target } = await mountSparkline({ turns: [turn(500)], selectedIdx: -1 });
		// Area path exists; polyline needs >1 point.
		expect(target.querySelector("path")).not.toBeNull();
		expect(target.querySelector("polyline")).toBeNull();
		const rects = target.querySelectorAll("rect");
		expect(rects.length).toBe(1);
		// Single point sits at WIDTH/2 = 144, so the hit rect is at x = 144 - 8.
		expect(rects[0].getAttribute("x")).toBe("136");
		// selectedIdx -1 falls back to the last (only) point → a highlight circle.
		expect(target.querySelector("circle")).not.toBeNull();
	});

	it("draws a polyline and one hit rect per turn for multiple turns", async () => {
		const turns = [turn(200), turn(400), turn(800)];
		const { target } = await mountSparkline({ turns, selectedIdx: 1 });
		const polyline = target.querySelector("polyline");
		expect(polyline).not.toBeNull();
		// Three x,y pairs in the points attribute.
		expect(polyline?.getAttribute("points")?.trim().split(/\s+/).length).toBe(3);
		expect(target.querySelectorAll("rect").length).toBe(3);
		// Each hit rect is labelled by turn ordinal.
		const rects = target.querySelectorAll("rect");
		expect(rects[0].getAttribute("aria-label")).toBe("Turn 1");
		expect(rects[2].getAttribute("aria-label")).toBe("Turn 3");
	});

	it("fires onSelectTurn with the clicked turn index", async () => {
		const selected: number[] = [];
		const turns = [turn(200), turn(400), turn(800)];
		const { target } = await mountSparkline({
			turns,
			selectedIdx: 0,
			onSelectTurn: (idx: number) => selected.push(idx),
		});
		const rects = target.querySelectorAll("rect");
		await dom.fire(rects[2], "click");
		expect(selected).toEqual([2]);
	});

	it("fires onSelectTurn on Enter/Space keydown", async () => {
		const selected: number[] = [];
		const turns = [turn(200), turn(400)];
		const { target } = await mountSparkline({
			turns,
			selectedIdx: 0,
			onSelectTurn: (idx: number) => selected.push(idx),
		});
		const rects = target.querySelectorAll("rect");
		await dom.fire(rects[1], "keydown", { key: "Enter" });
		await dom.fire(rects[0], "keydown", { key: " " });
		// A non-activating key does nothing.
		await dom.fire(rects[0], "keydown", { key: "Tab" });
		expect(selected).toEqual([1, 0]);
	});
});
