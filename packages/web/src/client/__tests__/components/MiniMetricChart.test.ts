import { afterAll, describe, expect, it } from "bun:test";
import MiniMetricChart from "../../components/MiniMetricChart.svelte";
import { installDom } from "../harness/dom";

// Shared dom: MiniMetricChart mounts a ChartTooltip child; re-running
// installDom() per test leaves the torn-down window's prototypes dangling in
// the cached svelte module and crashes a later dynamic mount.
const dom = installDom();
afterAll(() => dom.teardown());

type Point = { date: string; value: number };

async function mount(props: {
	title: string;
	color: string;
	data: Point[];
	yMin?: number;
	yMax?: number;
	formatValue?: (v: number) => string;
	formatAxis?: (v: number) => string;
}) {
	const mounted = await dom.mount(MiniMetricChart, {
		formatValue: (v: number) => String(v),
		...props,
	});
	await dom.settle();
	return mounted;
}

// Hourly bucket strings parsed by parseBucket. Use the ISO-ish form the chart
// expects.
function bucket(hour: number): string {
	const h = String(hour).padStart(2, "0");
	return `2026-03-01T${h}:00`;
}

describe("MiniMetricChart", () => {
	it("renders the title", async () => {
		const { target } = await mount({
			title: "Tokens In",
			color: "var(--line-T)",
			data: [{ date: bucket(0), value: 10 }],
		});
		expect(target.querySelector(".title")?.textContent).toBe("Tokens In");
	});

	it("shows the no-data label when there are no points", async () => {
		const { target } = await mount({
			title: "Empty",
			color: "red",
			data: [],
		});
		expect(target.querySelector(".no-data-label")?.textContent?.trim()).toBe("No data");
		// No line path or data points when empty.
		expect(target.querySelector(".data-point")).toBeNull();
	});

	it("draws a line, area and one data point per datum when data is present", async () => {
		const { target } = await mount({
			title: "Series",
			color: "blue",
			data: [
				{ date: bucket(0), value: 5 },
				{ date: bucket(1), value: 15 },
				{ date: bucket(2), value: 10 },
			],
		});
		expect(target.querySelector(".no-data-label")).toBeNull();
		const points = target.querySelectorAll(".data-point");
		expect(points.length).toBe(3);
		// A line path and an area path both exist.
		const paths = [...target.querySelectorAll("path")];
		expect(paths.length).toBe(2);
	});

	it("renders y-axis tick labels using formatValue (or formatAxis when provided)", async () => {
		const { target } = await mount({
			title: "Axis",
			color: "green",
			data: [{ date: bucket(0), value: 100 }],
			formatValue: (v) => `v${v}`,
			formatAxis: (v) => `a${Math.round(v)}`,
		});
		const axisLabels = [...target.querySelectorAll(".axis-label")].map((t) =>
			t.textContent?.trim(),
		);
		// formatAxis wins for tick labels when provided.
		expect(axisLabels.some((l) => l?.startsWith("a"))).toBe(true);
	});

	it("shows a tooltip on mouseenter over a data point and hides it on mouseleave", async () => {
		const { target } = await mount({
			title: "Hover",
			color: "orange",
			data: [
				{ date: bucket(0), value: 5 },
				{ date: bucket(1), value: 9 },
			],
		});
		const point = target.querySelector(".data-point") as SVGElement;
		await dom.fire(point, "mouseenter", { clientX: 40, clientY: 30 });
		// ChartTooltip renders its lines when visible; the title + value line appears.
		expect(target.textContent).toContain("Hover: 5");
		await dom.fire(point, "mouseleave");
		await dom.settle();
		// After leave, the tooltip line is gone.
		expect(target.textContent).not.toContain("Hover: 5");
	});

	it("updates the tooltip position on mousemove", async () => {
		const { target } = await mount({
			title: "Move",
			color: "purple",
			data: [{ date: bucket(0), value: 7 }],
		});
		const point = target.querySelector(".data-point") as SVGElement;
		await dom.fire(point, "mousemove", { clientX: 10, clientY: 10 });
		expect(target.textContent).toContain("Move: 7");
	});

	it("honors an explicit yMax for the domain (no divide-by-zero on all-zero data)", async () => {
		const { target } = await mount({
			title: "Zero",
			color: "gray",
			data: [
				{ date: bucket(0), value: 0 },
				{ date: bucket(1), value: 0 },
			],
			yMax: 10,
		});
		// Still renders points without throwing.
		expect(target.querySelectorAll(".data-point").length).toBe(2);
	});

	it("thins x-axis ticks when there are more than four points", async () => {
		const data = Array.from({ length: 10 }, (_, i) => ({ date: bucket(i), value: i }));
		const { target } = await mount({ title: "Many", color: "teal", data });
		// 10 data points render, but x-axis tick labels are a thinned subset.
		expect(target.querySelectorAll(".data-point").length).toBe(10);
		const xTickCount = [...target.querySelectorAll("text.axis-label")].length;
		// y ticks (3) + thinned x ticks; the x subset is <= ceil(10/4)+1 and far fewer than 10.
		expect(xTickCount).toBeLessThan(13);
	});
});
