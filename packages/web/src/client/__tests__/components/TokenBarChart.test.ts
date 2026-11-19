import { afterAll, describe, expect, it } from "bun:test";
import { installDom } from "../harness/dom";

// TokenBarChart is pure props → SVG: a four-segment stacked bar (input /
// output / cache-read / cache-write) per model, filtered to nonzero totals,
// sorted by total descending, with a color legend and a full-breakdown
// tooltip on hover. These tests mount the real compiled component under jsdom
// and assert the rendered segments, filtering, sort order, and tooltip.

const dom = installDom();
afterAll(() => dom.teardown());

type Row = {
	model_id: string;
	tokens_in: number;
	tokens_out: number;
	cache_read: number;
	cache_write: number;
};

function row(partial: Partial<Row> & { model_id: string }): Row {
	return { tokens_in: 0, tokens_out: 0, cache_read: 0, cache_write: 0, ...partial };
}

async function mountChart(data: Row[]) {
	const TokenBarChart = (await import("../../components/TokenBarChart.svelte")).default;
	return dom.mount(TokenBarChart, { data });
}

describe("TokenBarChart", () => {
	it("renders no bars with empty data but always shows the legend", async () => {
		const { target, unmount } = await mountChart([]);
		await dom.settle();
		expect(target.querySelectorAll("rect.bar").length).toBe(0);
		expect(target.textContent).toContain("Input");
		expect(target.textContent).toContain("Output");
		expect(target.textContent).toContain("Cache read");
		expect(target.textContent).toContain("Cache write");
		unmount();
	});

	it("draws four segments per model and renders the model label", async () => {
		const data = [
			row({ model_id: "opus", tokens_in: 100, tokens_out: 50, cache_read: 20, cache_write: 10 }),
		];
		const { target, unmount } = await mountChart(data);
		await dom.settle();
		// Four segments for one model.
		expect(target.querySelectorAll("rect.bar").length).toBe(4);
		expect(target.textContent).toContain("opus");
		// Labeled by token class for a11y.
		const labels = [...target.querySelectorAll("rect.bar")].map((r) =>
			r.getAttribute("aria-label"),
		);
		expect(labels).toEqual([
			"Input tokens bar",
			"Output tokens bar",
			"Cache read tokens bar",
			"Cache write tokens bar",
		]);
		unmount();
	});

	it("filters out models whose total tokens are zero", async () => {
		const data = [row({ model_id: "has-tokens", tokens_in: 100 }), row({ model_id: "all-zero" })];
		const { target, unmount } = await mountChart(data);
		await dom.settle();
		expect(target.textContent).toContain("has-tokens");
		expect(target.textContent).not.toContain("all-zero");
		// Only one model's worth of bars.
		expect(target.querySelectorAll("rect.bar").length).toBe(4);
		unmount();
	});

	it("sorts models by total tokens descending", async () => {
		const data = [
			row({ model_id: "small", tokens_in: 10 }),
			row({ model_id: "large", tokens_in: 1000 }),
			row({ model_id: "medium", tokens_in: 100 }),
		];
		const { target, unmount } = await mountChart(data);
		await dom.settle();
		const labels = [...target.querySelectorAll("text.model-label")].map((t) =>
			t.textContent?.trim(),
		);
		expect(labels).toEqual(["large", "medium", "small"]);
		unmount();
	});

	it("builds a full four-class breakdown tooltip on hover and hides on leave", async () => {
		const data = [
			row({
				model_id: "opus",
				tokens_in: 1000,
				tokens_out: 2000,
				cache_read: 3000,
				cache_write: 4000,
			}),
		];
		const { target, unmount } = await mountChart(data);
		await dom.settle();
		const firstSegment = target.querySelector("rect.bar") as Element;
		await dom.fire(firstSegment, "mouseenter", { clientX: 40, clientY: 30 });
		const text = target.textContent ?? "";
		expect(text).toContain("opus");
		expect(text).toContain("1,000"); // input
		expect(text).toContain("2,000"); // output
		expect(text).toContain("3,000"); // cache read
		expect(text).toContain("4,000"); // cache write
		expect(text).toContain("10,000"); // total
		// Fire mouseleave on every segment: each of the four bars wires its own
		// hideTooltip handler, so all must be exercised, not just the first.
		for (const seg of target.querySelectorAll("rect.bar")) {
			await dom.fire(seg as Element, "mouseenter", { clientX: 20, clientY: 20 });
			await dom.fire(seg as Element, "mouseleave");
		}
		expect(target.textContent ?? "").not.toContain("Cache write: 4,000");
		unmount();
	});

	it("re-renders the tooltip as the pointer moves between segments", async () => {
		const data = [row({ model_id: "m1", tokens_in: 500 }), row({ model_id: "m2", tokens_in: 900 })];
		const { target, unmount } = await mountChart(data);
		await dom.settle();
		// m2 sorts first (900 > 500); its input segment is the first bar.
		const bars = target.querySelectorAll("rect.bar");
		await dom.fire(bars[0] as Element, "mousemove", { clientX: 5, clientY: 5 });
		expect(target.textContent).toContain("m2");
		await dom.fire(bars[4] as Element, "mousemove", { clientX: 5, clientY: 5 });
		expect(target.textContent).toContain("m1");
		unmount();
	});
});
