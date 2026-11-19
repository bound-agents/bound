import { afterAll, describe, expect, it } from "bun:test";
import { installDom } from "../harness/dom";

// CacheHitTimeline is pure props → SVG: a filled area + line + per-point
// circles over time, with y-axis gridlines (0–100%), sampled x-axis ticks,
// an all-zero-but-present data path (operator must SEE a broken cache, not a
// "No data" placeholder), a genuinely-empty state, and a hover tooltip. These
// tests mount the real compiled component under jsdom and assert the rendered
// geometry, the zero-vs-empty distinction, tick sampling, and the tooltip.

const dom = installDom();
afterAll(() => dom.teardown());

type Row = { date: string; cache_hit_rate: number };

async function mountChart(data: Row[]) {
	const CacheHitTimeline = (await import("../../components/CacheHitTimeline.svelte")).default;
	return dom.mount(CacheHitTimeline, { data });
}

describe("CacheHitTimeline", () => {
	it("shows the no-data state for a genuinely empty timeline", async () => {
		const { target, unmount } = await mountChart([]);
		await dom.settle();
		expect(target.textContent).toContain("No cache data");
		// No line / area / points when there is no data.
		expect(target.querySelectorAll("circle.data-point").length).toBe(0);
		// Y-axis labels (0%..100%) are always drawn.
		expect(target.textContent).toContain("0%");
		expect(target.textContent).toContain("100%");
		unmount();
	});

	it("renders a flat line of points for all-zero rates (NOT the empty state)", async () => {
		const data = [
			{ date: "2026-01-01", cache_hit_rate: 0 },
			{ date: "2026-01-02", cache_hit_rate: 0 },
			{ date: "2026-01-03", cache_hit_rate: 0 },
		];
		const { target, unmount } = await mountChart(data);
		await dom.settle();
		// A broken cache is still data — the operator must SEE the flat 0% line.
		expect(target.textContent).not.toContain("No cache data");
		expect(target.querySelectorAll("circle.data-point").length).toBe(3);
		// Line + area paths both present.
		expect(target.querySelectorAll("path").length).toBeGreaterThanOrEqual(2);
		unmount();
	});

	it("draws one data point per bucket sorted by time", async () => {
		const data = [
			{ date: "2026-01-03", cache_hit_rate: 0.9 },
			{ date: "2026-01-01", cache_hit_rate: 0.5 },
			{ date: "2026-01-02", cache_hit_rate: 0.7 },
		];
		const { target, unmount } = await mountChart(data);
		await dom.settle();
		const points = target.querySelectorAll("circle.data-point");
		expect(points.length).toBe(3);
		// Sorted ascending by time → increasing cx.
		const cxs = [...points].map((p) => Number(p.getAttribute("cx")));
		expect(cxs[0]).toBeLessThan(cxs[1] as number);
		expect(cxs[1] as number).toBeLessThan(cxs[2] as number);
		unmount();
	});

	it("samples x-axis ticks down when there are many buckets", async () => {
		const data = Array.from({ length: 14 }, (_, i) => ({
			date: `2026-01-${String(i + 1).padStart(2, "0")}`,
			cache_hit_rate: 0.5,
		}));
		const { target, unmount } = await mountChart(data);
		await dom.settle();
		const xLabels = target.querySelectorAll("text.x-label");
		// 14 buckets → step ceil(14/6)=3 → fewer than 14 labels, but all 14 points.
		expect(target.querySelectorAll("circle.data-point").length).toBe(14);
		expect(xLabels.length).toBeGreaterThan(0);
		expect(xLabels.length).toBeLessThan(14);
		unmount();
	});

	it("builds a tooltip with the formatted percentage on hover and hides on leave", async () => {
		const data = [{ date: "2026-01-01", cache_hit_rate: 0.837 }];
		const { target, unmount } = await mountChart(data);
		await dom.settle();
		const point = target.querySelector("circle.data-point") as Element;
		await dom.fire(point, "mouseenter", { clientX: 30, clientY: 20 });
		const text = target.textContent ?? "";
		expect(text).toContain("Cache hit: 83.7%");
		// Daily bucket tooltip label is the raw calendar date.
		expect(text).toContain("2026-01-01");
		await dom.fire(point, "mouseleave");
		expect(target.textContent ?? "").not.toContain("Cache hit: 83.7%");
		unmount();
	});

	it("re-positions the tooltip as the pointer moves over a point", async () => {
		const data = [{ date: "2026-01-01", cache_hit_rate: 0.5 }];
		const { target, unmount } = await mountChart(data);
		await dom.settle();
		const point = target.querySelector("circle.data-point") as Element;
		await dom.fire(point, "mousemove", { clientX: 50, clientY: 40 });
		expect(target.querySelector(".chart-tooltip")).not.toBeNull();
		unmount();
	});
});
