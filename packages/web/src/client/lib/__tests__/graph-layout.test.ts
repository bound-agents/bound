import { describe, expect, it } from "bun:test";
import { assert } from "@bound/shared";
import type { MemoryGraphEdge, MemoryGraphNode } from "../api";
import { computeInitialLayout, simulationStep, updateOpacity } from "../graph-layout";

describe("computeInitialLayout", () => {
	describe("empty input", () => {
		it("returns empty arrays when input nodes are empty", () => {
			const result = computeInitialLayout([], [], 500, 400);
			expect(result.nodes).toEqual([]);
			expect(result.edges).toEqual([]);
		});
	});

	describe("node tier positioning", () => {
		it("positions pinned nodes higher (smaller Y) than default nodes", () => {
			const nodes: MemoryGraphNode[] = [
				{
					key: "pinned-1",
					value: "value",
					tier: "pinned",
					source: null,
					sourceThreadTitle: null,
					lineIndex: 0,
					modifiedAt: new Date().toISOString(),
				},
				{
					key: "default-1",
					value: "value",
					tier: "default",
					source: null,
					sourceThreadTitle: null,
					lineIndex: 0,
					modifiedAt: new Date().toISOString(),
				},
			];

			const result = computeInitialLayout(nodes, [], 500, 400);
			const pinned = result.nodes.find((n) => n.key === "pinned-1");
			const def = result.nodes.find((n) => n.key === "default-1");

			// Pinned should be higher (smaller Y) than default in arc layout
			assert(pinned);
			assert(def);
			expect(pinned.y).toBeLessThan(def.y);
		});
	});

	describe("node sorting and limiting", () => {
		it("limits each tier to 40 nodes max", () => {
			const nodes: MemoryGraphNode[] = [];
			for (let i = 0; i < 50; i++) {
				nodes.push({
					key: `node-${i}`,
					value: "value",
					tier: "default",
					source: null,
					sourceThreadTitle: null,
					lineIndex: 0,
					modifiedAt: new Date(Date.now() - i * 1000).toISOString(),
				});
			}

			const result = computeInitialLayout(nodes, [], 500, 400);
			const defaultNodes = result.nodes.filter((n) => n.tier === "default");
			expect(defaultNodes).toHaveLength(40);
		});
	});

	describe("node radius by tier", () => {
		it("assigns correct radius based on tier", () => {
			const nodes: MemoryGraphNode[] = [
				{
					key: "pinned",
					value: "value",
					tier: "pinned",
					source: null,
					sourceThreadTitle: null,
					lineIndex: 0,
					modifiedAt: new Date().toISOString(),
				},
				{
					key: "summary",
					value: "value",
					tier: "summary",
					source: null,
					sourceThreadTitle: null,
					lineIndex: 0,
					modifiedAt: new Date().toISOString(),
				},
				{
					key: "default",
					value: "value",
					tier: "default",
					source: null,
					sourceThreadTitle: null,
					lineIndex: 0,
					modifiedAt: new Date().toISOString(),
				},
				{
					key: "detail",
					value: "value",
					tier: "detail",
					source: null,
					sourceThreadTitle: null,
					lineIndex: 0,
					modifiedAt: new Date().toISOString(),
				},
			];

			const result = computeInitialLayout(nodes, [], 500, 400, "thread-1");

			expect(result.nodes.find((n) => n.key === "pinned")?.radius).toBe(14);
			expect(result.nodes.find((n) => n.key === "summary")?.radius).toBe(9);
			expect(result.nodes.find((n) => n.key === "default")?.radius).toBe(7);
			expect(result.nodes.find((n) => n.key === "detail")?.radius).toBe(5);
		});
	});

	describe("detail node visibility", () => {
		it("includes detail nodes always", () => {
			const nodes: MemoryGraphNode[] = [
				{
					key: "detail-1",
					value: "value",
					tier: "detail",
					source: null,
					sourceThreadTitle: null,
					lineIndex: 0,
					modifiedAt: new Date().toISOString(),
				},
			];

			const result = computeInitialLayout(nodes, [], 500, 400);
			const detailNodes = result.nodes.filter((n) => n.tier === "detail");
			expect(detailNodes).toHaveLength(1);
		});
	});

	describe("opacity with selectedThreadId", () => {
		it("sets opacity to 1.0 for all nodes when selectedThreadId is not set", () => {
			const nodes: MemoryGraphNode[] = [
				{
					key: "node-1",
					value: "value",
					tier: "default",
					source: null,
					sourceThreadTitle: null,
					lineIndex: 0,
					modifiedAt: new Date().toISOString(),
				},
			];

			const result = computeInitialLayout(nodes, [], 500, 400);
			for (const node of result.nodes) {
				expect(node.opacity).toBe(1.0);
			}
		});

		it("sets opacity to 1.0 for matching nodes, 0.15 for others", () => {
			const selectedThreadUuid = "thread-uuid-123";
			const nodes: MemoryGraphNode[] = [
				{
					key: "node-1",
					value: "value",
					tier: "default",
					source: selectedThreadUuid,
					sourceThreadTitle: null,
					lineIndex: 2,
					modifiedAt: new Date().toISOString(),
				},
				{
					key: "node-2",
					value: "value",
					tier: "default",
					source: "other-thread-uuid",
					sourceThreadTitle: null,
					lineIndex: 3,
					modifiedAt: new Date().toISOString(),
				},
			];

			const result = computeInitialLayout(nodes, [], 500, 400, selectedThreadUuid);
			const node1 = result.nodes.find((n) => n.key === "node-1");
			const node2 = result.nodes.find((n) => n.key === "node-2");

			expect(node1?.opacity).toBe(1.0);
			expect(node2?.opacity).toBe(0.15);
		});
	});

	describe("edge rendering", () => {
		it("renders edges only for nodes that are positioned", () => {
			const nodes: MemoryGraphNode[] = [
				{
					key: "node-1",
					value: "value",
					tier: "default",
					source: null,
					sourceThreadTitle: null,
					lineIndex: 0,
					modifiedAt: new Date().toISOString(),
				},
				{
					key: "node-2",
					value: "value",
					tier: "default",
					source: null,
					sourceThreadTitle: null,
					lineIndex: 0,
					modifiedAt: new Date().toISOString(),
				},
			];

			const edges: MemoryGraphEdge[] = [
				{
					sourceKey: "node-1",
					targetKey: "node-2",
					relation: "connects",
					modifiedAt: new Date().toISOString(),
				},
			];

			const result = computeInitialLayout(nodes, edges, 500, 400);
			expect(result.edges).toHaveLength(1);
		});

		it("skips edges with missing nodes", () => {
			const nodes: MemoryGraphNode[] = [
				{
					key: "node-1",
					value: "value",
					tier: "default",
					source: null,
					sourceThreadTitle: null,
					lineIndex: 0,
					modifiedAt: new Date().toISOString(),
				},
			];

			const edges: MemoryGraphEdge[] = [
				{
					sourceKey: "node-1",
					targetKey: "missing-node",
					relation: "connects",
					modifiedAt: new Date().toISOString(),
				},
			];

			const result = computeInitialLayout(nodes, edges, 500, 400);
			expect(result.edges).toHaveLength(0);
		});

		it("marks summarizes relation edges as dashed", () => {
			const nodes: MemoryGraphNode[] = [
				{
					key: "node-1",
					value: "value",
					tier: "summary",
					source: null,
					sourceThreadTitle: null,
					lineIndex: 0,
					modifiedAt: new Date().toISOString(),
				},
				{
					key: "node-2",
					value: "value",
					tier: "detail",
					source: null,
					sourceThreadTitle: null,
					lineIndex: 0,
					modifiedAt: new Date().toISOString(),
				},
			];

			const edges: MemoryGraphEdge[] = [
				{
					sourceKey: "node-1",
					targetKey: "node-2",
					relation: "summarizes",
					modifiedAt: new Date().toISOString(),
				},
			];

			const result = computeInitialLayout(nodes, edges, 500, 400, "thread-1");
			const edge = result.edges[0];
			expect(edge?.dashed).toBe(true);
		});
	});

	describe("node color assignment", () => {
		it("assigns color based on tier", () => {
			const nodes: MemoryGraphNode[] = [
				{
					key: "pinned-1",
					value: "value",
					tier: "pinned",
					source: null,
					sourceThreadTitle: null,
					lineIndex: 0,
					modifiedAt: new Date().toISOString(),
				},
				{
					key: "summary-1",
					value: "value",
					tier: "summary",
					source: null,
					sourceThreadTitle: null,
					lineIndex: 0,
					modifiedAt: new Date().toISOString(),
				},
				{
					key: "default-1",
					value: "value",
					tier: "default",
					source: null,
					sourceThreadTitle: null,
					lineIndex: null,
					modifiedAt: new Date().toISOString(),
				},
			];

			const result = computeInitialLayout(nodes, [], 500, 400);
			expect(result.nodes.find((n) => n.key === "pinned-1")?.color).toBe("#F39700");
			expect(result.nodes.find((n) => n.key === "summary-1")?.color).toBe("#009BBF");
			expect(result.nodes.find((n) => n.key === "default-1")?.color).toBe("#9CAEB7");
		});
	});
});

describe("simulationStep", () => {
	it("moves nodes and returns energy", () => {
		const nodes: MemoryGraphNode[] = [
			{
				key: "node-1",
				value: "value",
				tier: "default",
				source: null,
				sourceThreadTitle: null,
				lineIndex: 0,
				modifiedAt: new Date().toISOString(),
			},
			{
				key: "node-2",
				value: "value",
				tier: "default",
				source: null,
				sourceThreadTitle: null,
				lineIndex: 0,
				modifiedAt: new Date().toISOString(),
			},
		];

		// Place nodes close together so repulsion kicks in
		const layout = computeInitialLayout(nodes, [], 100, 100);
		const initialX1 = layout.nodes[0].x;
		const initialY1 = layout.nodes[0].y;

		const energy = simulationStep(layout.nodes, layout.edges, layout.nodeMap, 100, 100, 1.0);

		// Nodes should have moved (repulsion in small canvas)
		const moved = layout.nodes[0].x !== initialX1 || layout.nodes[0].y !== initialY1;
		expect(moved).toBe(true);
		expect(energy).toBeGreaterThan(0);
	});

	it("converges to low energy over many steps", () => {
		const nodes: MemoryGraphNode[] = [];
		for (let i = 0; i < 5; i++) {
			nodes.push({
				key: `node-${i}`,
				value: "value",
				tier: "default",
				source: null,
				sourceThreadTitle: null,
				lineIndex: 0,
				modifiedAt: new Date(Date.now() - i * 1000).toISOString(),
			});
		}

		const layout = computeInitialLayout(nodes, [], 500, 400);
		let energy = 0;
		for (let step = 0; step < 100; step++) {
			const alpha = 1 - step / 100;
			energy = simulationStep(layout.nodes, layout.edges, layout.nodeMap, 500, 400, alpha);
		}

		expect(energy).toBeLessThan(10);
	});

	it("applies edge attraction between separated non-pinned nodes", () => {
		// Two default nodes joined by an edge, placed far apart so the
		// edge-attraction branch (dist > 60) fires and pulls them together.
		const nodes: MemoryGraphNode[] = [
			{
				key: "a",
				value: "v",
				tier: "default",
				source: null,
				sourceThreadTitle: null,
				lineIndex: 0,
				modifiedAt: new Date().toISOString(),
			},
			{
				key: "b",
				value: "v",
				tier: "default",
				source: null,
				sourceThreadTitle: null,
				lineIndex: 0,
				modifiedAt: new Date().toISOString(),
			},
		];
		const edges: MemoryGraphEdge[] = [
			{
				sourceKey: "a",
				targetKey: "b",
				relation: "related_to",
				modifiedAt: new Date().toISOString(),
			},
		];
		const layout = computeInitialLayout(nodes, edges, 1000, 800);
		const a = layout.nodeMap.get("a");
		const b = layout.nodeMap.get("b");
		assert(a !== undefined && b !== undefined);
		// Force them far apart to guarantee dist > 60.
		a.x = 50;
		a.y = 400;
		b.x = 950;
		b.y = 400;
		a.vx = 0;
		a.vy = 0;
		b.vx = 0;
		b.vy = 0;
		simulationStep(layout.nodes, layout.edges, layout.nodeMap, 1000, 800, 1.0);
		// Attraction gives a a positive x-velocity (pulled right toward b) and b a
		// negative one (pulled left toward a); repulsion at that distance is tiny.
		expect(a.vx).toBeGreaterThan(0);
		expect(b.vx).toBeLessThan(0);
	});

	it("skips edge attraction when either endpoint is pinned", () => {
		const nodes: MemoryGraphNode[] = [
			{
				key: "pin",
				value: "v",
				tier: "pinned",
				source: null,
				sourceThreadTitle: null,
				lineIndex: 0,
				modifiedAt: new Date().toISOString(),
			},
			{
				key: "def",
				value: "v",
				tier: "default",
				source: null,
				sourceThreadTitle: null,
				lineIndex: 0,
				modifiedAt: new Date().toISOString(),
			},
		];
		const edges: MemoryGraphEdge[] = [
			{
				sourceKey: "pin",
				targetKey: "def",
				relation: "related_to",
				modifiedAt: new Date().toISOString(),
			},
		];
		const layout = computeInitialLayout(nodes, edges, 1000, 800);
		const def = layout.nodeMap.get("def");
		assert(def !== undefined);
		def.x = 950;
		def.y = 400;
		def.vx = 0;
		def.vy = 0;
		const pin = layout.nodeMap.get("pin");
		assert(pin !== undefined);
		pin.x = 50;
		pin.y = 400;
		simulationStep(layout.nodes, layout.edges, layout.nodeMap, 1000, 800, 1.0);
		const withPinnedEdge = def.vx;
		// Re-run the identical geometry but with NO edges: if edge attraction were
		// NOT skipped for the pinned endpoint, def would be pulled left (toward the
		// pin) and withPinnedEdge.vx would be more negative than the no-edge
		// baseline. Because attraction IS skipped, the two match exactly.
		const noEdge = (() => {
			const l = computeInitialLayout(nodes, [], 1000, 800);
			const d = l.nodeMap.get("def");
			const p = l.nodeMap.get("pin");
			assert(d !== undefined && p !== undefined);
			d.x = 950;
			d.y = 400;
			d.vx = 0;
			d.vy = 0;
			p.x = 50;
			p.y = 400;
			simulationStep(l.nodes, l.edges, l.nodeMap, 1000, 800, 1.0);
			return d.vx;
		})();
		expect(withPinnedEdge).toBeCloseTo(noEdge, 10);
	});
});

describe("updateOpacity", () => {
	function node(
		key: string,
		source: string | null,
	): MemoryGraphNode & {
		x: number;
		y: number;
		vx: number;
		vy: number;
		radius: number;
		opacity: number;
		color: string;
	} {
		return {
			key,
			value: "v",
			tier: "default",
			source,
			sourceThreadTitle: null,
			lineIndex: 0,
			modifiedAt: new Date().toISOString(),
			x: 0,
			y: 0,
			vx: 0,
			vy: 0,
			radius: 5,
			opacity: 0,
			color: "#fff",
		};
	}

	it("sets every node fully opaque when nothing is hovered", () => {
		const nodes = [node("a", "t1"), node("b", null)];
		const edges = [{ sourceKey: "a", targetKey: "b", relation: "related_to", opacity: 0 }];
		const map = new Map(nodes.map((n) => [n.key, n]));
		updateOpacity(nodes as never, edges as never, map as never, null);
		expect(nodes[0].opacity).toBe(1.0);
		expect(nodes[1].opacity).toBe(1.0);
		expect(edges[0].opacity).toBe(1.0);
	});

	it("dims sourceless nodes and non-matching nodes when a thread is hovered", () => {
		const match = node("a", "t1");
		const other = node("b", "t2");
		const sourceless = node("c", null);
		const nodes = [match, other, sourceless];
		const edges = [
			{ sourceKey: "a", targetKey: "b", relation: "related_to", opacity: 0 },
			{ sourceKey: "a", targetKey: "missing", relation: "related_to", opacity: 0 },
		];
		const map = new Map(nodes.map((n) => [n.key, n]));
		updateOpacity(nodes as never, edges as never, map as never, "t1");
		expect(match.opacity).toBe(1.0);
		expect(other.opacity).toBe(0.15);
		expect(sourceless.opacity).toBe(0.4);
		// Edge opacity is the min of its endpoints; the second edge references a
		// missing node and is left untouched.
		expect(edges[0].opacity).toBe(0.15);
		expect(edges[1].opacity).toBe(0);
	});
});
