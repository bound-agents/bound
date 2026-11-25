import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import type { ContextDebugInfo, ContextDebugTurn } from "@bound/client";
import { writable } from "svelte/store";
import type { WebSocketMessage } from "../../lib/bound";
import * as router from "../../lib/router";
import { installDom } from "../harness/dom";

// ContextDebugPanel: fetches /api/threads/:id/context-debug on mount, renders
// a turn-navigation header plus a stack of conditional sections for the
// selected turn (headline token summary, cache row, adaptive row, context bar,
// telescope banner, section list, cross-thread sources, relevant memory,
// sparkline, footer fields). Live context:debug WS events trigger a silent
// refetch. These tests mount the real component through the shared jsdom
// harness, serve realistic payloads from the fake fetch route table, and
// assert rendered output, turn selection, the onTurnChange callback, and the
// empty/error/live-update paths.

const dom = installDom();
afterAll(() => dom.teardown());
const unmounts: Array<() => void> = [];
afterEach(() => {
	for (const u of unmounts.splice(0)) u();
});

// Warm the component import once. This ~1000-line component plus its five
// child components compiles through the svelte test plugin on first import,
// which can exceed a single test's 5s timeout; paying it in beforeAll keeps
// every test fast and stable.
beforeAll(async () => {
	await import("../../components/ContextDebugPanel.svelte");
}, 30_000);

// --- Fixtures -------------------------------------------------------------

function baseDebug(overrides: Partial<ContextDebugInfo> = {}): ContextDebugInfo {
	return {
		contextWindow: 200_000,
		totalEstimated: 50_000,
		model: "opus",
		sections: [
			{ name: "System", tokens: 12_000 },
			{ name: "History", tokens: 30_000 },
			{ name: "Tools", tokens: 8_000 },
		],
		budgetPressure: false,
		truncated: 0,
		...overrides,
	};
}

function turn(overrides: Partial<ContextDebugTurn> = {}): ContextDebugTurn {
	return {
		turn_id: "turn-1",
		model_id: "opus",
		tokens_in: 0,
		tokens_out: 1_200,
		tokens_cache_read: null,
		tokens_cache_write: null,
		context_debug: baseDebug(),
		created_at: "2026-11-19T08:00:00.000Z",
		...overrides,
	};
}

/** Register the REST route the panel fetches; later calls override earlier. */
function serveTurns(turns: ContextDebugTurn[]): void {
	dom.route("GET", /\/context-debug$/, () => turns);
}

async function mountPanel(props: Record<string, unknown> = {}) {
	const ContextDebugPanel = (await import("../../components/ContextDebugPanel.svelte")).default;
	const wsEvents = writable<WebSocketMessage[]>([]);
	const handle = await dom.mount(ContextDebugPanel, {
		threadId: "thread-a",
		wsEvents,
		...props,
	});
	unmounts.push(handle.unmount);
	return { ...handle, wsEvents };
}

describe("ContextDebugPanel", () => {
	it("shows the empty state when the thread has no turns", async () => {
		serveTurns([]);
		const { target } = await mountPanel();
		expect(target.querySelector(".empty")?.textContent).toBe("No turn data yet");
		expect(target.querySelector(".turn-nav")).toBeNull();
	});

	it("falls back to the empty state when the fetch errors", async () => {
		dom.route("GET", /\/context-debug$/, () => new Response("boom", { status: 500 }));
		const { target } = await mountPanel();
		// fetchData swallows the error, leaves turns empty, and clears loading.
		expect(target.querySelector(".empty")?.textContent).toBe("No turn data yet");
		expect(target.querySelector(".loading")).toBeNull();
	});

	it("renders the latest turn with the token headline and the Latest badge", async () => {
		serveTurns([
			turn({ turn_id: "t1", created_at: "2026-11-19T08:00:00.000Z" }),
			turn({
				turn_id: "t2",
				created_at: "2026-11-19T08:05:00.000Z",
				context_debug: baseDebug({ totalEstimated: 60_000 }),
			}),
		]);
		const { target } = await mountPanel();
		// Auto-selects the last turn: 2 / 2.
		expect(target.querySelector(".turn-label-main")?.textContent?.replace(/\s+/g, " ").trim()).toBe(
			"2 / 2",
		);
		expect(target.querySelector(".latest-badge")?.textContent).toBe("Latest");
		// No actual tokens → headline is the estimate, 60,000 formatted.
		expect(target.querySelector(".total-num")?.textContent).toBe("60,000");
		// 60000 / 200000 = 30.0%.
		expect(target.querySelector(".total-pct")?.textContent?.trim()).toBe("30.0%");
		// "Previous" enabled on the last turn, "Next" disabled (we're latest).
		const [prev, next] = Array.from(target.querySelectorAll(".turn-nav button"));
		expect((prev as HTMLButtonElement).disabled).toBe(false);
		expect((next as HTMLButtonElement).disabled).toBe(true);
	});

	it("prefers actual tokens over the estimate and shows the inflation ratio", async () => {
		serveTurns([
			turn({
				context_debug: baseDebug({ totalEstimated: 40_000, actualTotalTokens: 60_000 }),
			}),
		]);
		const { target } = await mountPanel();
		// Headline is the actual count.
		expect(target.querySelector(".total-num")?.textContent).toBe("60,000");
		// The estimate sub-row appears because actual !== estimate.
		expect(target.querySelector(".estimate-num")?.textContent?.trim()).toBe("40,000");
		// ratio = 60000 / 40000 = 1.50 → ×1.50, not flagged high (needs > 1.5).
		const ratio = target.querySelector(".estimate-ratio");
		expect(ratio?.textContent?.replace(/\s+/g, " ").trim()).toBe("× 1.50");
		expect(ratio?.classList.contains("estimate-ratio-high")).toBe(false);
	});

	it("flags a high inflation ratio past 1.5x", async () => {
		serveTurns([
			turn({ context_debug: baseDebug({ totalEstimated: 30_000, actualTotalTokens: 60_000 }) }),
		]);
		const { target } = await mountPanel();
		// ratio = 2.00 > 1.5 → high class.
		expect(target.querySelector(".estimate-ratio")?.classList.contains("estimate-ratio-high")).toBe(
			true,
		);
	});

	it("navigates to the previous turn and drops the Latest badge", async () => {
		serveTurns([
			turn({ turn_id: "t1", created_at: "2026-11-19T08:00:00.000Z" }),
			turn({ turn_id: "t2", created_at: "2026-11-19T08:05:00.000Z" }),
			turn({ turn_id: "t3", created_at: "2026-11-19T08:10:00.000Z" }),
		]);
		const { target } = await mountPanel();
		const prev = target.querySelector(".turn-nav button") as HTMLButtonElement;
		await dom.fire(prev, "click");
		expect(target.querySelector(".turn-label-main")?.textContent?.replace(/\s+/g, " ").trim()).toBe(
			"2 / 3",
		);
		expect(target.querySelector(".latest-badge")).toBeNull();
		// "Next" is now enabled; stepping forward returns to latest.
		const next = target.querySelectorAll(".turn-nav button")[1] as HTMLButtonElement;
		expect(next.disabled).toBe(false);
		await dom.fire(next, "click");
		expect(target.querySelector(".turn-label-main")?.textContent?.replace(/\s+/g, " ").trim()).toBe(
			"3 / 3",
		);
		expect(target.querySelector(".latest-badge")).not.toBeNull();
	});

	it("emits onTurnChange ranges as the user navigates", async () => {
		const ranges: Array<{ from: string; to: string | null } | null> = [];
		serveTurns([
			turn({ turn_id: "t1", created_at: "2026-11-19T08:00:00.000Z" }),
			turn({ turn_id: "t2", created_at: "2026-11-19T08:10:00.000Z" }),
			turn({ turn_id: "t3", created_at: "2026-11-19T08:20:00.000Z" }),
		]);
		const { target } = await mountPanel({
			onTurnChange: (r: { from: string; to: string | null } | null) => ranges.push(r),
		});
		const [prev, next] = Array.from(target.querySelectorAll(".turn-nav button"));
		// Step back to the middle turn (idx 1): bounded by midpoints of its neighbors.
		await dom.fire(prev as HTMLButtonElement, "click");
		expect(ranges.length).toBe(1);
		expect(ranges[0]).not.toBeNull();
		// from = midpoint(08:00, 08:10) = 08:05; to = midpoint(08:10, 08:20) = 08:15.
		expect(ranges[0]?.from).toBe("2026-11-19T08:05:00.000Z");
		expect(ranges[0]?.to).toBe("2026-11-19T08:15:00.000Z");
		// Back to the first turn (idx 0): no left neighbor → from "", to the next midpoint.
		await dom.fire(prev as HTMLButtonElement, "click");
		expect(ranges[1]?.from).toBe("");
		expect(ranges[1]?.to).toBe("2026-11-19T08:05:00.000Z");
		// Forward to latest (idx 2): no right neighbor → to null.
		await dom.fire(next as HTMLButtonElement, "click");
		await dom.fire(next as HTMLButtonElement, "click");
		const latest = ranges.at(-1);
		expect(latest?.to).toBeNull();
		expect(latest?.from).toBe("2026-11-19T08:15:00.000Z");
	});

	it("renders the cache row with read/write figures, TTL and variant", async () => {
		serveTurns([
			turn({
				tokens_cache_read: 42_000,
				tokens_cache_write: 1_500,
				context_debug: baseDebug({
					cachePath: "warm",
					cachePathReason: "warm-eligible",
					cacheMarkers: [
						{
							kind: "message",
							positionTokens: 10_000,
							variant: "rolling",
							ttl: "5m",
							capabilityEnabled: true,
						},
					],
				}),
			}),
		]);
		const { target } = await mountPanel();
		const row = target.querySelector(".cache-row") as HTMLElement;
		expect(row).not.toBeNull();
		expect(row.querySelector(".cache-read")?.textContent).toContain("42,000");
		expect(row.querySelector(".cache-write")?.textContent).toContain("1,500");
		// warm path chip renders with its color class.
		expect(row.querySelector(".cache-path-warm")?.textContent).toBe("warm");
		// TTL + variant metadata.
		const meta = Array.from(row.querySelectorAll(".cache-meta")).map((n) => n.textContent?.trim());
		expect(meta).toContain("5m TTL");
		expect(meta).toContain("rolling");
	});

	it("shows the cache row as disabled when the backend lacks prompt caching", async () => {
		serveTurns([
			turn({
				tokens_cache_read: 0,
				tokens_cache_write: 0,
				context_debug: baseDebug({
					cacheMarkers: [
						{
							kind: "system",
							positionTokens: 0,
							variant: "fixed",
							ttl: "1h",
							capabilityEnabled: false,
						},
					],
				}),
			}),
		]);
		const { target } = await mountPanel();
		const disabled = target.querySelector(".cache-disabled");
		expect(disabled?.textContent).toBe("disabled");
		expect(target.querySelector(".cache-detail")?.textContent).toBe("prompt caching unsupported");
		// The read/write figures are suppressed in the disabled branch.
		expect(target.querySelector(".cache-read")).toBeNull();
	});

	it("omits the cache row when there is nothing cacheable to report", async () => {
		serveTurns([turn({ tokens_cache_read: 0, tokens_cache_write: 0 })]);
		const { target } = await mountPanel();
		expect(target.querySelector(".cache-row")).toBeNull();
	});

	it("renders the adaptive target row with the inflation EMA", async () => {
		serveTurns([
			turn({
				context_debug: baseDebug({
					truncationTargetTokens: 150_000,
					measuredInflation: 1.4,
				} as Partial<ContextDebugInfo>),
			}),
		]);
		const { target } = await mountPanel();
		const row = target.querySelector(".adaptive-row") as HTMLElement;
		expect(row).not.toBeNull();
		const nums = Array.from(row.querySelectorAll(".adaptive-num")).map((n) =>
			n.textContent?.replace(/\s+/g, " ").trim(),
		);
		expect(nums.some((t) => t === "target 150,000")).toBe(true);
		// inflation 1.4 > 1.3 → tightened class on the inflation chip.
		expect(nums.some((t) => t === "inflation ×1.40")).toBe(true);
		expect(row.querySelector(".adaptive-num.adaptive-tight")).not.toBeNull();
	});

	it("shows an inflation-sampling placeholder when the EMA is null", async () => {
		serveTurns([
			turn({
				context_debug: baseDebug({
					truncationTargetTokens: 150_000,
					measuredInflation: null,
				} as Partial<ContextDebugInfo>),
			}),
		]);
		const { target } = await mountPanel();
		expect(
			Array.from(target.querySelectorAll(".cache-meta")).some(
				(n) => n.textContent?.trim() === "inflation: sampling",
			),
		).toBe(true);
	});

	it("renders the telescope banner distinguishing folded, dropped and kept", async () => {
		serveTurns([
			turn({
				context_debug: baseDebug({
					truncated: 5,
					progressiveFidelity: {
						ancientDropped: 2,
						middleFolded: 40,
						recentKept: 12,
						tierBudgets: { ancient: 0, middle: 0, recent: 0 },
						tierTokens: { ancient: 0, middle: 0, recent: 0 },
					},
				}),
			}),
		]);
		const { target } = await mountPanel();
		const banner = target.querySelector(".telescope-banner") as HTMLElement;
		expect(banner).not.toBeNull();
		// dropped (2) <= recentKept (12) → normal, not the warn variant.
		expect(banner.classList.contains("telescope-warn")).toBe(false);
		expect(banner.querySelector(".telescope-title")?.textContent?.trim()).toBe(
			"▤ Telescoped message history",
		);
		expect(banner.querySelector(".telescope-explain")?.textContent?.trim()).toBe("40 folded");
		expect(banner.querySelector(".telescope-dropped")?.textContent?.trim()).toBe("2 dropped");
		expect(banner.querySelector(".telescope-kept")?.textContent?.trim()).toBe("12 kept full-res");
		// No heavy-drop note.
		expect(banner.querySelector(".telescope-note")).toBeNull();
	});

	it("escalates the telescope banner to the warn variant on a heavy drop", async () => {
		serveTurns([
			turn({
				context_debug: baseDebug({
					progressiveFidelity: {
						ancientDropped: 30,
						middleFolded: 10,
						recentKept: 5,
						tierBudgets: { ancient: 0, middle: 0, recent: 0 },
						tierTokens: { ancient: 0, middle: 0, recent: 0 },
					},
				}),
			}),
		]);
		const { target } = await mountPanel();
		const banner = target.querySelector(".telescope-banner") as HTMLElement;
		// dropped (30) > recentKept (5) → warn.
		expect(banner.classList.contains("telescope-warn")).toBe(true);
		expect(banner.querySelector(".telescope-title")?.textContent?.trim()).toBe(
			"⚠ Deep history telescoping",
		);
		expect(banner.querySelector(".telescope-note")).not.toBeNull();
	});

	it("falls back to a plain truncation banner when no tier breakdown exists", async () => {
		serveTurns([turn({ context_debug: baseDebug({ truncated: 3 }) })]);
		const { target } = await mountPanel();
		const banner = target.querySelector(".telescope-banner") as HTMLElement;
		expect(banner).not.toBeNull();
		expect(banner.querySelector(".telescope-title")?.textContent?.trim()).toBe(
			"▤ Truncated history",
		);
		expect(banner.querySelector(".telescope-body")?.textContent?.replace(/\s+/g, " ").trim()).toBe(
			"3 earlier messages dropped to fit the window.",
		);
	});

	it("singularizes the truncation count for a single dropped message", async () => {
		serveTurns([turn({ context_debug: baseDebug({ truncated: 1 }) })]);
		const { target } = await mountPanel();
		expect(target.querySelector(".telescope-body")?.textContent?.replace(/\s+/g, " ").trim()).toBe(
			"1 earlier message dropped to fit the window.",
		);
	});

	it("renders cross-thread sources and navigates on click", async () => {
		const calls: string[] = [];
		const navSpy = spyOnNavigate((route) => calls.push(route));
		try {
			serveTurns([
				turn({
					context_debug: baseDebug({
						crossThreadSources: [
							{
								threadId: "thread-x",
								title: "Prior investigation",
								color: 3,
								messageCount: 17,
								lastMessageAt: "2026-11-18T00:00:00.000Z",
							},
							{
								threadId: "thread-y",
								title: "",
								color: 1,
								messageCount: 2,
								lastMessageAt: "2026-11-17T00:00:00.000Z",
							},
						],
					}),
				}),
			]);
			const { target } = await mountPanel();
			const rows = target.querySelectorAll(".cross-row");
			expect(rows.length).toBe(2);
			expect(rows[0].querySelector(".cross-title")?.textContent).toBe("Prior investigation");
			expect(rows[0].querySelector(".cross-msgs")?.textContent?.trim()).toBe("17 msgs");
			// Empty title falls back to the placeholder.
			expect(rows[1].querySelector(".cross-title")?.textContent).toBe("(untitled)");
			await dom.fire(rows[0] as HTMLButtonElement, "click");
			expect(calls).toEqual(["/line/thread-x"]);
		} finally {
			navSpy.mockRestore();
		}
	});

	it("renders injected relevant memory and marks forgotten entries", async () => {
		serveTurns([
			turn({
				context_debug: {
					...baseDebug(),
					// relevantMemory is carried on the wire even though it is not in the
					// published ContextDebugInfo type; the panel reads it defensively.
					relevantMemory: [
						{ key: "person:kara:style", tier: "pinned", tag: "seed", deleted: false },
						{ key: "old:obsolete", tier: "default", tag: "graph", deleted: true },
					],
				} as unknown as ContextDebugInfo,
			}),
		]);
		const { target } = await mountPanel();
		const rows = target.querySelectorAll(".rmem-row");
		expect(rows.length).toBe(2);
		expect(rows[0].querySelector(".rmem-tier")?.textContent?.trim()).toBe("pinned");
		expect(rows[0].querySelector(".rmem-key")?.textContent).toBe("person:kara:style");
		// The forgotten entry shows "forgotten" in place of its tier and carries the class.
		expect(rows[1].classList.contains("rmem-forgotten")).toBe(true);
		expect(rows[1].querySelector(".rmem-tier")?.textContent?.trim()).toBe("forgotten");
	});

	it("selects a turn from the sparkline and reflects it in the header", async () => {
		const ranges: Array<unknown> = [];
		serveTurns([
			turn({ turn_id: "t1", created_at: "2026-11-19T08:00:00.000Z" }),
			turn({ turn_id: "t2", created_at: "2026-11-19T08:05:00.000Z" }),
			turn({ turn_id: "t3", created_at: "2026-11-19T08:10:00.000Z" }),
		]);
		const { target } = await mountPanel({ onTurnChange: (r: unknown) => ranges.push(r) });
		// The sparkline draws one hit-rect per turn; clicking the first selects idx 0.
		const rects = target.querySelectorAll("svg rect");
		expect(rects.length).toBe(3);
		await dom.fire(rects[0], "click");
		expect(target.querySelector(".turn-label-main")?.textContent?.replace(/\s+/g, " ").trim()).toBe(
			"1 / 3",
		);
		// Selecting through the sparkline also emits a range.
		expect(ranges.length).toBe(1);
	});

	it("renders footer fields: model, tokens, variance, budget pressure, folded/dropped", async () => {
		serveTurns([
			turn({
				model_id: "gpt-6-astra",
				tokens_in: 55_000,
				tokens_out: 3_000,
				context_debug: baseDebug({
					totalEstimated: 50_000,
					budgetPressure: true,
					progressiveFidelity: {
						ancientDropped: 1,
						middleFolded: 7,
						recentKept: 20,
						tierBudgets: { ancient: 0, middle: 0, recent: 0 },
						tierTokens: { ancient: 0, middle: 0, recent: 0 },
					},
				}),
			}),
		]);
		const { target } = await mountPanel();
		const fields = Array.from(target.querySelectorAll(".footer-fields .field"));
		const byKicker = (k: string) =>
			fields.find((f) => f.querySelector(".kicker")?.textContent?.trim() === k);
		expect(byKicker("Model")?.querySelector(".mono")?.textContent).toBe("gpt-6-astra");
		expect(
			byKicker("Tokens In / Out")?.querySelector(".mono")?.textContent?.replace(/\s+/g, " ").trim(),
		).toBe("55,000 / 3,000");
		// variance = tokens_in (55000) - estimate (50000) = +5,000 (10.0%).
		expect(
			byKicker("Input variance")
				?.querySelector(".variance-value")
				?.textContent?.replace(/\s+/g, " ")
				.trim(),
		).toBe("+5,000 (10.0%)");
		// budgetPressure true → YES.
		expect(byKicker("Budget pressure")?.querySelector(".mono")?.textContent?.trim()).toBe("YES");
		// progressiveFidelity present → the Folded / dropped field, not Truncated.
		expect(byKicker("Folded / dropped")).toBeTruthy();
		expect(byKicker("Truncated")).toBeUndefined();
	});

	it("shows the Truncated footer field when there is no telescope breakdown", async () => {
		serveTurns([turn({ tokens_in: 0, context_debug: baseDebug({ truncated: 4 }) })]);
		const { target } = await mountPanel();
		const fields = Array.from(target.querySelectorAll(".footer-fields .field"));
		const truncated = fields.find(
			(f) => f.querySelector(".kicker")?.textContent?.trim() === "Truncated",
		);
		expect(truncated?.querySelector(".mono")?.textContent?.trim()).toBe("4");
		// With tokens_in 0 the input-variance field is suppressed.
		expect(
			fields.some((f) => f.querySelector(".kicker")?.textContent?.trim() === "Input variance"),
		).toBe(false);
		// no budgetPressure → "no".
		expect(
			fields
				.find((f) => f.querySelector(".kicker")?.textContent?.trim() === "Budget pressure")
				?.querySelector(".mono")
				?.textContent?.trim(),
		).toBe("no");
	});

	it("silently refetches and advances to the new latest turn on a context:debug event", async () => {
		const stored = [turn({ turn_id: "t1", created_at: "2026-11-19T08:00:00.000Z" })];
		serveTurns(stored);
		const { target, wsEvents } = await mountPanel();
		expect(target.querySelector(".turn-label-main")?.textContent?.replace(/\s+/g, " ").trim()).toBe(
			"1 / 1",
		);
		// A new turn arrives on the wire and in the (re-fetched) REST payload.
		stored.push(turn({ turn_id: "t2", created_at: "2026-11-19T08:05:00.000Z" }));
		wsEvents.set([
			{ type: "context:debug", data: { turn_id: "t2", thread_id: "thread-a" } },
		] as WebSocketMessage[]);
		await dom.settle();
		// We were on the latest turn, so the panel advances to the new latest.
		expect(target.querySelector(".turn-label-main")?.textContent?.replace(/\s+/g, " ").trim()).toBe(
			"2 / 2",
		);
		// No loading spinner during a live refresh.
		expect(target.querySelector(".loading")).toBeNull();
	});

	it("ignores context:debug events for other threads", async () => {
		const stored = [turn({ turn_id: "t1" })];
		serveTurns(stored);
		const { target, wsEvents } = await mountPanel();
		const before = dom.requests.filter((r) => r.path.includes("context-debug")).length;
		wsEvents.set([
			{ type: "context:debug", data: { turn_id: "t2", thread_id: "other-thread" } },
		] as WebSocketMessage[]);
		await dom.settle();
		// No refetch fired for a foreign thread.
		const after = dom.requests.filter((r) => r.path.includes("context-debug")).length;
		expect(after).toBe(before);
		expect(target.querySelector(".turn-label-main")?.textContent?.replace(/\s+/g, " ").trim()).toBe(
			"1 / 1",
		);
	});

	it("preserves an older selection when a live event appends a turn", async () => {
		const stored = [
			turn({ turn_id: "t1", created_at: "2026-11-19T08:00:00.000Z" }),
			turn({ turn_id: "t2", created_at: "2026-11-19T08:05:00.000Z" }),
		];
		serveTurns(stored);
		const { target, wsEvents } = await mountPanel();
		// Navigate back to the first turn.
		await dom.fire(target.querySelector(".turn-nav button") as HTMLButtonElement, "click");
		expect(target.querySelector(".turn-label-main")?.textContent?.replace(/\s+/g, " ").trim()).toBe(
			"1 / 2",
		);
		// A third turn appears live; because we were NOT on latest, the selection stays put.
		stored.push(turn({ turn_id: "t3", created_at: "2026-11-19T08:10:00.000Z" }));
		wsEvents.set([
			{ type: "context:debug", data: { turn_id: "t3", thread_id: "thread-a" } },
		] as WebSocketMessage[]);
		await dom.settle();
		expect(target.querySelector(".turn-label-main")?.textContent?.replace(/\s+/g, " ").trim()).toBe(
			"1 / 3",
		);
		expect(target.querySelector(".latest-badge")).toBeNull();
	});
});

// --- helpers --------------------------------------------------------------

import { spyOn } from "bun:test";

/** Spy on the router's navigateTo (namespace spy — never mock.module). */
function spyOnNavigate(onCall: (route: string) => void) {
	return spyOn(router, "navigateTo").mockImplementation((route: string) => onCall(route));
}
