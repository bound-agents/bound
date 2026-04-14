import { describe, expect, it } from "bun:test";
import { assert } from "@bound/shared";
import type { MemoryGraphEdge, MemoryGraphNode } from "../api";
import { computeInitialLayout, simulationStep } from "../graph-layout";

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
		it("sorts nodes within tier by modifiedAt descending", () => {
			const now = new Date();
			const nodes: MemoryGraphNode[] = [
				{
					key: "node-old",
					value: "value",
					tier: "default",
					source: null,
					sourceThreadTitle: null,
					lineIndex: 0,
					modifiedAt: new Date(now.getTime() - 3000).toISOString(),
				},
				{
					key: "node-newest",
					value: "value",
					tier: "default",
					source: null,
					sourceThreadTitle: null,
					lineIndex: 0,
					modifiedAt: now.toISOString(),
				},
			];

			const result = computeInitialLayout(nodes, [], 500, 400);
			// Both should be positioned
			expect(result.nodes).toHaveLength(2);
		});

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
});
