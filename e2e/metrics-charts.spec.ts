import { type Page, expect, test } from "@playwright/test";
import {
	assertInViewport,
	assertNoHorizontalOverflow,
	assertSvgTextNotClipped,
} from "./helpers/geometry";
import { json, mockAmbient, routingFixture } from "./helpers/mocks";

function metricsFixture() {
	const routing = routingFixture();
	const ids = routing.slice(0, 4).map((m) => m.routes[0].route_id.split(":").slice(2).join(":"));
	const day = (i: number) => new Date(Date.now() - (5 - i) * 86_400_000).toISOString().slice(0, 10);
	const byModel = ids.map((id, i) => ({
		model_id: id,
		tokens_in: 900_000 - i * 100_000,
		tokens_out: 120_000,
		cache_read: 4_000_000,
		cache_write: 50_000,
		cost_usd: 12.5 - i,
		turn_count: 40,
	}));
	const costByModelTimeline = ids.flatMap((id, m) =>
		[0, 1, 2, 3, 4, 5].map((i) => {
			// The last point of the first series is the chart's max: top-right corner.
			const cost = m === 0 && i === 5 ? 9.75 : 0.5 + m * 0.3 + i * 0.1;
			return {
				date: day(i),
				model_id: id,
				cost_usd: cost,
				cost_input_usd: cost / 4,
				cost_output_usd: cost / 4,
				cost_cache_read_usd: cost / 4,
				cost_cache_write_usd: cost / 4,
				tokens_in: 1000,
				tokens_out: 1000,
				cache_read: 1000,
				cache_write: 1000,
			};
		}),
	);
	const tokens = byModel.reduce(
		(a, r) => ({
			tokens_in: a.tokens_in + r.tokens_in,
			tokens_out: a.tokens_out + r.tokens_out,
			cache_read: a.cache_read + r.cache_read,
			cache_write: a.cache_write + r.cache_write,
			cost_usd: a.cost_usd + r.cost_usd,
			turn_count: a.turn_count + r.turn_count,
			error_count: 0,
		}),
		{
			tokens_in: 0,
			tokens_out: 0,
			cache_read: 0,
			cache_write: 0,
			cost_usd: 0,
			turn_count: 0,
			error_count: 0,
		},
	);
	return {
		routing,
		metrics: {
			tokens: { byModel, costByModelTimeline, totals: tokens },
			relay: {
				byHost: [],
				recentCycles: [],
				totals: { total_cycles: 0, success_rate: 0, avg_latency_ms: 0, expired_count: 0 },
			},
			context: {
				totals: {
					last_cache_hit_rate: 0.8,
					budget_pressure_count: 0,
					avg_truncated_messages: 0,
					total_turns_with_debug: 0,
				},
				timeline: [],
			},
		},
	};
}

async function mountMetrics(page: Page): Promise<void> {
	const { routing, metrics } = metricsFixture();
	await mockAmbient(page);
	await page.route("**/api/routing/models", (r) => json(r, { models: routing }));
	await page.route("**/api/metrics?**", (r) => json(r, metrics));
	await page.goto("/#/metrics");
	await expect(page.locator(".token-bar-chart svg")).toBeVisible();
	await expect(page.locator(".cost-timeline svg")).toBeVisible();
}

test.describe("metrics charts", () => {
	test("no horizontal overflow and SVG labels stay inside their charts", async ({ page }) => {
		await mountMetrics(page);
		await assertNoHorizontalOverflow(page);
		await assertSvgTextNotClipped(page.locator(".token-bar-chart svg"));
		await assertSvgTextNotClipped(page.locator(".cost-timeline svg"));
	});

	test("tooltips stay on screen at right-edge and top-edge points", async ({ page }) => {
		await mountMetrics(page);
		const tooltip = page.locator(".chart-tooltip");

		// Token bars: the widest bar reaches the chart's right edge.
		const bar = page.locator(".token-bar-chart svg rect").first();
		await bar.scrollIntoViewIfNeeded();
		const bb = await bar.boundingBox();
		expect(bb).not.toBeNull();
		if (!bb) return;
		await page.mouse.move(bb.x + bb.width - 2, bb.y + bb.height / 2);
		await assertInViewport(tooltip.first());

		// Cost timeline: the top-right data point.
		const points = page.locator(".cost-timeline svg circle");
		const n = await points.count();
		expect(n).toBeGreaterThan(0);
		let best = { x: -1, y: Number.POSITIVE_INFINITY, i: 0 };
		for (let i = 0; i < n; i++) {
			const b = await points.nth(i).boundingBox();
			if (b && (b.x > best.x + 1 || (Math.abs(b.x - best.x) <= 1 && b.y < best.y)))
				best = { x: b.x, y: b.y, i };
		}
		await points.nth(best.i).scrollIntoViewIfNeeded();
		await points.nth(best.i).hover({ force: true });
		await assertInViewport(page.locator(".cost-timeline .chart-tooltip"));
	});
});
