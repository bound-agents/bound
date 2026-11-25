import { afterAll, describe, expect, it } from "bun:test";
import { installDom } from "../harness/dom";

// MetricsView fetches GET /api/metrics (through its own MetricsStore, which
// uses the global fetch the harness fakes) on mount and renders three sections
// — Tokens, Relay Performance, Context Assembly — each with MetroCard summaries
// and charts (TokenBarChart, CostTimeline, LatencyBarChart, CacheHitTimeline,
// MiniMetricChart) plus a relay-cycles DataTable. It also covers the initial
// loading state, the hard-error state (no data), and the all-zero "no data in
// range" state. Children exercised: MetroCard, DateRangeBar, SectionHeader,
// Page, DataTable, and the chart components.

const dom = installDom({ url: "http://localhost/#/metrics" });
afterAll(() => dom.teardown());

/** A fully-populated metrics payload covering all three sections. */
function sampleMetrics() {
	return {
		tokens: {
			byModel: [
				{
					model_id: "gpt-x",
					tokens_in: 1000,
					tokens_out: 500,
					cache_read: 200,
					cache_write: 100,
					cost_usd: 1.23,
					turn_count: 10,
				},
			],
			costByModelTimeline: [
				{
					date: "2026-11-18",
					model_id: "gpt-x",
					cost_usd: 1.23,
					cost_input_usd: 0.5,
					cost_output_usd: 0.5,
					cost_cache_read_usd: 0.13,
					cost_cache_write_usd: 0.1,
					tokens_in: 1000,
					tokens_out: 500,
					cache_read: 200,
					cache_write: 100,
				},
			],
			byProvider: [
				{
					provider: "bedrock-main",
					tokens_in: 900,
					tokens_out: 400,
					cache_read: 200,
					cache_write: 100,
					cost_usd: 1.0,
					turn_count: 8,
					error_count: 1,
				},
				{
					provider: null,
					tokens_in: 100,
					tokens_out: 100,
					cache_read: 0,
					cache_write: 0,
					cost_usd: 0.2345,
					turn_count: 2,
					error_count: 0,
				},
			] as Array<Record<string, unknown>>,
			totals: {
				tokens_in: 1000,
				tokens_out: 500,
				cache_read: 200,
				cache_write: 100,
				cost_usd: 1.2345,
				turn_count: 10,
				error_count: 1,
			},
		},
		relay: {
			byHost: [
				{
					peer_site_id: "peer-1",
					avg_latency_ms: 120,
					p95_latency_ms: 300,
					success_count: 9,
					failure_count: 1,
					expired_count: 0,
				},
			],
			recentCycles: [
				{
					direction: "outbound",
					peer_site_id: "peer-1",
					kind: "inference",
					latency_ms: 120,
					success: true,
					expired: false,
					created_at: "2026-11-18T12:00:00.000Z",
				},
				{
					direction: "inbound",
					peer_site_id: "peer-1",
					kind: "tool",
					latency_ms: null,
					success: false,
					expired: true,
					created_at: "2026-11-18T12:01:00.000Z",
				},
			],
			totals: {
				total_cycles: 10,
				success_rate: 0.9,
				avg_latency_ms: 118.6,
				expired_count: 1,
			},
		},
		context: {
			totals: {
				last_cache_hit_rate: 0.82,
				budget_pressure_count: 2,
				avg_truncated_messages: 3.4,
				total_turns_with_debug: 8,
			},
			timeline: [
				{
					date: "2026-11-18",
					cache_hit_rate: 0.82,
					budget_pressure_pct: 0.25,
					avg_context_utilization: 0.6,
				},
			],
		},
	};
}

/** An all-zero payload — turn_count and total_cycles both 0. */
function emptyMetrics() {
	const m = sampleMetrics();
	m.tokens.totals.turn_count = 0;
	m.relay.totals.total_cycles = 0;
	m.context.totals.total_turns_with_debug = 0;
	return m;
}

async function mountMetrics(route: (req: unknown) => unknown) {
	dom.route("GET", "/api/metrics", route as never);
	const View = (await import("../../views/MetricsView.svelte")).default;
	const mounted = await dom.mount(View, {});
	await dom.settle();
	return mounted;
}

describe("MetricsView", () => {
	it("loads metrics and renders the token totals summary", async () => {
		const { target } = await mountMetrics(() => sampleMetrics());
		expect(dom.requests.some((r) => r.path.startsWith("/api/metrics"))).toBe(true);
		expect(target.textContent?.replace(/\s+/g, " ")).toContain("Tokens");
		// Total tokens = in + out + cache_read + cache_write = 1800.
		expect(target.textContent?.replace(/\s+/g, " ")).toContain("1,800");
		// Total cost rendered to 4 dp.
		expect(target.textContent?.replace(/\s+/g, " ")).toContain("$1.2345");
		// Turn count.
		expect(target.textContent?.replace(/\s+/g, " ")).toContain("Turn Count");
	});

	it("renders the provider table with turn shares and an unattributed bucket", async () => {
		const { target } = await mountMetrics(() => sampleMetrics());
		const table = target.querySelector(".provider-table");
		expect(table).not.toBeNull();
		const text = table?.textContent?.replace(/\s+/g, " ") ?? "";
		expect(text).toContain("bedrock-main");
		expect(text).toContain("unattributed");
		// 8 of 10 turns → 80.0%; 1,600 tokens; $1.0000.
		expect(text).toContain("80.0%");
		expect(text).toContain("1,600");
		expect(text).toContain("$1.0000");
		expect(text).toContain("20.0%");
	});

	it("omits the provider table when the server sends no byProvider", async () => {
		const { target } = await mountMetrics(() => {
			const m = sampleMetrics();
			const { byProvider: _omitted, ...tokens } = m.tokens;
			return { ...m, tokens };
		});
		expect(target.querySelector(".provider-table")).toBeNull();
		expect(target.textContent).toContain("Turn Count");
	});

	it("renders the relay performance section with success rate and latency", async () => {
		const { target } = await mountMetrics(() => sampleMetrics());
		expect(target.textContent?.replace(/\s+/g, " ")).toContain("Relay Performance");
		// success_rate 0.9 → "90.0%".
		expect(target.textContent?.replace(/\s+/g, " ")).toContain("90.0%");
		// avg_latency_ms rounds to 119ms.
		expect(target.textContent?.replace(/\s+/g, " ")).toContain("119ms");
		expect(target.textContent?.replace(/\s+/g, " ")).toContain("Expired Count");
	});

	it("renders the relay cycles table with formatted status and latency", async () => {
		const { target } = await mountMetrics(() => sampleMetrics());
		// DataTable column formatters: success→OK/FAIL, null latency→"—".
		const tableText = target.querySelector(".relay-table-scroll")?.textContent ?? "";
		expect(tableText).toContain("OK");
		expect(tableText).toContain("FAIL");
		expect(tableText).toContain("120ms");
		expect(tableText).toContain("—");
		// Caption: two cycles shown of ten in range.
		expect(target.textContent?.replace(/\s+/g, " ")).toContain("Latest 2 of 10 cycles in range");
	});

	it("renders the context assembly section with cache hit rate", async () => {
		const { target } = await mountMetrics(() => sampleMetrics());
		expect(target.textContent?.replace(/\s+/g, " ")).toContain("Context Assembly");
		// last_cache_hit_rate 0.82 → "82.0%".
		expect(target.textContent?.replace(/\s+/g, " ")).toContain("82.0%");
		expect(target.textContent?.replace(/\s+/g, " ")).toContain("Budget Pressure");
		// avg_truncated_messages 3.4 → "3.4".
		expect(target.textContent?.replace(/\s+/g, " ")).toContain("3.4");
	});

	it("shows the no-data state when every section is empty", async () => {
		const { target } = await mountMetrics(() => emptyMetrics());
		expect(target.textContent?.replace(/\s+/g, " ")).toContain("No data in the selected range.");
	});

	it("renders the DateRangeBar with preset buttons", async () => {
		const { target } = await mountMetrics(() => sampleMetrics());
		const buttons = Array.from(target.querySelectorAll("button")).map((b) => b.textContent?.trim());
		expect(buttons).toContain("24h");
		expect(buttons).toContain("7d");
		expect(buttons).toContain("30d");
	});

	it("re-fetches metrics with a new range when a preset is clicked", async () => {
		const { target } = await mountMetrics(() => sampleMetrics());
		const before = dom.requests.filter((r) => r.path.startsWith("/api/metrics")).length;
		const sevenDay = Array.from(target.querySelectorAll("button")).find(
			(b) => b.textContent?.trim() === "7d",
		);
		expect(sevenDay).toBeTruthy();
		await dom.fire(sevenDay as Element, "click");
		const after = dom.requests.filter((r) => r.path.startsWith("/api/metrics")).length;
		expect(after).toBeGreaterThan(before);
	});

	it("shows the hard error state when the first fetch fails", async () => {
		const { target } = await mountMetrics(
			() => new Response(JSON.stringify({ error: "metrics exploded" }), { status: 500 }),
		);
		const errState = target.querySelector(".state.err");
		expect(errState).not.toBeNull();
		expect(errState?.textContent).toContain("metrics exploded");
	});
});
