import { afterAll, describe, expect, it } from "bun:test";
import { installDom } from "../harness/dom";

// CostTimeline is pure props → SVG. We drive it with cost rows and assert the
// rendered chart: per-model line paths, data points, the legend, axis labels,
// the empty state, and tooltip construction on hover.

const dom = installDom();
afterAll(() => dom.teardown());

type Row = {
	date: string;
	model_id: string;
	cost_usd: number;
	cost_input_usd: number;
	cost_output_usd: number;
	cost_cache_read_usd: number;
	cost_cache_write_usd: number;
	tokens_in: number;
	tokens_out: number;
	cache_read: number;
	cache_write: number;
};

function row(partial: Partial<Row> & { date: string; model_id: string; cost_usd: number }): Row {
	return {
		cost_input_usd: 0,
		cost_output_usd: 0,
		cost_cache_read_usd: 0,
		cost_cache_write_usd: 0,
		tokens_in: 0,
		tokens_out: 0,
		cache_read: 0,
		cache_write: 0,
		...partial,
	};
}

async function mountChart(data: Row[]) {
	const CostTimeline = (await import("../../components/CostTimeline.svelte")).default;
	return dom.mount(CostTimeline, { data });
}

describe("CostTimeline", () => {
	it("renders the empty state with no data", async () => {
		const { target, unmount } = await mountChart([]);
		await dom.settle();
		expect(target.textContent).toContain("No cost data");
		// No legend, no line paths when empty.
		expect(target.querySelector(".legend")).toBeNull();
		expect(target.querySelector("path")).toBeNull();
		unmount();
	});

	it("draws one line + legend entry per model", async () => {
		const data = [
			row({ date: "2026-01-01", model_id: "opus", cost_usd: 0.5 }),
			row({ date: "2026-01-02", model_id: "opus", cost_usd: 0.7 }),
			row({ date: "2026-01-01", model_id: "haiku", cost_usd: 0.1 }),
			row({ date: "2026-01-02", model_id: "haiku", cost_usd: 0.2 }),
		];
		const { target, unmount } = await mountChart(data);
		await dom.settle();
		// Two model series → two <path> lines.
		expect(target.querySelectorAll("path").length).toBe(2);
		// Legend shows both model ids.
		const legend = target.querySelector(".legend");
		expect(legend).not.toBeNull();
		expect(legend?.textContent).toContain("opus");
		expect(legend?.textContent).toContain("haiku");
		expect(target.querySelectorAll(".legend-item").length).toBe(2);
		// A hit-area circle per point (4 total).
		expect(target.querySelectorAll("circle.data-point").length).toBe(4);
		// Y-axis labels are dollar formatted.
		expect(target.textContent).toContain("$");
		unmount();
	});

	it("builds a tooltip with the cost breakdown on hover", async () => {
		const data = [
			row({
				date: "2026-01-01",
				model_id: "opus",
				cost_usd: 0.1234,
				cost_input_usd: 0.05,
				cost_output_usd: 0.04,
				cost_cache_read_usd: 0.02,
				cost_cache_write_usd: 0.0134,
				tokens_in: 1000,
				tokens_out: 800,
				cache_read: 500,
				cache_write: 300,
			}),
		];
		const { target, unmount } = await mountChart(data);
		await dom.settle();
		const point = target.querySelector("circle.data-point") as Element;
		expect(point).not.toBeNull();
		await dom.fire(point, "mouseenter", { clientX: 40, clientY: 30 });
		const text = target.textContent ?? "";
		// Tooltip header: model id + headline cost.
		expect(text).toContain("opus");
		expect(text).toContain("Cost: $0.1234");
		// Each non-zero component row appears with its token count.
		expect(text).toContain("Input:");
		expect(text).toContain("Output:");
		expect(text).toContain("Cache read:");
		expect(text).toContain("Cache write:");
		expect(text).toContain("1,000 tok");
		// Mouseleave hides the tooltip content.
		await dom.fire(point, "mouseleave");
		expect(target.textContent ?? "").not.toContain("Cost: $0.1234");
		unmount();
	});

	it("omits zero-token component rows from the tooltip", async () => {
		const data = [
			row({
				date: "2026-01-01",
				model_id: "opus",
				cost_usd: 0.05,
				cost_input_usd: 0.05,
				tokens_in: 1000,
				// output / cache all zero
			}),
		];
		const { target, unmount } = await mountChart(data);
		await dom.settle();
		const point = target.querySelector("circle.data-point") as Element;
		await dom.fire(point, "mouseenter", { clientX: 10, clientY: 10 });
		const text = target.textContent ?? "";
		expect(text).toContain("Input:");
		expect(text).not.toContain("Output:");
		expect(text).not.toContain("Cache read:");
		expect(text).not.toContain("Cache write:");
		unmount();
	});

	it("samples x-axis ticks down when there are many buckets", async () => {
		// 12 distinct daily buckets → tick sampling (step = ceil(12/6) = 2).
		const data = Array.from({ length: 12 }, (_, i) =>
			row({
				date: `2026-01-${String(i + 1).padStart(2, "0")}`,
				model_id: "opus",
				cost_usd: 0.1 * (i + 1),
			}),
		);
		const { target, unmount } = await mountChart(data);
		await dom.settle();
		const xLabels = target.querySelectorAll("text.x-label");
		// With 12 points and step 2, we expect 6 sampled labels, not all 12.
		expect(xLabels.length).toBeGreaterThan(0);
		expect(xLabels.length).toBeLessThan(12);
		unmount();
	});
});
