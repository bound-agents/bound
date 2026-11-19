import { afterAll, describe, expect, it } from "bun:test";
import { installDom } from "../harness/dom";

// LatencyBarChart is pure props → SVG: one solid (avg) + one faded (p95) bar
// per peer, sorted by avg latency descending, colored by latency tier, with a
// legend and a hover tooltip. These tests drive the real compiled component
// under jsdom and assert the rendered geometry, color tiers, sort order, and
// the tooltip the operator sees on hover.

const dom = installDom();
afterAll(() => dom.teardown());

type Row = {
	peer_site_id: string;
	avg_latency_ms: number;
	p95_latency_ms: number;
	success_count: number;
	failure_count: number;
};

function row(partial: Partial<Row> & { peer_site_id: string }): Row {
	return {
		avg_latency_ms: 100,
		p95_latency_ms: 200,
		success_count: 10,
		failure_count: 0,
		...partial,
	};
}

async function mountChart(data: Row[]) {
	const LatencyBarChart = (await import("../../components/LatencyBarChart.svelte")).default;
	return dom.mount(LatencyBarChart, { data });
}

describe("LatencyBarChart", () => {
	it("renders no bars for empty data but keeps the legend", async () => {
		const { target, unmount } = await mountChart([]);
		await dom.settle();
		expect(target.querySelectorAll("rect.bar").length).toBe(0);
		// Legend is always present (avg/p95 + three health tiers).
		expect(target.querySelector(".legend")).not.toBeNull();
		expect(target.textContent).toContain("Avg (solid)");
		expect(target.textContent).toContain("P95 (faded)");
		expect(target.textContent).toContain("< 500ms");
		expect(target.textContent).toContain("≥ 2000ms");
		unmount();
	});

	it("draws two bars (avg + p95) per peer with its truncated label", async () => {
		const data = [
			row({ peer_site_id: "site-aaaaaaaa11112222", avg_latency_ms: 120, p95_latency_ms: 300 }),
			row({ peer_site_id: "site-bbbbbbbb33334444", avg_latency_ms: 80, p95_latency_ms: 150 }),
		];
		const { target, unmount } = await mountChart(data);
		await dom.settle();
		// Two peers × two bars = four rects.
		expect(target.querySelectorAll("rect.bar").length).toBe(4);
		// Labels truncate to the last 8 chars.
		expect(target.textContent).toContain("11112222");
		expect(target.textContent).toContain("33334444");
		// Bar labels show rounded ms.
		expect(target.textContent).toContain("120ms");
		expect(target.textContent).toContain("300ms");
		unmount();
	});

	it("sorts peers by avg latency descending (highest first)", async () => {
		const data = [
			row({ peer_site_id: "low", avg_latency_ms: 50 }),
			row({ peer_site_id: "high", avg_latency_ms: 900 }),
			row({ peer_site_id: "mid", avg_latency_ms: 400 }),
		];
		const { target, unmount } = await mountChart(data);
		await dom.settle();
		const labels = [...target.querySelectorAll("text.host-label")].map((t) =>
			t.textContent?.trim(),
		);
		expect(labels).toEqual(["high", "mid", "low"]);
		unmount();
	});

	it("colors bars by latency tier (green < 500, amber < 2000, red ≥ 2000)", async () => {
		const data = [
			row({ peer_site_id: "ok", avg_latency_ms: 100, p95_latency_ms: 100 }),
			row({ peer_site_id: "warn", avg_latency_ms: 1000, p95_latency_ms: 1000 }),
			row({ peer_site_id: "bad", avg_latency_ms: 3000, p95_latency_ms: 3000 }),
		];
		const { target, unmount } = await mountChart(data);
		await dom.settle();
		const fills = [...target.querySelectorAll("rect.bar")].map((r) => r.getAttribute("fill"));
		// Each tier's rgba appears (avg bars are opacity 1, p95 bars opacity 0.5).
		expect(fills.some((f) => f === "rgba(0, 200, 100, 1)")).toBe(true);
		expect(fills.some((f) => f === "rgba(255, 193, 7, 1)")).toBe(true);
		expect(fills.some((f) => f === "rgba(244, 67, 54, 1)")).toBe(true);
		// p95 bars are drawn at half opacity.
		expect(fills.some((f) => f === "rgba(0, 200, 100, 0.5)")).toBe(true);
		unmount();
	});

	it("shows an avg tooltip on hover and hides it on leave", async () => {
		const data = [
			row({
				peer_site_id: "peer-xyz",
				avg_latency_ms: 123,
				p95_latency_ms: 456,
				success_count: 8,
				failure_count: 2,
			}),
		];
		const { target, unmount } = await mountChart(data);
		await dom.settle();
		const bars = target.querySelectorAll("rect.bar");
		const avgBar = bars[0] as Element;
		await dom.fire(avgBar, "mouseenter", { clientX: 40, clientY: 30 });
		const text = target.textContent ?? "";
		expect(text).toContain("peer-xyz");
		expect(text).toContain("Avg: 123ms");
		expect(text).toContain("8/10 successful");
		await dom.fire(avgBar, "mouseleave");
		expect(target.textContent ?? "").not.toContain("Avg: 123ms");
		unmount();
	});

	it("shows a p95 tooltip when the faded bar is hovered", async () => {
		const data = [row({ peer_site_id: "peer-p95", avg_latency_ms: 100, p95_latency_ms: 789 })];
		const { target, unmount } = await mountChart(data);
		await dom.settle();
		const bars = target.querySelectorAll("rect.bar");
		// Second bar is the p95 (faded) bar for the single peer.
		await dom.fire(bars[1] as Element, "mousemove", { clientX: 10, clientY: 10 });
		const text = target.textContent ?? "";
		expect(text).toContain("P95: 789ms");
		unmount();
	});
});
