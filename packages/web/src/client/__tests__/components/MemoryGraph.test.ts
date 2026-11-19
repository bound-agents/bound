import { afterEach, describe, expect, it } from "bun:test";
import { installDom } from "../harness/dom";

type Tier = "pinned" | "summary" | "default" | "detail";

type Node = {
	key: string;
	value: string;
	tier: Tier;
	source: string | null;
	sourceThreadTitle: string | null;
	lineIndex: number | null;
	modifiedAt: string;
};

type Edge = { sourceKey: string; targetKey: string; relation: string };

const node = (over: Partial<Node> = {}): Node => ({
	key: "example:key",
	value: "example value",
	tier: "default",
	source: null,
	sourceThreadTitle: null,
	lineIndex: null,
	modifiedAt: "2026-11-18T00:00:00.000Z",
	...over,
});

// Per-test jsdom lifecycle (MemoryGraph has no live timers, so there is no
// cross-test interval to leak). Each test installs a fresh dom and tears it
// down after, matching the McpServersView pattern.
let dom: ReturnType<typeof installDom> | null = null;

afterEach(() => {
	dom?.teardown();
	dom = null;
});

async function mount(
	graph: { nodes: Node[]; edges: Edge[] } | null,
	props: Record<string, unknown> = {},
	options: { status?: number } = {},
) {
	dom = installDom();
	dom.route("GET", "/api/memory/graph", () =>
		graph === null ? new Response("boom", { status: options.status ?? 500 }) : graph,
	);
	const MemoryGraph = (await import("../../components/MemoryGraph.svelte")).default;
	const mounted = await dom.mount(MemoryGraph, props);
	await dom.settle();
	return mounted;
}

describe("MemoryGraph", () => {
	it("loads the graph and renders a node per memory", async () => {
		const { target } = await mount({
			nodes: [
				node({ key: "a:one", tier: "pinned" }),
				node({ key: "b:two", tier: "summary" }),
				node({ key: "c:three", tier: "detail" }),
			],
			edges: [],
		});
		expect(dom.requests.some((r) => r.method === "GET" && r.path === "/api/memory/graph")).toBe(
			true,
		);
		// One <circle>-bearing <g role="button"> per node (plus decoration circles).
		const nodeGroups = target.querySelectorAll('g[role="button"]');
		expect(nodeGroups.length).toBe(3);
		// Stats strip reflects node/edge counts.
		expect(target.textContent).toContain("Nodes");
		const statNumbers = [...target.querySelectorAll(".stat-bit .mono")].map((s) =>
			s.textContent?.trim(),
		);
		expect(statNumbers).toContain("3");
	});

	it("shows the loading splash, then resolves", async () => {
		let release: ((v: unknown) => void) | null = null;
		dom = installDom();
		dom.route(
			"GET",
			"/api/memory/graph",
			() =>
				new Promise((resolve) => {
					release = resolve;
				}),
		);
		const MemoryGraph = (await import("../../components/MemoryGraph.svelte")).default;
		const mounted = await dom.mount(MemoryGraph, {});
		expect(mounted.target.textContent).toContain("Loading memory graph…");
		release?.({ nodes: [node({ key: "x:1" })], edges: [] });
		await dom.settle();
		expect(mounted.target.textContent).not.toContain("Loading memory graph…");
	});

	it("renders the empty state when there are no memories", async () => {
		const { target } = await mount({ nodes: [], edges: [] });
		expect(target.textContent).toContain("No memories yet");
	});

	it("shows an error and retries on button click", async () => {
		let attempt = 0;
		dom = installDom();
		dom.route("GET", "/api/memory/graph", () => {
			attempt++;
			if (attempt === 1) return new Response("down", { status: 503 });
			return { nodes: [node({ key: "recovered:1" })], edges: [] };
		});
		const MemoryGraph = (await import("../../components/MemoryGraph.svelte")).default;
		const mounted = await dom.mount(MemoryGraph, {});
		await dom.settle();
		expect(mounted.target.textContent).toContain("HTTP 503");
		const retry = mounted.target.querySelector(".center-state button") as HTMLElement;
		expect(retry?.textContent).toContain("Retry");
		await dom.fire(retry, "click");
		expect(mounted.target.querySelectorAll('g[role="button"]').length).toBe(1);
		expect(attempt).toBe(2);
	});

	it("opens a detail panel with the memory's key and value on node click", async () => {
		const { target } = await mount({
			nodes: [node({ key: "inspect:me", value: "the body text", tier: "pinned" })],
			edges: [],
		});
		expect(target.querySelector(".detail-panel")).toBeNull();
		const nodeGroup = target.querySelector('g[role="button"]') as SVGElement;
		await dom.fire(nodeGroup, "click");
		const panel = target.querySelector(".detail-panel");
		expect(panel).not.toBeNull();
		expect(panel?.textContent).toContain("inspect:me");
		expect(panel?.textContent).toContain("PINNED TIER");
		// Value renders (markdown effect may replace it, but plain text is the fallback).
		expect(panel?.textContent).toContain("the body text");
	});

	it("closes the detail panel via the close button", async () => {
		const { target } = await mount({
			nodes: [node({ key: "closeme:1" })],
			edges: [],
		});
		const nodeGroup = target.querySelector('g[role="button"]') as SVGElement;
		await dom.fire(nodeGroup, "click");
		expect(target.querySelector(".detail-panel")).not.toBeNull();
		const close = target.querySelector(".detail-close") as HTMLElement;
		await dom.fire(close, "click");
		expect(target.querySelector(".detail-panel")).toBeNull();
	});

	it("filters nodes by tier via the tier pills and shows counts", async () => {
		const { target } = await mount({
			nodes: [
				node({ key: "p:1", tier: "pinned" }),
				node({ key: "p:2", tier: "pinned" }),
				node({ key: "d:1", tier: "detail" }),
			],
			edges: [],
		});
		const pills = [...target.querySelectorAll("button.tier-pill")];
		const pinnedPill = pills.find((p) => p.textContent?.includes("PINNED"));
		expect(pinnedPill?.textContent).toMatch(/PINNED\s*2/);
		// Footnote shows "Showing N of M" — all visible initially.
		expect(target.textContent).toContain("Showing 3 of 3 nodes");
		await dom.fire(pinnedPill as Element, "click");
		// Now only the 2 pinned nodes count as shown.
		expect(target.textContent).toContain("Showing 2 of 3 nodes");
	});

	it("navigates to the source thread from the detail panel", async () => {
		let navigatedTo: string | null = null;
		const { target } = await mount(
			{
				nodes: [
					node({
						key: "sourced:1",
						source: "thread-abc",
						sourceThreadTitle: "Origin Thread",
						lineIndex: 4,
					}),
				],
				edges: [],
			},
			{
				onNavigate: (route: string) => {
					navigatedTo = route;
				},
			},
		);
		const nodeGroup = target.querySelector('g[role="button"]') as SVGElement;
		await dom.fire(nodeGroup, "click");
		const sourceBtn = target.querySelector(".source-btn") as HTMLElement;
		expect(sourceBtn?.textContent).toContain("Origin Thread");
		expect(sourceBtn?.textContent).toContain("line 4");
		await dom.fire(sourceBtn, "click");
		expect(navigatedTo).toBe("/line/thread-abc");
	});

	it("lists linked neighbors in the detail panel and jumps between them", async () => {
		const { target } = await mount({
			nodes: [node({ key: "root:node" }), node({ key: "linked:a", tier: "summary" })],
			edges: [{ sourceKey: "root:node", targetKey: "linked:a", relation: "relates_to" }],
		});
		// Node placement sorts by tier, so DOM order is not input order. Click any
		// node, then assert the selected key and its single neighbor are the two
		// endpoints of the one edge.
		const groups = [...target.querySelectorAll('g[role="button"]')];
		await dom.fire(groups[0], "click");
		const selectedKey = target.querySelector(".detail-key")?.textContent?.trim();
		expect(["root:node", "linked:a"]).toContain(selectedKey);
		const neighborBtns = [...target.querySelectorAll("button.neighbor")];
		expect(neighborBtns.length).toBe(1);
		const neighborKey = neighborBtns[0].querySelector(".neighbor-key")?.textContent?.trim();
		const otherKey = selectedKey === "root:node" ? "linked:a" : "root:node";
		expect(neighborKey).toBe(otherKey);
		expect(neighborBtns[0].textContent).toContain("relates_to");
		// Jump to the neighbor; its key now heads the panel.
		await dom.fire(neighborBtns[0], "click");
		expect(target.querySelector(".detail-key")?.textContent?.trim()).toBe(otherKey);
	});

	it("zooms in and out with the zoom controls and resets the view", async () => {
		const { target } = await mount({
			nodes: [node({ key: "z:1" }), node({ key: "z:2" })],
			edges: [],
		});
		const zoomStat = () =>
			[...target.querySelectorAll(".stat-bit")]
				.find((b) => b.textContent?.includes("Zoom"))
				?.querySelector(".mono")
				?.textContent?.trim();
		expect(zoomStat()).toBe("1.0×");
		const [zoomIn, zoomOut, reset] = [...target.querySelectorAll(".zoom-btn")] as HTMLElement[];
		await dom.fire(zoomIn, "click");
		expect(zoomStat()).not.toBe("1.0×");
		await dom.fire(zoomOut, "click");
		await dom.fire(reset, "click");
		expect(zoomStat()).toBe("1.0×");
	});

	it("shows the hovered-thread callout when a selected thread is provided", async () => {
		const { target } = await mount(
			{
				nodes: [
					node({ key: "t:1", source: "thread-sel" }),
					node({ key: "t:2", source: "thread-other" }),
				],
				edges: [],
			},
			{
				selectedThreadId: "thread-sel",
				hoveredThreadTitle: "Selected Thread",
				hoveredThreadColor: 2,
			},
		);
		const callout = target.querySelector(".hover-callout");
		expect(callout).not.toBeNull();
		expect(callout?.textContent).toContain("Selected Thread");
		// One of the two nodes belongs to the selected thread.
		expect(callout?.textContent).toContain("1");
	});

	it("toggles a node selection off when clicked twice", async () => {
		const { target } = await mount({
			nodes: [node({ key: "toggle:1" })],
			edges: [],
		});
		const group = target.querySelector('g[role="button"]') as SVGElement;
		await dom.fire(group, "click");
		expect(target.querySelector(".detail-panel")).not.toBeNull();
		await dom.fire(group, "click");
		expect(target.querySelector(".detail-panel")).toBeNull();
	});
});
